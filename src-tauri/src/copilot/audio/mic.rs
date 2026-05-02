//! Phase 2 stub — implementation lands in Step 3.
//!
//! cpal-backed microphone capture with a supervisor task that
//! re-acquires the default input device on disconnect (AirPods unplug,
//! mic device swap, etc.).

use std::time::Instant;
use tokio::sync::mpsc;

use super::AudioError;

/// One mic chunk handed to the mux. Sub-prompt 2 buffers ~50 ms here
/// before pushing; the mux accumulates and emits a 250 ms output frame.
#[derive(Debug, Clone)]
pub struct MicFrame {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub captured_at: Instant,
}

pub struct MicAudioStream {
    // Step 3 will hold cpal::Stream + supervisor JoinHandle.
}

impl MicAudioStream {
    pub async fn start(_sender: mpsc::Sender<MicFrame>) -> Result<Self, AudioError> {
        // Step 3 will implement.
        Ok(Self {})
    }
}
