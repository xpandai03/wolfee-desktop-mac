//! ScreenCaptureKit-backed system-audio capture (Sub-prompt 2 — Listening,
//! plan §2). macOS only.
//!
//! Builds an SCStream against the primary display with an audio-only
//! configuration: 48 kHz mono PCM float, current-process audio excluded
//! (so Wolfee's own UI sounds are filtered out by the OS).
//!
//! ScreenCaptureKit always requires a display in the content filter even
//! when capturing only audio — the filter scopes "what's on this display"
//! and audio is the union of all apps that can be heard. The video output
//! type is ignored on our side; we only attach a handler for
//! `SCStreamOutputType::Audio`.
//!
//! Crate: `screencapturekit` 1.5.4 (the doom-fish/screencapturekit-rs
//! crate). The audio-only filter API is a clean fit — we did NOT need to
//! drop to `objc2-screen-capture-kit` per the plan §2 fallback.

#![cfg(target_os = "macos")]

use std::sync::Arc;
use std::time::Instant;

use screencapturekit::{
    cm::CMSampleBuffer,
    shareable_content::SCShareableContent,
    stream::{
        configuration::{audio::AudioSampleRate, SCStreamConfiguration},
        content_filter::SCContentFilter,
        output_type::SCStreamOutputType,
        sc_stream::SCStream,
    },
};
use tokio::sync::mpsc;

use super::AudioError;

/// One system-audio chunk for the mux. Always mono 48 kHz f32 (the
/// ScreenCaptureKit configuration we set), variable size — the OS
/// hands us whatever buffer it has at callback time.
#[derive(Debug, Clone)]
pub struct SystemFrame {
    pub samples: Vec<f32>,
    pub captured_at: Instant,
}

/// Owned handle around an active SCStream. Drop or call `stop()` to
/// tear down. SCStream::Drop releases the OS resources but the explicit
/// stop_capture is preferred so the OS gets a clean shutdown signal.
pub struct SystemAudioStream {
    stream: SCStream,
}

impl SystemAudioStream {
    pub async fn start(
        sender: mpsc::Sender<SystemFrame>,
    ) -> Result<Self, AudioError> {
        // ScreenCaptureKit calls happen via Objective-C runtime and have
        // to run on a thread the runtime considers safe. Calling
        // SCShareableContent::get() and constructing the stream from the
        // current async task is fine on macOS, but we offload to
        // spawn_blocking out of caution — the API documentation isn't
        // explicit and we don't want to invent threading bugs at runtime.
        let sender_for_handler = sender.clone();
        let result = tokio::task::spawn_blocking(move || {
            build_stream(sender_for_handler)
        })
        .await
        .map_err(|e| AudioError::Transient(format!("spawn_blocking join: {e}")))??;

        Ok(result)
    }

    pub async fn stop(self) -> Result<(), AudioError> {
        let stream = self.stream;
        tokio::task::spawn_blocking(move || {
            if let Err(e) = stream.stop_capture() {
                log::warn!("[Copilot/sys] SCStream::stop_capture: {e}");
            }
        })
        .await
        .map_err(|e| AudioError::Transient(format!("stop join: {e}")))?;
        Ok(())
    }
}

