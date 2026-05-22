//! Phase 1 of Copilot session recordings.
//!
//! The mux pump (see `mux.rs`) already produces a clean
//! 16 kHz int16 stereo `AudioFrame` (L=mic, R=system) every 250 ms for
//! Deepgram. We tee a clone of each frame here and stream it to a WAV
//! file. The tee uses `try_send` on the pump side so a stuck file
//! writer can never backpressure Deepgram — frames are dropped on a
//! full channel instead.
//!
//! On `finalize()` the WAV is closed and re-encoded to M4A using
//! macOS's built-in `afconvert` (no extra deps, ~10× smaller, plays
//! natively in `<audio>`). The WAV is then deleted.
//!
//! Phase 2+ will upload the M4A; Phase 1 just lands the file on disk
//! so the audio capture path is observable without touching the
//! upload + web app surfaces.

#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{AudioFrame, CopilotRecordingResult};

/// One-per-Copilot-session WAV writer. `start()` opens the file +
/// spawns the writer task; `finalize()` closes it and encodes M4A.
pub struct CopilotRecorder {
    /// "copilot_<session_id>.wav" — kept for the writer task's log
    /// + as the input to `afconvert` on finalize.
    wav_path: PathBuf,
    /// Blocking writer task; resolves when the channel closes.
    writer_task: JoinHandle<Result<u64, String>>,
}

impl CopilotRecorder {
    /// Open the WAV file, spawn the writer task, and return:
    /// - the recorder handle (to be stashed in `CopilotAudioCapture`),
    /// - the sender the mux pump should `try_send` cloned frames to.
    ///
    /// The pump drops its sender when the pump task ends; that closes
    /// the channel, the writer task exits, and `finalize()` returns.
    pub fn start(
        session_id: &str,
        dir: &Path,
    ) -> Result<(Self, mpsc::Sender<AudioFrame>), String> {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

        let wav_path = dir.join(format!("copilot_{session_id}.wav"));

        // AudioFrame is 16 kHz, int16, interleaved stereo (L=mic R=sys).
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(&wav_path, spec)
            .map_err(|e| format!("WavWriter::create {}: {e}", wav_path.display()))?;
        log::info!("[Copilot/rec] writing → {}", wav_path.display());

        // 128 frames × 250 ms = 32 s of buffer before drop-on-full.
        // Generous: typical disk write latency is sub-ms, so this only
        // matters if the disk is pathologically slow.
        let (tx, mut rx) = mpsc::channel::<AudioFrame>(128);

        // Run the write loop on the blocking pool — hound's writes are
        // synchronous file I/O. `blocking_recv` is the supported way to
        // pull from a tokio mpsc inside a blocking context.
        let wav_path_for_log = wav_path.clone();
        let writer_task = tokio::task::spawn_blocking(move || -> Result<u64, String> {
            let mut writer = writer;
            let mut frames: u64 = 0;
            while let Some(frame) = rx.blocking_recv() {
                for s in &frame.pcm_s16le_stereo {
                    writer
                        .write_sample(*s)
                        .map_err(|e| format!("write_sample: {e}"))?;
                }
                frames += 1;
            }
            writer
                .finalize()
                .map_err(|e| format!("finalize WAV: {e}"))?;
            log::info!(
                "[Copilot/rec] WAV closed — {} frames ({} ms) → {}",
                frames,
                frames * 250,
                wav_path_for_log.display()
            );
            Ok(frames)
        });

        Ok((
            Self {
                wav_path,
                writer_task,
            },
            tx,
        ))
    }

    /// Wait for the writer to finish, then re-encode the WAV to M4A
    /// (AAC) using macOS's `afconvert`. Returns the encoded file's
    /// path, captured duration, and size — enough for the Phase 3
    /// upload to send the right metadata to the backend.
    ///
    /// Errors here are non-fatal to the session — callers log + move
    /// on. The local WAV will remain on disk for manual recovery if
    /// encoding fails.
    pub async fn finalize(self) -> Result<CopilotRecordingResult, String> {
        // Wait for the writer task. By the time we get here, the pump
        // has been aborted (see CopilotAudioCapture::stop), so its
        // sender is already dropped and the writer's channel has
        // closed — this await returns quickly.
        let frames = match self.writer_task.await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(format!("writer: {e}")),
            Err(e) => return Err(format!("writer join: {e}")),
        };
        if frames == 0 {
            // Empty session — nothing to encode. Drop the empty WAV.
            let _ = std::fs::remove_file(&self.wav_path);
            return Err("no audio frames recorded".to_string());
        }

        let wav = self.wav_path.clone();
        let m4a = wav.with_extension("m4a");
        log::info!(
            "[Copilot/rec] encoding → {} (via afconvert)",
            m4a.display()
        );
        let out = tokio::process::Command::new("/usr/bin/afconvert")
            .args(["-f", "m4af", "-d", "aac"])
            .arg(&wav)
            .arg(&m4a)
            .output()
            .await
            .map_err(|e| format!("afconvert spawn: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "afconvert exit={:?} stderr={}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }

        // Encoded successfully — drop the WAV.
        let _ = std::fs::remove_file(&wav);

        let size_bytes = std::fs::metadata(&m4a).map(|m| m.len()).unwrap_or(0);
        let duration_ms = frames * 250;
        log::info!(
            "[Copilot/rec] encoded → {} ({:.2} MB, {} ms, {} frames)",
            m4a.display(),
            (size_bytes as f64) / 1_048_576.0,
            duration_ms,
            frames
        );
        Ok(CopilotRecordingResult {
            path: m4a,
            duration_ms,
            size_bytes,
        })
    }
}
