//! Resample (rubato) + interleave to Deepgram's wire format
//! (Sub-prompt 2 — Listening, plan §2 + §6).
//!
//! Inputs:
//! - `MicFrame`s at the device-native rate (44.1 or 48 kHz on Macs)
//! - `SystemFrame`s at 48 kHz (we configured ScreenCaptureKit for that)
//!
//! Output:
//! - `AudioFrame`s of 16 kHz int16 stereo (L=user mic, R=speakers system),
//!   250 ms each = 4 000 samples per channel = 8 000 interleaved = 16 000
//!   bytes. Cadence: ~4 frames per second.
//!
//! Drift handling: if one channel's already-resampled 16 kHz buffer
//! gets more than 1 s ahead of the other (e.g., system audio paused
//! mid-call), drop the lead so the muxer doesn't accumulate unbounded
//! memory. We bias the truncation toward keeping the most-recent audio
//! since Sub-prompt 3's moment detector cares about now, not 5 s ago.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use rubato::{FastFixedIn, PolynomialDegree, Resampler};
use tokio::sync::Mutex;
use tokio::sync::mpsc;

use super::mic::MicFrame;
#[cfg(target_os = "macos")]
use super::system_macos::SystemFrame;
use super::{AudioFrame, AudioError, CaptureState};

/// Target output rate (Deepgram's `linear16` codec input).
const OUT_RATE: u32 = 16_000;

/// Target output chunk per resampler call (10 ms = 160 samples at 16 kHz).
/// Smaller chunks → smoother latency; larger → less syscall overhead. 10 ms
/// is rubato's well-trodden mid-ground.
const OUT_CHUNK: usize = 160;

/// Frame size emitted to the WebSocket: 250 ms = 4 000 samples per channel.
const FRAME_SAMPLES_PER_CHANNEL: usize = 4_000;

/// Drift-drop threshold: if one channel has > 1 s more buffered than the
/// other, drop the lead. 1 s = 16 000 samples at 16 kHz.
const DRIFT_DROP_THRESHOLD: usize = 16_000;

/// Audio sample-rate-conversion + interleaving accumulator.
///
/// Holds two rubato resamplers (one per input channel) and two output
/// queues at 16 kHz. Each call to `push_*` resamples whatever input we
/// can chunk and appends to the matching 16 kHz queue. `try_pop_frame`
/// drains 4 000 samples from each side and interleaves L=mic R=system.
pub struct AudioMux {
    mic_resampler: Option<RubatoBuffered>,
    sys_resampler: Option<RubatoBuffered>,
    mic_out: VecDeque<f32>,
    sys_out: VecDeque<f32>,
}

/// Helper that owns a rubato resampler + an input buffer for chunking.
struct RubatoBuffered {
    inner: FastFixedIn<f32>,
    /// Input samples accumulated since the last chunk drain.
    input_buf: Vec<f32>,
    /// Number of input samples per chunk (matches `inner`'s configured
    /// chunk_size).
    chunk_in: usize,
    /// rubato's `output_frames_max()` at construction. We size the
    /// per-call output buffer to exactly this — undersized buffers fail
    /// rubato's input validation with `Insufficient buffer size`.
    out_max: usize,
}

impl RubatoBuffered {
    fn new(input_rate: u32) -> Result<Self, AudioError> {
        let ratio = OUT_RATE as f64 / input_rate as f64;
        // chunk_size_in chosen so the output is roughly OUT_CHUNK samples.
        // Rubato chooses the actual per-call output count based on
        // polynomial-interpolator math; we just need to size the output
        // buffer for its maximum (see out_max below).
        let chunk_in = ((OUT_CHUNK as f64) / ratio).round() as usize;

        let inner = FastFixedIn::new(
            ratio,
            // max_resample_ratio_relative: we don't change the ratio
            // mid-stream, so 1.0 is fine.
            1.0,
            PolynomialDegree::Cubic,
            chunk_in,
            1, // single channel per resampler
        )
        .map_err(|e| AudioError::Transient(format!("FastFixedIn::new: {e}")))?;

        let out_max = inner.output_frames_max();

        Ok(Self {
            inner,
            input_buf: Vec::with_capacity(chunk_in * 4),
            chunk_in,
            out_max,
        })
    }

