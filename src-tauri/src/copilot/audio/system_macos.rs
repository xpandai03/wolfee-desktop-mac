//! Phase 2 stub — implementation lands in Step 4.
//!
//! ScreenCaptureKit-backed system audio capture. macOS only.
//! Audio-only filter (no video frames produced). 48 kHz f32 mono.

#![cfg(target_os = "macos")]

use std::time::Instant;
use tokio::sync::mpsc;

use super::AudioError;

#[derive(Debug, Clone)]
pub struct SystemFrame {
    pub samples: Vec<f32>,
    pub captured_at: Instant,
}

pub struct SystemAudioStream {
    // Step 4 will hold the SCStream + audio output handle.
}

impl SystemAudioStream {
    pub async fn start(_sender: mpsc::Sender<SystemFrame>) -> Result<Self, AudioError> {
        // Step 4 will implement.
        Ok(Self {})
    }

    pub async fn stop(self) -> Result<(), AudioError> {
        Ok(())
    }
}
