//! Loom-style screen recorder — capture (Phase 1).
//!
//! Records the primary display straight to an H.264 MP4 using
//! ScreenCaptureKit's `SCRecordingOutput` (macOS 15.0+). The OS does
//! the hardware encoding (VideoToolbox) and the muxing internally —
//! there is no `AVAssetWriter` FFI, no `CMSampleBuffer` plumbing, and
//! no ffmpeg. The whole capture+encode pipeline is ~one screenful of
//! safe Rust against the already-vendored `screencapturekit` crate.
//!
//! Audio: `SCStreamConfiguration::captures_microphone` (macOS 15+) and
//! `captures_audio` let ScreenCaptureKit fold the microphone and the
//! system audio into the recording file for us. Wolfee's own process
//! audio is excluded so app chimes don't leak into demos.
//!
//! macOS-15 gate: `SCRecordingOutput` and `captures_microphone` are
//! macOS 15.0 APIs. `macos_supports_recording()` is the runtime guard
//! so the app still launches and runs on macOS 13/14 — the recorder
//! feature is simply unavailable there. The crate's
//! `SCRecordingOutput::new()` also returns `None` on < 15, so this is
//! belt-and-suspenders.

#![cfg(target_os = "macos")]

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use screencapturekit::{
    recording_output::{
        RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec,
        SCRecordingOutputConfiguration, SCRecordingOutputFileType,
    },
    shareable_content::SCShareableContent,
    stream::{
        configuration::SCStreamConfiguration, content_filter::SCContentFilter,
        sc_stream::SCStream,
    },
};

/// Cap the recording at 1080p tall. Width is derived from the display's
/// aspect ratio so there are no letterbox bars.
const TARGET_HEIGHT: u32 = 1080;
/// Capture frame rate.
const TARGET_FPS: u32 = 30;
/// How long `stop()` waits for `SCRecordingOutput` to flush the MP4
/// `moov` atom before giving up and trusting the file on disk anyway.
const FINALIZE_TIMEOUT: Duration = Duration::from_secs(20);

/// Whether this Mac can run the Loom recorder. `true` only on macOS
/// 15.0 (Sequoia) or later. Cached — `sw_vers` is spawned once.
pub fn macos_supports_recording() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        let major = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .split('.')
                    .next()
                    .and_then(|s| s.parse::<u32>().ok())
            })
            .unwrap_or(0);
        let ok = major >= 15;
        log::info!(
            "[Loom] macOS major version = {major} → screen recorder {}",
            if ok { "available" } else { "unavailable (needs 15+)" }
        );
        ok
    })
}

/// Directory where recordings are written before upload — the same
/// `~/Library/Application Support/io.wolfee.desktop/recordings/` the
/// legacy audio recorder uses. Created if missing.
fn recordings_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("io.wolfee.desktop")
        .join("recordings");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// A timestamped `.mp4` path for a new recording.
pub fn new_recording_path() -> PathBuf {
    let ts = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    recordings_dir().join(format!("screen_{ts}.mp4"))
}

/// Result of a finished recording.
pub struct RecordingResult {
    pub file_path: PathBuf,
    pub duration_secs: f64,
    pub size_bytes: u64,
}

/// Lifecycle event from the `SCRecordingOutput` delegate.
enum RecEvent {
    Finished,
    Failed(String),
}

/// An in-flight screen recording. Owns the `SCStream` + the
/// `SCRecordingOutput`; drop or `stop()` to tear down.
pub struct ScreenRecorder {
    stream: SCStream,
    recording_output: SCRecordingOutput,
    /// Receives the delegate's finish/fail event so `stop()` can wait
    /// for the MP4 to be fully finalized before we read it.
    finish_rx: mpsc::Receiver<RecEvent>,
    output_path: PathBuf,
    started: Instant,
}