    /// Push input samples. Drains as many full chunks as the buffer
    /// allows, resampling each into `out`.
    fn push(&mut self, samples: &[f32], out: &mut VecDeque<f32>) {
        self.input_buf.extend_from_slice(samples);
        while self.input_buf.len() >= self.chunk_in {
            let chunk: Vec<f32> = self.input_buf.drain(..self.chunk_in).collect();
            let waves_in = vec![chunk];
            // Rubato strictly requires the output buffer to be ≥
            // output_frames_max() — undersized buffers fail with
            // "Insufficient buffer size" and stall the pipeline silently.
            let mut waves_out = vec![vec![0.0f32; self.out_max]];
            match self.inner.process_into_buffer(&waves_in, &mut waves_out, None) {
                Ok((_in_used, out_produced)) => {
                    out.extend(waves_out[0].iter().take(out_produced));
                }
                Err(e) => {
                    log::warn!("[Copilot/mux] rubato process error: {e}");
                    return;
                }
            }
        }
    }
}

impl AudioMux {
    /// Build a mux for a known mic sample rate. The system rate is
    /// always 48 kHz (we configured ScreenCaptureKit accordingly).
    /// Returns `None` for resamplers if the rate matches OUT_RATE
    /// (16 kHz) — passes samples through directly.
    pub fn new(mic_sample_rate: u32) -> Result<Self, AudioError> {
        let mic_resampler = if mic_sample_rate == OUT_RATE {
            None
        } else {
            Some(RubatoBuffered::new(mic_sample_rate)?)
        };
        // 48 kHz fixed for system audio per system_macos.rs config.
        let sys_resampler = Some(RubatoBuffered::new(48_000)?);

        Ok(Self {
            mic_resampler,
            sys_resampler,
            mic_out: VecDeque::with_capacity(OUT_RATE as usize), // 1 s headroom
            sys_out: VecDeque::with_capacity(OUT_RATE as usize),
        })
    }

    pub fn push_mic_samples(&mut self, samples: &[f32]) {
        match self.mic_resampler.as_mut() {
            Some(r) => r.push(samples, &mut self.mic_out),
            None => self.mic_out.extend(samples.iter().copied()),
        }
        self.apply_drift_policy();
    }

    pub fn push_system_samples(&mut self, samples: &[f32]) {
        if let Some(r) = self.sys_resampler.as_mut() {
            r.push(samples, &mut self.sys_out);
        } else {
            self.sys_out.extend(samples.iter().copied());
        }
        self.apply_drift_policy();
    }

    /// Drop the lead from whichever side has > 1 s more buffered than
    /// the other. Bias toward keeping recent audio (drop from the
    /// front of the queue).
    fn apply_drift_policy(&mut self) {
        let mic_len = self.mic_out.len();
        let sys_len = self.sys_out.len();
        if mic_len > sys_len + DRIFT_DROP_THRESHOLD {
            let drop_n = mic_len - sys_len - DRIFT_DROP_THRESHOLD;
            log::debug!("[Copilot/mux] drift drop: mic ahead by {mic_len}/{sys_len}, dropping {drop_n} mic samples");
            self.mic_out.drain(..drop_n);
        } else if sys_len > mic_len + DRIFT_DROP_THRESHOLD {
            let drop_n = sys_len - mic_len - DRIFT_DROP_THRESHOLD;
            log::debug!("[Copilot/mux] drift drop: sys ahead by {sys_len}/{mic_len}, dropping {drop_n} sys samples");
            self.sys_out.drain(..drop_n);
        }
    }

    /// If both 16 kHz buffers have ≥ 4 000 samples, drain 4 000 from
    /// each, interleave L=mic R=system as i16, return one AudioFrame.
    /// Otherwise None.
    pub fn try_pop_frame(&mut self) -> Option<AudioFrame> {
        if self.mic_out.len() < FRAME_SAMPLES_PER_CHANNEL
            || self.sys_out.len() < FRAME_SAMPLES_PER_CHANNEL
        {
            return None;
        }

        let mut interleaved: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES_PER_CHANNEL * 2);
        for _ in 0..FRAME_SAMPLES_PER_CHANNEL {
            let m = self.mic_out.pop_front().unwrap_or(0.0);
            let s = self.sys_out.pop_front().unwrap_or(0.0);
            interleaved.push(f32_to_i16(m));
            interleaved.push(f32_to_i16(s));
        }

