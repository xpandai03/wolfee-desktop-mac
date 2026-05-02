//! Phase 2 stub — implementation lands in Step 5.
//!
//! Resample (rubato) + interleave to 16 kHz int16 stereo (L=user mic,
//! R=speakers system audio). Outputs 250 ms frames at ~4 Hz.

use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::sync::mpsc;

use super::{AudioFrame, CaptureState};
use super::mic::MicFrame;
#[cfg(target_os = "macos")]
use super::system_macos::SystemFrame;

#[cfg(target_os = "macos")]
pub async fn run_pump(
    mut _mic_rx: mpsc::Receiver<MicFrame>,
    mut _sys_rx: mpsc::Receiver<SystemFrame>,
    _out: mpsc::Sender<AudioFrame>,
    state: Arc<Mutex<CaptureState>>,
) {
    // Step 5 will implement the actual resample + interleave + emit loop.
    loop {
        let s = *state.lock().await;
        if s != CaptureState::Capturing {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
