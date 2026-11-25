use crate::error::AppError;
use ringbuf::traits::{Consumer, Observer};
use ringbuf::HeapCons;
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters, WindowFunction};

/// Small blocks keep conversion latency below a typical device callback.
const RESAMPLER_CHUNK: usize = 128;

/// Single-channel (mono) resampling: every buffer is one channel of interleaved
/// data, which for one channel is just a flat slice.
const CHANNELS: usize = 1;

pub struct AudioResampler {
    resampler: Async<f32>,
    input_per_output: f64,
    output_buffer: Vec<f32>,
    remaining: std::ops::Range<usize>,
}

impl AudioResampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Result<Option<Self>, AppError> {
        if input_rate == 0 || input_rate == output_rate {
            return Ok(None);
        }

        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: Some(0.95),
            window: WindowFunction::BlackmanHarris2,
            oversampling_factor: 256,
            interpolation: rubato::SincInterpolationType::Linear,
        };

        let input_per_output = input_rate as f64 / output_rate as f64;
        let resampler = Async::<f32>::new_sinc(
            input_per_output.recip(),
            2.0,
            &params,
            RESAMPLER_CHUNK,
            CHANNELS,
            FixedAsync::Input,
        )
        .map_err(|e| AppError::CpalError(format!("Failed to create resampler: {}", e)))?;

        let output_capacity = resampler.output_frames_max();

        Ok(Some(Self {
            resampler,
            input_per_output,
            output_buffer: vec![0.0f32; output_capacity],
            remaining: 0..0,
        }))
    }

    /// Produce only as many blocks as the output needs, keeping at most one
    /// converted block between callbacks.
    pub fn resample_into(
        &mut self,
        consumer: &mut HeapCons<f32>,
        mut out: &mut [f32],
        input_frames: usize,
    ) {
        let needed = (out.len() as f64 * self.input_per_output).ceil() as usize;
        // A device may send one large input block for several smaller output
        // callbacks. Keep that block and the partial sinc chunk it may follow.
        let max_backlog = (needed * 2).max(input_frames) + RESAMPLER_CHUNK;
        consumer.skip(consumer.occupied_len().saturating_sub(max_backlog));

        let mut input_block = [0.0; RESAMPLER_CHUNK];
        while !out.is_empty() {
            if self.remaining.is_empty() {
                if consumer.occupied_len() < RESAMPLER_CHUNK {
                    break;
                }
                consumer.pop_slice(&mut input_block);
                let input = InterleavedSlice::new(&input_block, CHANNELS, RESAMPLER_CHUNK)
                    .expect("one complete mono input block");
                let output_frames = self.output_buffer.len();
                let mut output =
                    InterleavedSlice::new_mut(&mut self.output_buffer, CHANNELS, output_frames)
                        .expect("one complete mono output block");
                let Ok((_, written)) =
                    self.resampler
                        .process_into_buffer(&input, &mut output, None)
                else {
                    break;
                };
                self.remaining = 0..written;
            }

            let count = self.remaining.len().min(out.len());
            let end = self.remaining.start + count;
            out[..count].copy_from_slice(&self.output_buffer[self.remaining.start..end]);
            self.remaining.start = end;
            out = &mut out[count..];
        }
        out.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::{
        traits::{Producer, Split},
        HeapRb,
    };

    #[test]
    fn mismatched_rates_keep_audio_continuous_with_small_callbacks() {
        for (input_rate, output_rate) in [(44_100, 48_000), (48_000, 44_100)] {
            let mut resampler = AudioResampler::new(input_rate, output_rate)
                .unwrap()
                .unwrap();
            let (mut producer, mut consumer) = HeapRb::<f32>::new(4096).split();
            let input = [0.25; 512];
            let mut output = [0.0; 256];
            // Allow for the sinc filter delay and for one partly filled input block.
            let mut written = producer.push_slice(&input[..256]);
            for callback in 1..100 {
                let needed =
                    callback * output.len() * input_rate as usize / output_rate as usize + 256;
                written += producer.push_slice(&input[..needed - written]);
                resampler.resample_into(&mut consumer, &mut output, 256);
                if callback > 1 {
                    assert!(output.iter().all(|sample| (*sample - 0.25).abs() < 0.01));
                }
            }
        }
    }
    #[test]
    fn small_output_callbacks_do_not_discard_large_input_blocks() {
        let mut resampler = AudioResampler::new(24_000, 48_000).unwrap().unwrap();
        let (mut producer, mut consumer) = HeapRb::<f32>::new(4096).split();
        let mut output = [0.0; 128];
        // The resampler needs one input chunk of headroom on startup.
        producer.push_slice(&[0.25; RESAMPLER_CHUNK]);
        for callback in 0..48 {
            if callback % 8 == 0 {
                producer.push_slice(&[0.25; 512]);
            }
            resampler.resample_into(&mut consumer, &mut output, 512);
            if callback > 3 {
                assert!(
                    output.iter().all(|sample| (*sample - 0.25).abs() < 0.01),
                    "callback {callback}"
                );
            }
        }
    }
}