impl ScreenRecorder {
    /// Start recording the primary display to `output_path`.
    ///
    /// Blocking — call from `spawn_blocking`. The ScreenCaptureKit
    /// calls cross into the Objective-C runtime; the existing Copilot
    /// system-audio capture uses the same `spawn_blocking` discipline.
    pub fn start(output_path: PathBuf) -> Result<Self, String> {
        if !macos_supports_recording() {
            return Err("Screen recording requires macOS 15 (Sequoia) or later.".to_string());
        }

        // 1. Pick the primary display. Phase 1 records the primary
        //    display only; multi-display selection lands with the
        //    pre-record panel (deferred — see the test plan).
        let content = SCShareableContent::get().map_err(|e| {
            format!(
                "Screen recording is blocked. Enable Wolfee under System Settings → \
                 Privacy & Security → Screen Recording, then quit and reopen Wolfee. ({e})"
            )
        })?;
        let displays = content.displays();
        log::info!("[recorder] SCShareableContent OK — {} display(s)", displays.len());
        let display = displays.into_iter().next().ok_or_else(|| {
            "No display available to capture. If you just granted screen-recording \
             permission, quit and reopen Wolfee, then try again."
                .to_string()
        })?;

        // 2. Derive an aspect-correct capture size, ~1080p tall. The
        //    width/height *ratio* is unit-independent, so this is
        //    correct whether the crate reports points or pixels.
        let dw = display.width().max(1);
        let dh = display.height().max(1);
        let aspect = f64::from(dw) / f64::from(dh);
        let out_h = TARGET_HEIGHT;
        let out_w = (((f64::from(out_h) * aspect).round() as u32) + 1) & !1; // even
        log::info!(
            "[Loom] display {dw}x{dh} (aspect {aspect:.3}) → capture {out_w}x{out_h} @ {TARGET_FPS}fps"
        );

        // 3. Content filter: the whole display, excluding nothing.
        //    The recorder is driven entirely from the tray menu (a
        //    transient system menu that is never part of a capture),
        //    so Phase 1 needs no window-exclusion list.
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();

        // 4. Stream configuration: video size/fps + audio. SCK folds
        //    the microphone (macOS 15+) and the system audio into the
        //    recording; our own process audio is excluded.
        let config = SCStreamConfiguration::new()
            .with_width(out_w)
            .with_height(out_h)
            .with_fps(TARGET_FPS)
            .with_captures_audio(true)
            .with_captures_microphone(true)
            .with_excludes_current_process_audio(true);

        // 5. Recording output: direct-to-file H.264 MP4.
        let rec_config = SCRecordingOutputConfiguration::new()
            .with_output_url(&output_path)
            .with_video_codec(SCRecordingOutputCodec::H264)
            .with_output_file_type(SCRecordingOutputFileType::MP4);

        // Delegate → channel: the OS calls these from an ObjC thread
        // when recording finishes or fails. `stop()` drains the channel.
        let (tx, finish_rx) = mpsc::channel::<RecEvent>();
        let tx_fail = tx.clone();
        let callbacks = RecordingCallbacks::new()
            .on_start(|| log::info!("[Loom] SCRecordingOutput: recording started"))
            .on_finish(move || {
                let _ = tx.send(RecEvent::Finished);
            })
            .on_fail(move |e| {
                log::error!("[Loom] SCRecordingOutput failure: {e}");
                let _ = tx_fail.send(RecEvent::Failed(e));
            });

        let recording_output = SCRecordingOutput::new_with_delegate(&rec_config, callbacks)
            .ok_or_else(|| {
                "Failed to create the recording output — macOS 15+ is required.".to_string()
            })?;
        log::info!(
            "[recorder] SCRecordingOutput configured — output={}",
            output_path.display()
        );

        // 6. Build the stream, attach the recording output, go.
        let stream = SCStream::new(&filter, &config);
        stream
            .add_recording_output(&recording_output)
            .map_err(|e| format!("add_recording_output failed: {e}"))?;
        stream
            .start_capture()
            .map_err(|e| format!("start_capture failed: {e}"))?;

        log::info!(
            "[recorder] SCRecordingOutput started — capturing to {}",
            output_path.display()
        );
        Ok(Self {
            stream,
            recording_output,
            finish_rx,
            output_path,
            started: Instant::now(),
        })
    }

    /// Stop recording, wait for the MP4 to be finalized, and return the
    /// finished file. Blocking — call from `spawn_blocking`.
    pub fn stop(self) -> Result<RecordingResult, String> {
        let duration = self.started.elapsed().as_secs_f64();
        log::info!("[Loom] stopping recording — wall-clock {duration:.1}s");

        self.stream
            .stop_capture()
            .map_err(|e| format!("stop_capture failed: {e}"))?;
        self.stream
            .remove_recording_output(&self.recording_output)
            .map_err(|e| format!("remove_recording_output failed: {e}"))?;

        // Wait for the delegate's finish callback — until it fires the
        // MP4's moov atom may not be flushed and the file would be
        // unplayable. A mid-recording failure surfaces here too.
        match self.finish_rx.recv_timeout(FINALIZE_TIMEOUT) {
            Ok(RecEvent::Finished) => log::info!("[Loom] recording finalized"),
            Ok(RecEvent::Failed(e)) => return Err(format!("Recording failed: {e}")),
            Err(_) => log::warn!(
                "[Loom] no finalize callback within {}s — trusting the file on disk",
                FINALIZE_TIMEOUT.as_secs()
            ),
        }

        let meta = std::fs::metadata(&self.output_path)
            .map_err(|e| format!("Recording file missing after stop: {e}"))?;
        if meta.len() == 0 {
            return Err("Recording file is empty.".to_string());
        }
        log::info!(
            "[Loom] recording done: {} ({:.1} MB, {duration:.1}s)",
            self.output_path.display(),
            meta.len() as f64 / 1_048_576.0
        );

        Ok(RecordingResult {
            file_path: self.output_path,
            duration_secs: duration,
            size_bytes: meta.len(),
        })
    }
}
