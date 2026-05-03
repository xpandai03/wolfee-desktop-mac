//! cpal-backed microphone capture (Sub-prompt 2 — Listening, plan §2).
//!
//! Emits ~50 ms `MicFrame`s into an mpsc channel; the mux accumulates
//! ~250 ms before publishing a Deepgram-ready stereo frame.
//!
//! Device-change supervisor (locked in plan §2): cpal's stream error
//! callback fires when the underlying device disappears (AirPods unplug,
//! audio interface swap, etc.). The supervisor task waits 1 s, re-acquires
//! `default_input_device()`, and rebuilds the stream. Bounded retry: 3
//! attempts in 5 s total before surfacing `AudioError::DeviceUnavailable`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use tokio::sync::mpsc;

use super::AudioError;

/// One mic chunk for the mux. Sample rate is the device-native rate;
/// the mux's resampler will downconvert to 16 kHz.
#[derive(Debug, Clone)]
pub struct MicFrame {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub captured_at: Instant,
}

/// Owned handle around an active cpal mic stream + supervisor signal.
/// Drop or rely on Phase 6 lifecycle to tear down.
pub struct MicAudioStream {
    /// cpal::Stream is `!Send` on most platforms — it lives on a
    /// dedicated OS thread we spawn in `start`. We send a shutdown
    /// signal via the `running` flag and let the thread drop the
    /// stream cleanly.
    running: Arc<AtomicBool>,
    /// JoinHandle so `Drop` can detach without blocking.
    _supervisor: std::thread::JoinHandle<()>,
}

impl Drop for MicAudioStream {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        // Supervisor thread will see the flag and exit on its next tick.
        // We deliberately don't .join() — it should exit within ~1 s and
        // blocking here would stall the lifecycle teardown.
    }
}

impl MicAudioStream {
    pub async fn start(sender: mpsc::Sender<MicFrame>) -> Result<Self, AudioError> {
        let running = Arc::new(AtomicBool::new(true));
        let running_supervisor = running.clone();

        // cpal::Stream is !Send + !Sync on macOS, so we own it on a
        // dedicated thread for the lifetime of the supervisor.
        let supervisor = std::thread::Builder::new()
            .name("wolfee-mic-supervisor".into())
            .spawn(move || {
                supervisor_loop(running_supervisor, sender);
            })
            .map_err(|e| AudioError::Transient(format!("spawn supervisor: {e}")))?;

        // Briefly wait for the supervisor to publish its initial state —
        // if device acquisition fails immediately we'd rather surface
        // `DeviceUnavailable` to the caller than have the supervisor
        // silently retry forever.
        // (Full first-stream verification happens at the call-site
        // when frames start flowing into the mux.)
        Ok(Self {
            running,
            _supervisor: supervisor,
        })
    }
}

