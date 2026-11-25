use crate::error::AppError;
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{Device, Stream, StreamConfig};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use std::sync::{
    atomic::{AtomicU32, AtomicUsize, Ordering},
    Arc,
};

use super::{resampler::AudioResampler, types::DEFAULT_BUFFER_SIZE};

/// Max backlog kept per mic, as a multiple of the callback frame size. Caps
/// latency creep if input drifts faster than output.
const MAX_BACKLOG_FRAMES: usize = 2;
pub const MAX_PLAYBACK_GAIN: f32 = 4.0;

/// Drop the oldest samples once the consumer exceeds the backlog cap.
fn drop_backlog(consumer: &mut HeapCons<f32>, output_frames: usize, input_frames: usize) {
    let max_backlog = (output_frames * MAX_BACKLOG_FRAMES).max(input_frames + output_frames);
    let occupied = consumer.occupied_len();
    if occupied > max_backlog {
        consumer.skip(occupied - max_backlog);
    }
}

/// One-pole DC-blocking high-pass (`y[n] = x[n] - x[n-1] + R*y[n-1]`) to remove
/// mic DC bias before mixing.
struct DcBlocker {
    prev_input: f32,
    prev_output: f32,
}

impl DcBlocker {
    /// ~20–40 Hz corner at 44.1/48 kHz, below the singing range.
    const R: f32 = 0.995;

    fn new() -> Self {
        Self {
            prev_input: 0.0,
            prev_output: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let output = input - self.prev_input + Self::R * self.prev_output;
        self.prev_input = input;
        self.prev_output = output;
        output
    }
}

/// Keep normal levels linear and round off loud peaks before they hit full scale.
fn limit_peak(sample: f32) -> f32 {
    let excess = sample.abs() - 0.75;
    if excess <= 0.0 {
        sample
    } else {
        (1.0 - 0.25 / (1.0 + 4.0 * excess)).copysign(sample)
    }
}

/// Sends one input callback to the monitor and publishes its actual frame size.
pub struct MonitorInput {
    producer: HeapProd<f32>,
    frames: Arc<AtomicUsize>,
}

impl MonitorInput {
    pub fn push(&mut self, samples: &[f32]) {
        self.frames.store(samples.len(), Ordering::Relaxed);
        self.producer.push_slice(samples);
    }
}

/// Manages audio output mixing and playback
pub struct OutputMixer {
    /// Producers are taken (moved) by the input callbacks. Each ring buffer is a
    /// lock-free SPSC channel with exactly one writer (input callback) and one
    /// reader (output callback), so no Mutex is needed.
    mic_producers: Vec<Option<MonitorInput>>,
    mic_consumers: Vec<Option<(HeapCons<f32>, Arc<AtomicUsize>)>>,
    resamplers: Vec<Option<AudioResampler>>,
    dc_blockers: Vec<DcBlocker>,
}

impl OutputMixer {
    pub fn new(input_sample_rates: &[u32], output_sample_rate: u32) -> Result<Self, AppError> {
        let mut mic_producers = Vec::new();
        let mut mic_consumers = Vec::new();

        for &rate in input_sample_rates {
            if rate == 0 {
                mic_producers.push(None);
                mic_consumers.push(None);
                continue;
            }
            let buffer = HeapRb::<f32>::new(DEFAULT_BUFFER_SIZE);
            let (producer, consumer) = buffer.split();
            let frames = Arc::new(AtomicUsize::new(0));
            mic_producers.push(Some(MonitorInput {
                producer,
                frames: frames.clone(),
            }));
            mic_consumers.push(Some((consumer, frames)));
        }

        let resamplers: Vec<Option<AudioResampler>> = input_sample_rates
            .iter()
            .map(|&rate| AudioResampler::new(rate, output_sample_rate))
            .collect::<Result<_, _>>()?;

        let dc_blockers = input_sample_rates
            .iter()
            .map(|_| DcBlocker::new())
            .collect();

        Ok(Self {
            mic_producers,
            mic_consumers,
            resamplers,
            dc_blockers,
        })
    }

    /// Take ownership of the producer for a specific microphone index. The
    /// producer is moved to the (single) input callback that writes to it.
    pub fn take_producer(&mut self, mic_index: usize) -> Option<MonitorInput> {
        self.mic_producers.get_mut(mic_index).and_then(Option::take)
    }

