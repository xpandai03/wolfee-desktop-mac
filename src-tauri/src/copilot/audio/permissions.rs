//! Phase 2 stub — implementation lands in Step 2.
//!
//! Probes the two TCC permission classes Sub-prompt 2 needs:
//! - Microphone (cpal input device open)
//! - Screen Recording (CGRequestScreenCaptureAccess)

use super::{AudioError, PermissionKind};

#[allow(dead_code)]
pub async fn ensure_microphone() -> Result<(), AudioError> {
    let _ = PermissionKind::Microphone;
    Ok(())
}

#[allow(dead_code)]
pub async fn ensure_screen_recording() -> Result<(), AudioError> {
    let _ = PermissionKind::ScreenRecording;
    Ok(())
}

pub async fn ensure_all() -> Result<(), AudioError> {
    ensure_microphone().await?;
    ensure_screen_recording().await?;
    Ok(())
}