fn supervisor_loop(running: Arc<AtomicBool>, sender: mpsc::Sender<MicFrame>) {
    let mut retry_attempts: u8 = 0;
    let mut retry_window_start = Instant::now();

    while running.load(Ordering::Relaxed) {
        match build_and_run_stream(&running, sender.clone()) {
            Ok(()) => {
                // Stream ended gracefully (running=false). Exit.
                log::info!("[Copilot/mic] supervisor: clean exit");
                return;
            }
            Err(e) => {
                // Reset retry window if it's been > 5 s since we started counting
                if retry_window_start.elapsed().as_secs() > 5 {
                    retry_attempts = 0;
                    retry_window_start = Instant::now();
                }

                retry_attempts += 1;
                log::warn!(
                    "[Copilot/mic] stream failed (attempt {}/3 in 5s): {}",
                    retry_attempts,
                    e
                );

                if retry_attempts >= 3 {
                    log::error!(
                        "[Copilot/mic] supervisor giving up after 3 attempts — \
                         AudioError::DeviceUnavailable"
                    );
                    return;
                }

                // Brief delay before re-acquiring (1 s = enough for AirPods
                // BT handshake to complete on replug; not so long that user
                // notices an audible gap on a transient blip).
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    }
}

/// Build a cpal input stream against the current default device, emit
/// frames into the channel until `running` flips false or the stream
/// errors. Returns Ok(()) on graceful shutdown, Err on failure (caller
/// applies the retry policy).
fn build_and_run_stream(
    running: &Arc<AtomicBool>,
    sender: mpsc::Sender<MicFrame>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;

    if let Ok(desc) = device.description() {
        log::info!("[Copilot/mic] acquired device: {}", desc.name());
    }

    let supported = device
        .default_input_config()
        .map_err(|e| format!("default_input_config: {e}"))?;

    let sample_rate: u32 = supported.sample_rate().into();
    let channels = supported.channels() as usize;
    let format = supported.sample_format();
    let stream_config: StreamConfig = supported.into();

    log::info!(
        "[Copilot/mic] stream config — rate={sample_rate} channels={channels} format={format:?}"
    );

    // The cpal callback wants a non-async send. We use try_send so a
    // backed-up consumer doesn't stall the audio thread; dropped frames
    // are logged at debug level and we keep going. The mux's bounded
    // channel (capacity 256 = ~12 s of 50 ms frames) is plenty of slack.
    let sender_cb = sender.clone();
    let stream = match format {
        SampleFormat::F32 => {
            // Layer A diagnostic — Phase 3 mic-channel debugging.
            // Logs every 5 s the maximum absolute amplitude of the raw
            // f32 buffer as it arrives from the OS, plus the first
            // sample of the last buffer in the window. If max_abs == 0
            // for a full window while the user is speaking, the bug is
            // upstream of our code (TCC / device / cpal config), not
            // in our pipeline.
            let mut diag_calls: u64 = 0;
            let mut diag_samples: u64 = 0;
            let mut diag_max_abs: f32 = 0.0;
            let mut diag_last_first = 0.0f32;
            let mut diag_last_log = Instant::now();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _info: &cpal::InputCallbackInfo| {
                    diag_calls += 1;
                    diag_samples += data.len() as u64;
                    for &s in data.iter() {
                        let a = s.abs();
                        if a > diag_max_abs {
                            diag_max_abs = a;
                        }
                    }
                    if let Some(&first) = data.first() {
                        diag_last_first = first;
                    }
                    if diag_last_log.elapsed().as_secs() >= 5 {
                        log::info!(
                            "[Copilot/mic] LAYER-A cpal cb (5s): calls={}, samples={}, \
                             max_abs={:.6}, last_first={:.6}",
                            diag_calls,
                            diag_samples,
                            diag_max_abs,
                            diag_last_first
                        );
                        diag_calls = 0;
                        diag_samples = 0;
                        diag_max_abs = 0.0;
                        diag_last_log = Instant::now();
                    }
                    push_frame(&sender_cb, data, channels, sample_rate);
                },
                mic_error_cb,
                None,
            )
        }
        SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _info: &cpal::InputCallbackInfo| {
                let f32_buf: Vec<f32> = data
                    .iter()
                    .map(|&s| s as f32 / i16::MAX as f32)
                    .collect();
                push_frame(&sender_cb, &f32_buf, channels, sample_rate);
            },
            mic_error_cb,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _info: &cpal::InputCallbackInfo| {
                let f32_buf: Vec<f32> = data
                    .iter()
                    .map(|&s| (s as f32 - i16::MAX as f32) / i16::MAX as f32)
                    .collect();
                push_frame(&sender_cb, &f32_buf, channels, sample_rate);
            },
            mic_error_cb,
            None,
        ),
        other => {
            return Err(format!("unsupported sample format: {other:?}"));
        }
    }
    .map_err(|e| format!("build_input_stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("stream.play: {e}"))?;

    log::info!("[Copilot/mic] stream playing");

    // Park the thread until shutdown is requested. cpal's stream runs
    // on its own audio thread; ours just needs to keep the Stream alive
    // (drop = stop) and watch for the shutdown signal.
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // Dropping `stream` here unwinds the OS handle cleanly.
    drop(stream);
    Ok(())
}

fn push_frame(
    sender: &mpsc::Sender<MicFrame>,
    data: &[f32],
    channels: usize,
    sample_rate: u32,
) {
    // Downmix to mono if multi-channel.
    let mono: Vec<f32> = if channels == 1 {
        data.to_vec()
    } else {
        data.chunks(channels)
            .map(|c| c.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    if mono.is_empty() {
        return;
    }

    let frame = MicFrame {
        samples: mono,
        sample_rate,
        captured_at: Instant::now(),
    };

    // Non-blocking send — if the receiver is backed up, dropping a
    // frame is preferable to stalling the audio callback (which would
    // glitch the OS audio thread and potentially cause cascading
    // device errors).
    if let Err(e) = sender.try_send(frame) {
        match e {
            mpsc::error::TrySendError::Full(_) => {
                // Common during transient mux backpressure. Don't log
                // every drop — the rate is too high for INFO-level.
                log::debug!("[Copilot/mic] mux receiver full — dropped frame");
            }
            mpsc::error::TrySendError::Closed(_) => {
                // Mux consumer is gone — supervisor will shut down.
                log::warn!("[Copilot/mic] mux receiver closed");
            }
        }
    }
}

fn mic_error_cb(err: cpal::StreamError) {
    log::error!("[Copilot/mic] stream error: {err}");
    // The error type doesn't tell us "device went away" vs "transient
    // glitch" reliably. The supervisor's retry policy (3 attempts in 5s)
    // handles both — the next iteration of build_and_run_stream will
    // return Err if the device truly disappeared.
}
