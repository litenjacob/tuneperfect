use super::{
    device::DeviceManager,
    input::InputStreamManager,
    output::{OutputMixer, MAX_PLAYBACK_GAIN},
    types::MicrophoneOptions,
    worker::AnalysisWorker,
};
use crate::{
    error::AppError,
    state::{state, ProcessorMap},
};
use cpal::Stream;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc,
    },
    thread,
};

/// Manages audio recording and playback
pub struct Recorder {
    stop_tx: mpsc::Sender<()>,
    thread_handle: Option<thread::JoinHandle<()>>,
    playback_gain: Arc<AtomicU32>,
    microphone_levels: Arc<[AtomicU32]>,
}

impl Recorder {
    /// Create a new recorder and start the recording loop
    pub fn new(
        processors: ProcessorMap,
        options: Vec<MicrophoneOptions>,
        playback_enabled: bool,
        playback_volume: f32,
        levels: &[f32],
    ) -> Result<(Self, bool), AppError> {
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let playback_gain = Arc::new(AtomicU32::new(
            Self::gain(playback_enabled, playback_volume).to_bits(),
        ));
        let gain_for_output = playback_gain.clone();
        let microphone_levels: Arc<[_]> = (0..options.len())
            .map(|index| AtomicU32::new(Self::slot_gain(levels, index).to_bits()))
            .collect();
        let levels_for_output = microphone_levels.clone();

        let thread_handle = thread::spawn(move || {
            match Self::setup_streams(&processors, &options, gain_for_output, levels_for_output) {
                Ok((_inputs, output)) => {
                    let _analysis = AnalysisWorker::start(processors, &state().pitch_sinks);
                    let _ = ready_tx.send(Ok(output.is_some()));
                    let _ = stop_rx.recv();
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
            }
        });
        let recorder = Self {
            stop_tx,
            thread_handle: Some(thread_handle),
            playback_gain,
            microphone_levels,
        };
        let playback_available = ready_rx.recv().map_err(|_| {
            AppError::RecorderError("Recording thread stopped during setup".to_string())
        })??;
        Ok((recorder, playback_available))
    }

    pub fn set_playback(&self, enabled: bool, volume: f32, levels: Option<&[f32]>) {
        if let Some(levels) = levels {
            for (index, slot) in self.microphone_levels.iter().enumerate() {
                let gain = Self::slot_gain(levels, index);
                slot.store(gain.to_bits(), Ordering::Relaxed);
            }
        }
        self.playback_gain
            .store(Self::gain(enabled, volume).to_bits(), Ordering::Relaxed);
    }

    fn slot_gain(levels: &[f32], index: usize) -> f32 {
        let level = levels.get(index).copied().unwrap_or(1.0);
        if level.is_finite() {
            level.clamp(0.0, MAX_PLAYBACK_GAIN)
        } else {
            1.0
        }
    }

    fn gain(enabled: bool, volume: f32) -> f32 {
        if enabled && volume.is_finite() {
            volume.clamp(0.0, MAX_PLAYBACK_GAIN)
        } else {
            0.0
        }
    }

    fn setup_streams(
        processors: &ProcessorMap,
        options: &[MicrophoneOptions],
        playback_gain: Arc<AtomicU32>,
        microphone_levels: Arc<[AtomicU32]>,
    ) -> Result<(Vec<Stream>, Option<Stream>), AppError> {
        let device_manager = DeviceManager::new()?;
        let input_devices = device_manager.find_input_devices(options)?;
        let mut rates = vec![0; options.len()];
        for (_, config, mic_indices) in &input_devices {
            for &index in mic_indices {
                rates[index] = config.sample_rate;
            }
        }

        // Warm up the monitoring stream even when muted so it can be enabled mid-song.
        // Scoring still works if the speaker stream can't be opened.
        let mut producers = HashMap::new();
        let mut output = None;
        if let Some(rate) = rates.iter().copied().find(|&rate| rate != 0) {
            let result = (|| {
                let (device, config) = device_manager.get_output_config(Some(rate))?;
                let mut mixer = OutputMixer::new(&rates, config.sample_rate)?;
                let output_producers = (0..options.len())
                    .filter_map(|index| {
                        mixer.take_producer(index).map(|producer| (index, producer))
                    })
                    .collect();
                let stream =
                    mixer.create_output_stream(device, config, playback_gain, microphone_levels)?;
                Ok::<_, AppError>((output_producers, stream))
            })();
            match result {
                Ok((output_producers, stream)) => {
                    producers = output_producers;
                    output = Some(stream);
                }
                Err(error) => log::warn!("Microphone playback unavailable: {error}"),
            }
        }

        let inputs = InputStreamManager::setup_input_streams(
            input_devices,
            options,
            processors.clone(),
            producers,
        )?;
        Ok((inputs, output))
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}