    /// Create and start the output stream. Consumes the mixer because the
    /// consumers and resamplers are moved into the realtime callback.
    pub fn create_output_stream(
        self,
        device: Device,
        config: StreamConfig,
        playback_gain: Arc<AtomicU32>,
        microphone_levels: Arc<[AtomicU32]>,
    ) -> Result<Stream, AppError> {
        let output_channels = config.channels as usize;
        let mut mic_consumers = self.mic_consumers;
        let mut resamplers = self.resamplers;
        let mut dc_blockers = self.dc_blockers;
        let mut gain = 0.0f32;
        let mut slot_gains = vec![0.0; mic_consumers.len()];
        // Ramp the entire gain range in 10 ms to avoid clicks when changing level or muting.
        let gain_step = MAX_PLAYBACK_GAIN / (0.01 * config.sample_rate as f32);

        // Pre-allocated scratch buffers reused across callbacks so the realtime
        // audio thread never allocates on the hot path.
        let mut mixed: Vec<f32> = Vec::with_capacity(DEFAULT_BUFFER_SIZE);
        let mut scratch: Vec<f32> = vec![0.0f32; DEFAULT_BUFFER_SIZE];

        let output_callback = move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            let target = f32::from_bits(playback_gain.load(Ordering::Relaxed));
            for block in data.chunks_mut(DEFAULT_BUFFER_SIZE * output_channels) {
                let frame_size = block.len() / output_channels;
                Self::mix_audio(
                    &mut mic_consumers,
                    &mut resamplers,
                    &mut dc_blockers,
                    frame_size,
                    (&microphone_levels, &mut slot_gains, gain_step),
                    &mut mixed,
                    &mut scratch,
                );

                for (frame, &mono_sample) in block.chunks_exact_mut(output_channels).zip(&mixed) {
                    gain += (target - gain).clamp(-gain_step, gain_step);
                    frame.fill(limit_peak(mono_sample * gain));
                }
            }
        };

        log::info!(
            "Microphone playback output {}: {:?}",
            device.id().map(|id| id.to_string()).unwrap_or_default(),
            config
        );
        let stream = device.build_output_stream(
            config,
            output_callback,
            |err| log::error!("Output stream error: {}", err),
            None,
        )?;

        stream.play()?;
        Ok(stream)
    }

    /// Mix all mic consumers into `mixed` (mono): render each into `scratch`,
    /// DC-block, then sum. `scratch` is reused so the realtime thread never allocates.
    fn mix_audio(
        consumers: &mut [Option<(HeapCons<f32>, Arc<AtomicUsize>)>],
        resamplers: &mut [Option<AudioResampler>],
        dc_blockers: &mut [DcBlocker],
        frame_size: usize,
        (targets, gains, step): (&[AtomicU32], &mut [f32], f32),
        mixed: &mut Vec<f32>,
        scratch: &mut [f32],
    ) {
        mixed.clear();
        mixed.resize(frame_size, 0.0);

        for (index, ((consumer, resampler), blocker)) in consumers
            .iter_mut()
            .zip(resamplers)
            .zip(dc_blockers)
            .enumerate()
        {
            let Some((consumer, frames)) = consumer else {
                continue;
            };
            let input_frames = frames.load(Ordering::Relaxed);
            let buffer = &mut scratch[..frame_size];

            if let Some(resampler) = resampler {
                resampler.resample_into(consumer, buffer, input_frames);
            } else {
                drop_backlog(consumer, frame_size, input_frames);
                let samples_read = consumer.pop_slice(buffer);
                buffer[samples_read..].fill(0.0);
            }

            // A silent or noisy second mic should not change the first singer's gain.
            let target = f32::from_bits(targets[index].load(Ordering::Relaxed));
            let gain = &mut gains[index];
            for (mixed_sample, &mic_sample) in mixed.iter_mut().zip(buffer.iter()) {
                *gain += (target - *gain).clamp(-step, step);
                *mixed_sample += blocker.process(mic_sample) * *gain;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boost_leaves_quiet_voice_linear_and_bounds_loud_peaks() {
        assert_eq!(limit_peak(0.1 * 4.0), 0.4);
        assert_eq!(limit_peak(0.75), 0.75);
        assert!(limit_peak(4.0) > limit_peak(1.0));
        assert!(limit_peak(4.0) < 1.0);
        assert_eq!(limit_peak(-4.0), -limit_peak(4.0));
    }

    #[test]
    fn each_microphone_fader_only_changes_its_own_monitoring_signal() {
        for (levels, expected) in [([1.0f32, 0.0f32], 0.2), ([0.0, 0.5], 0.3)] {
            let mut mixer = OutputMixer::new(&[48_000, 48_000], 48_000).unwrap();
            mixer.take_producer(0).unwrap().push(&[0.2]);
            mixer.take_producer(1).unwrap().push(&[0.6]);
            let targets = levels.map(|gain| AtomicU32::new(gain.to_bits()));
            let mut gains = levels;
            let mut mixed = Vec::new();
            OutputMixer::mix_audio(
                &mut mixer.mic_consumers,
                &mut mixer.resamplers,
                &mut mixer.dc_blockers,
                1,
                (&targets, &mut gains, 1.0),
                &mut mixed,
                &mut [0.0],
            );
            assert_eq!(mixed, [expected]);
        }
    }

    #[test]
    fn missing_mic_preserves_the_connected_mic_slot() {
        let mut mixer = OutputMixer::new(&[0, 44_100], 48_000).unwrap();
        assert!(mixer.take_producer(0).is_none());
        assert!(mixer.take_producer(1).is_some());
        assert!(mixer.resamplers[1].is_some());
    }
}