        Some(AudioFrame {
            pcm_s16le_stereo: interleaved,
            captured_at: Instant::now(),
        })
    }
}

/// Clamp f32 in [-1.0, 1.0] then scale to i16. Anything outside the
/// audible range gets pinned to ±i16::MAX rather than wrapping.
fn f32_to_i16(s: f32) -> i16 {
    let clamped = s.clamp(-1.0, 1.0);
    (clamped * i16::MAX as f32) as i16
}

/// Pump task: bridges mic + system mpsc receivers into the mux, then
/// emits AudioFrames on `out`. Runs until `state` flips out of
/// Capturing or one of the input channels closes.
#[cfg(target_os = "macos")]
pub async fn run_pump(
    mut mic_rx: mpsc::Receiver<MicFrame>,
    mut sys_rx: mpsc::Receiver<SystemFrame>,
    out: mpsc::Sender<AudioFrame>,
    state: Arc<Mutex<CaptureState>>,
) {
    // We discover the mic sample rate from the first frame. cpal default
    // input config doesn't propagate cleanly through to here, and the
    // first MicFrame carries it. Until we have it, we sit on samples in
    // a holding buffer.
    let mut mux: Option<AudioMux> = None;
    let mut pending_mic: Vec<MicFrame> = Vec::new();
    let mut pending_sys: Vec<SystemFrame> = Vec::new();

    log::info!("[Copilot/mux] pump started, awaiting first mic frame to size resampler");

    loop {
        // Cheap state check at the top of each iteration. Use try_lock
        // so we don't block the pump waiting on a state-mutator.
        if let Ok(s) = state.try_lock() {
            if *s != CaptureState::Capturing {
                log::info!("[Copilot/mux] pump exiting — state {:?}", *s);
                return;
            }
        }

        tokio::select! {
            // Drain incoming mic frames, sized once we know the rate.
            mic = mic_rx.recv() => {
                let frame = match mic {
                    Some(f) => f,
                    None => {
                        log::warn!("[Copilot/mux] mic channel closed");
                        return;
                    }
                };
                if mux.is_none() {
                    match AudioMux::new(frame.sample_rate) {
                        Ok(m) => {
                            log::info!(
                                "[Copilot/mux] mux ready, mic rate = {} Hz",
                                frame.sample_rate
                            );
                            mux = Some(m);
                            // Replay any system frames that arrived early.
                            for f in pending_sys.drain(..) {
                                if let Some(m) = mux.as_mut() {
                                    m.push_system_samples(&f.samples);
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("[Copilot/mux] mux build failed: {e}");
                            return;
                        }
                    }
                }
                if let Some(m) = mux.as_mut() {
                    m.push_mic_samples(&frame.samples);
                } else {
                    pending_mic.push(frame);
                }
            }

            sys = sys_rx.recv() => {
                let frame = match sys {
                    Some(f) => f,
                    None => {
                        log::warn!("[Copilot/mux] system channel closed");
                        return;
                    }
                };
                if let Some(m) = mux.as_mut() {
                    m.push_system_samples(&frame.samples);
                } else {
                    pending_sys.push(frame);
                }
            }
        }

        if let Some(m) = mux.as_mut() {
            while let Some(frame) = m.try_pop_frame() {
                if out.try_send(frame).is_err() {
                    // Downstream backed up — let it catch up before
                    // pumping more frames. The Deepgram WS client (Phase
                    // 3) will be the bottleneck.
                    log::debug!("[Copilot/mux] downstream out channel full, will retry");
                    break;
                }
            }
        }

        // Suppress unused-variable warning on pending_mic; replayed
        // implicitly when mux constructs (we don't actually need it
        // since the mux is built from the first mic frame, but keeping
        // the symmetry with pending_sys makes the code easy to extend).
        let _ = &pending_mic;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interleave_basic() {
        // mic at 16 kHz (passthrough), system at the mux's hardcoded
        // 48 kHz → push 12 000 sys samples to get ~4 000 after the 3:1
        // downsample. Need 4 000 each side for one frame.
        let mut mux = AudioMux::new(OUT_RATE).expect("mux");
        let mic: Vec<f32> = (0..4000).map(|i| (i as f32) / 4000.0).collect();
        // 12 000 samples at 48 kHz = 250 ms = ~4 000 output at 16 kHz.
        let sys: Vec<f32> = (0..14_400).map(|i| -((i as f32) / 14_400.0)).collect();
        mux.push_mic_samples(&mic);
        mux.push_system_samples(&sys);

        let frame = mux.try_pop_frame().expect("expected one frame");
        assert_eq!(frame.pcm_s16le_stereo.len(), 8000);
        // Channel ordering: L=mic R=sys, samples 2 onward should show
        // the sign pattern (mic positive, sys negative).
        assert!(frame.pcm_s16le_stereo[2] >= 0, "mic[1] should be positive");
        assert!(frame.pcm_s16le_stereo[3] <= 0, "sys[1] should be negative");
    }

    #[test]
    fn test_resample_44100_to_16000() {
        // Confirm a mic at 44.1 kHz produces approximately the expected
        // sample count after resample. 44100 input → 16000 output ratio
        // ≈ 0.3628; 4 410 input samples ≈ 1 600 output samples.
        let mut mux = AudioMux::new(44_100).expect("mux");
        let chunks_in = 100; // ~10 chunks worth at chunk_in=441
        for _ in 0..chunks_in {
            let chunk: Vec<f32> = (0..441).map(|i| (i as f32) / 441.0).collect();
            mux.push_mic_samples(&chunk);
        }
        // 100 * 441 = 44 100 input samples → ~16 000 output samples.
        // We need ≥ 4 000 to pop a frame; we should easily exceed it.
        assert!(
            mux.mic_out.len() >= FRAME_SAMPLES_PER_CHANNEL,
            "expected ≥ {} mic samples after resampling 44 100 → 16 000, got {}",
            FRAME_SAMPLES_PER_CHANNEL,
            mux.mic_out.len()
        );
        // Sanity: didn't blow up the upper bound either.
        assert!(
            mux.mic_out.len() < 20_000,
            "resample produced suspiciously many samples: {}",
            mux.mic_out.len()
        );
    }

    #[test]
    fn test_clamp_overflow() {
        // f32 = 2.0 must clamp to i16::MAX (not wrap or overflow).
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
        assert_eq!(f32_to_i16(0.0), 0);
        // 0.5 → ~16383
        let h = f32_to_i16(0.5);
        assert!(h >= 16_000 && h <= 16_500, "0.5 mapped to {h}");
    }

    #[test]
    fn test_drift_drop() {
        // Push 5 s of mic without any system audio. The mux should
        // drop the lead so unbounded memory growth doesn't happen.
        let mut mux = AudioMux::new(OUT_RATE).expect("mux"); // 16k passthrough
        let big_chunk: Vec<f32> = vec![0.5; 80_000]; // 5 s at 16 kHz
        mux.push_mic_samples(&big_chunk);

        // After drift policy: mic_out.len() should be sys_out.len() +
        // DRIFT_DROP_THRESHOLD = 0 + 16_000 = 16 000 (1 s of audio).
        assert_eq!(
            mux.mic_out.len(),
            DRIFT_DROP_THRESHOLD,
            "drift drop should leave exactly {} samples, got {}",
            DRIFT_DROP_THRESHOLD,
            mux.mic_out.len()
        );
        assert_eq!(mux.sys_out.len(), 0);
    }

    #[test]
    fn test_no_frame_until_both_channels_have_enough() {
        let mut mux = AudioMux::new(OUT_RATE).expect("mux");
        // Push only mic — no frame should pop yet.
        let mic: Vec<f32> = vec![0.1; 4000];
        mux.push_mic_samples(&mic);
        assert!(mux.try_pop_frame().is_none(), "should not pop without sys");

        // Add system at the mux's required 48 kHz rate. 12 000 input
        // samples → ~4 000 output at 16 kHz, which is one frame's worth.
        let sys: Vec<f32> = vec![-0.1; 14_400];
        mux.push_system_samples(&sys);
        assert!(
            mux.try_pop_frame().is_some(),
            "should pop with both channels (mic_out={}, sys_out={})",
            mux.mic_out.len(),
            mux.sys_out.len()
        );
    }
}