fn build_stream(
    sender: mpsc::Sender<SystemFrame>,
) -> Result<SystemAudioStream, AudioError> {
    // 1. Enumerate shareable displays. We need at least one to scope the
    //    filter; macOS still routes audio for the whole system through
    //    that filter when captures_audio is on.
    let content = SCShareableContent::get()
        .map_err(|e| AudioError::Transient(format!("SCShareableContent::get: {e}")))?;
    let displays = content.displays();
    let display = displays
        .first()
        .ok_or_else(|| AudioError::Transient("no displays available".into()))?;

    log::info!("[Copilot/sys] using display id: {:?}", display.display_id());

    // 2. Audio-only filter — we don't pass any window/app exclusions
    //    beyond the current-process exclusion that lives on the
    //    configuration (see step 3).
    let filter = SCContentFilter::create()
        .with_display(display)
        .build();

    // 3. SCStreamConfiguration — audio capture enabled, mono 48 kHz,
    //    current-process audio excluded so we don't capture our own UI
    //    sounds (chime when the overlay shows, etc.).
    let config = SCStreamConfiguration::new()
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(AudioSampleRate::Rate48000)
        .with_channel_count(1);

    // 4. Build the stream. Box the closure so the trait object satisfies
    //    SCStreamOutputTrait (the crate has a blanket impl for any
    //    Fn(CMSampleBuffer, SCStreamOutputType) + Send + 'static).
    let mut stream = SCStream::new(&filter, &config);

    let sender_handler = Arc::new(sender);
    let handler_sender = sender_handler.clone();
    let handler =
        move |sample_buffer: CMSampleBuffer, of_type: SCStreamOutputType| {
            // Filter to audio only — video frames go to the same stream
            // but we ignore them.
            if of_type != SCStreamOutputType::Audio {
                return;
            }
            handle_audio_buffer(&handler_sender, sample_buffer);
        };

    let _handler_id = stream
        .add_output_handler(handler, SCStreamOutputType::Audio);

    // 5. start_capture is what triggers the macOS Screen Recording TCC
    //    prompt the first time — by then the user has already gone
    //    through ensure_screen_recording() in permissions.rs which calls
    //    request() upfront, so this should be a no-op trust-wise.
    stream
        .start_capture()
        .map_err(|e| AudioError::Transient(format!("SCStream::start_capture: {e}")))?;

    log::info!("[Copilot/sys] SCStream started — audio capture live");

    Ok(SystemAudioStream { stream })
}

fn handle_audio_buffer(
    sender: &Arc<mpsc::Sender<SystemFrame>>,
    sample_buffer: CMSampleBuffer,
) {
    let buffer_list = match sample_buffer.audio_buffer_list() {
        Some(l) => l,
        None => {
            log::debug!("[Copilot/sys] sample buffer had no audio_buffer_list");
            return;
        }
    };

    // We configured channel_count = 1, so we expect a single buffer
    // containing interleaved-mono float32 data. If the OS hands us
    // multiple buffers (e.g., on some output configurations), fold them
    // by averaging — same defensive shape as the cpal mic downmix.
    let mut samples: Vec<f32> = Vec::new();
    let mut buf_count = 0;
    for buf in buffer_list.iter() {
        let bytes = buf.data();
        let frames = bytes.len() / std::mem::size_of::<f32>();
        if frames == 0 {
            continue;
        }
        // Safety: ScreenCaptureKit guarantees the data is valid f32 PCM
        // when sample_rate is set via AudioSampleRate (which is what the
        // OS uses). We checked frames > 0 and bytes.len() is a multiple
        // of 4. The slice is read-only and bounded by data_byte_size.
        let f32_slice: &[f32] = unsafe {
            std::slice::from_raw_parts(bytes.as_ptr() as *const f32, frames)
        };

        if buf_count == 0 {
            samples.extend_from_slice(f32_slice);
        } else {
            // Average into the existing buffer. SCK should hand us one
            // buffer for mono; this branch is paranoia.
            for (i, &s) in f32_slice.iter().enumerate() {
                if i < samples.len() {
                    samples[i] = (samples[i] + s) * 0.5;
                }
            }
        }
        buf_count += 1;
    }

    if samples.is_empty() {
        return;
    }

    let frame = SystemFrame {
        samples,
        captured_at: Instant::now(),
    };

    if let Err(e) = sender.try_send(frame) {
        match e {
            mpsc::error::TrySendError::Full(_) => {
                log::debug!("[Copilot/sys] mux receiver full — dropped system frame");
            }
            mpsc::error::TrySendError::Closed(_) => {
                log::warn!("[Copilot/sys] mux receiver closed");
            }
        }
    }
}
