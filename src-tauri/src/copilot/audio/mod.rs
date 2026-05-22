//! macOS audio capture for Wolfee Copilot (Sub-prompt 2 — Listening).
//!
//! Architecture (locked in plan §2, Option B):
//! - `system_macos` — ScreenCaptureKit, captures the speakers' audio (the
//!   far end of a Zoom/Meet/Teams call). 48 kHz f32 mono.
//! - `mic` — cpal default-input, captures the user's voice. Device-native
//!   sample rate, downmixed to mono in the callback.
//! - `mux` — rubato resamples both channels to 16 kHz and interleaves
//!   them into 250 ms i16 stereo frames (L=user, R=speakers).
//! - `permissions` — TCC probes for both classes; called by `start()`
//!   before any capture begins so the OS prompt fires deliberately.
//!
//! Output of this module is a stream of `AudioFrame`s on a tokio mpsc
//! channel, ready for Phase 3 (Deepgram WebSocket) to consume.
//!
//! NOT in this phase:
//! - WebSocket / Deepgram (Phase 3)
//! - Tray menu wiring (Phase 5)
//! - Permission UX modal in the overlay (Phase 6)

#[cfg(target_os = "macos")]
pub mod system_macos;

pub mod mic;
pub mod mux;
pub mod permissions;
#[cfg(target_os = "macos")]
pub mod recorder;
#[cfg(target_os = "macos")]
pub mod recording_upload;

/// Output of `CopilotAudioCapture::stop` when a per-session recording
/// was active. Carries everything `recording_upload::upload_recording`
/// needs: the local M4A path, the captured duration, and the file
/// size. Defined cross-platform (rather than inside the macOS-gated
/// `recorder` module) so the `stop()` signature stays uniform.
#[derive(Debug, Clone)]
pub struct CopilotRecordingResult {
    pub path: std::path::PathBuf,
    pub duration_ms: u64,
    pub size_bytes: u64,
}

use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tokio::sync::mpsc;

/// One Deepgram-ready stereo frame: 16 kHz int16, L=user (mic), R=speakers
/// (system audio), 250 ms = 4 000 samples per channel = 8 000 interleaved
/// = 16 000 bytes. Cadence: ~4 frames per second.
#[derive(Debug, Clone)]
pub struct AudioFrame {
    pub pcm_s16le_stereo: Vec<i16>,
    pub captured_at: Instant,
}

impl AudioFrame {
    /// Number of samples per channel — should be 4000 for a well-formed frame.
    pub fn samples_per_channel(&self) -> usize {
        self.pcm_s16le_stereo.len() / 2
    }

    /// Frame duration in milliseconds at 16 kHz.
    pub fn duration_ms(&self) -> u64 {
        (self.samples_per_channel() as u64 * 1000) / 16_000
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    Microphone,
    ScreenRecording,
}

impl PermissionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Microphone => "Microphone",
            Self::ScreenRecording => "ScreenRecording",
        }
    }
}

#[derive(Debug)]
pub enum AudioError {
    /// User has not granted the required TCC permission. Sub-prompt 6
    /// will catch this in the overlay and render the "Open System
    /// Settings → ..." modal. Sub-prompt 2 just surfaces the variant.
    PermissionDenied(PermissionKind),
    /// No usable input device (no mic, screen unsupported, etc.). Rare.
    DeviceUnavailable,
    /// Recoverable failure — caller may retry. The string is for logs,
    /// not user display.
    Transient(String),
}

impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PermissionDenied(k) => write!(f, "permission denied: {}", k.as_str()),
            Self::DeviceUnavailable => write!(f, "audio device unavailable"),
            Self::Transient(s) => write!(f, "transient audio error: {s}"),
        }
    }
}

impl std::error::Error for AudioError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureState {
    Idle,
    Capturing,
    Stopping,
}

/// Top-level audio capture handle. Owns the mic + system streams and
/// the mux pump task. Drop or `stop()` to tear everything down.
///
/// Phase 5 will instantiate this from the session-start tray action.
/// Phase 2 just makes sure the type compiles and `start()`/`stop()`
/// run end-to-end against permission probes.
pub struct CopilotAudioCapture {
    #[cfg(target_os = "macos")]
    system: Option<system_macos::SystemAudioStream>,
    mic: Option<mic::MicAudioStream>,
    state: Arc<Mutex<CaptureState>>,
    /// Pump task that pulls from the mux and pushes onto `out`. Aborted
    /// in `stop()`.
    pump: Option<tokio::task::JoinHandle<()>>,
    /// Phase 1 per-session WAV/M4A recorder. `None` when recording was
    /// disabled (no path passed in) or the writer failed to open — the
    /// session still runs in that case, just without a recording.
    #[cfg(target_os = "macos")]
    recorder: Option<recorder::CopilotRecorder>,
}

impl CopilotAudioCapture {
    /// Run permission probes, spawn capture streams + mux pump, return
    /// the handle. The caller owns the receiving end of `out`.
    ///
    /// Permission denials surface as `AudioError::PermissionDenied(...)`
    /// and the streams are NOT started — the caller (Phase 6 overlay
    /// modal handler) is expected to prompt the user, then re-call `start`.
    pub async fn start(
        session_id: String,
        out: mpsc::Sender<AudioFrame>,
        recording_dir: Option<std::path::PathBuf>,
    ) -> Result<Self, AudioError> {
        // Probe permissions deliberately before any capture begins, so
        // the OS prompts fire in a known order (mic first per locked
        // Decision §8 — less alarming) instead of mid-stream.
        permissions::ensure_all().await?;

        let (mic_tx, mic_rx) = mpsc::channel::<mic::MicFrame>(256);

        #[cfg(target_os = "macos")]
        let (sys_tx, sys_rx) = mpsc::channel::<system_macos::SystemFrame>(256);

        // Start mic first (the cheaper, faster subsystem).
        let mic_stream = mic::MicAudioStream::start(mic_tx).await?;

        #[cfg(target_os = "macos")]
        let system_stream = system_macos::SystemAudioStream::start(sys_tx).await?;

        // Phase 1: per-session WAV → M4A recording, best-effort. On a
        // setup failure we log and run the session without a recording
        // rather than fail the whole start.
        #[cfg(target_os = "macos")]
        let (recorder_opt, recorder_tx): (
            Option<recorder::CopilotRecorder>,
            Option<mpsc::Sender<AudioFrame>>,
        ) = match recording_dir.as_deref() {
            Some(dir) => match recorder::CopilotRecorder::start(&session_id, dir) {
                Ok((rec, tx)) => (Some(rec), Some(tx)),
                Err(e) => {
                    log::warn!("[Copilot/rec] not recording — {e}");
                    (None, None)
                }
            },
            None => (None, None),
        };
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (recording_dir, &session_id);
        }

        let state = Arc::new(Mutex::new(CaptureState::Capturing));

        // Spawn mux pump. Sub-prompt 2 keeps this minimal — Phase 3 will
        // extend it for backpressure / replay buffer integration.
        let pump_state = state.clone();
        let pump = tokio::spawn(async move {
            #[cfg(target_os = "macos")]
            mux::run_pump(mic_rx, sys_rx, out, recorder_tx, pump_state).await;
            #[cfg(not(target_os = "macos"))]
            {
                let _ = mic_rx;
                let _ = out;
                let _ = pump_state;
                log::warn!("[Copilot] audio capture only supported on macOS in V1");
            }
        });

        Ok(Self {
            #[cfg(target_os = "macos")]
            system: Some(system_stream),
            mic: Some(mic_stream),
            state,
            pump: Some(pump),
            #[cfg(target_os = "macos")]
            recorder: recorder_opt,
        })
    }

    pub async fn stop(mut self) -> Result<Option<CopilotRecordingResult>, AudioError> {
        {
            let mut s = self.state.lock().await;
            *s = CaptureState::Stopping;
        }

        // Drop mic stream (cpal::Stream Drop unwinds the OS handle).
        self.mic.take();

        #[cfg(target_os = "macos")]
        if let Some(sys) = self.system.take() {
            sys.stop().await?;
        }

        if let Some(pump) = self.pump.take() {
            pump.abort();
            let _ = pump.await;
        }

        // Phase 1 recording: finalize the WAV → M4A. The pump above is
        // gone, so its sender to the recorder is dropped; the writer
        // task's channel is closing as we get here. Best-effort —
        // errors are logged but don't fail the session teardown.
        #[cfg(target_os = "macos")]
        let recording: Option<CopilotRecordingResult> =
            if let Some(rec) = self.recorder.take() {
                match rec.finalize().await {
                    Ok(result) => {
                        log::info!(
                            "[Copilot/rec] session recording saved → {} ({} ms, {} bytes)",
                            result.path.display(),
                            result.duration_ms,
                            result.size_bytes
                        );
                        Some(result)
                    }
                    Err(e) => {
                        log::warn!("[Copilot/rec] finalize failed: {e}");
                        None
                    }
                }
            } else {
                None
            };
        #[cfg(not(target_os = "macos"))]
        let recording: Option<CopilotRecordingResult> = None;

        {
            let mut s = self.state.lock().await;
            *s = CaptureState::Idle;
        }
        Ok(recording)
    }

    pub async fn current_state(&self) -> CaptureState {
        *self.state.lock().await
    }
}
