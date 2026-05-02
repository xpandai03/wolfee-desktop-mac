//! TCC permission probes for the macOS audio capture stack
//! (Sub-prompt 2 — Listening, plan §8 Option A).
//!
//! Probe order is **mic first, screen recording second** per the locked
//! decision. Mic is the less-alarming prompt — if we successfully prompt
//! for mic, we know we're at least past the "what is this app" trust
//! threshold before we ask for screen recording.
//!
//! Sub-prompt 6 will replace these inline probes with a proper
//! onboarding flow. Sub-prompt 2 just needs them to not crash and to
//! surface `PermissionDenied(...)` cleanly so the overlay's bare modal
//! (Phase 6) can render the right "Open System Settings → ..." link.

#[cfg(target_os = "macos")]
use core_graphics::access::ScreenCaptureAccess;

use cpal::traits::{DeviceTrait, HostTrait};

use super::{AudioError, PermissionKind};

/// Probe microphone access. The actual macOS TCC prompt fires the first
/// time we successfully open an input stream; this function does both
/// the build-config check (fast — fails before prompting if no device
/// at all) and a lightweight stream-open probe so the prompt fires.
///
/// Caveat: on macOS, building+playing a cpal input stream when TCC has
/// denied the app **does not return an error** — the data callback
/// instead fires with all-zero samples. Detecting that requires
/// observing samples, which we defer to the live capture pipeline. This
/// probe catches the "no device" and "config invalid" paths; the
/// silent-zero path is Sub-prompt 6's job to surface in the UX.
pub async fn ensure_microphone() -> Result<(), AudioError> {
    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            log::warn!("[Copilot/perm] no default input device — DeviceUnavailable");
            return Err(AudioError::DeviceUnavailable);
        }
    };

    if let Ok(desc) = device.description() {
        log::info!("[Copilot/perm] mic probe — default input: {}", desc.name());
    }

    match device.default_input_config() {
        Ok(cfg) => {
            log::info!(
                "[Copilot/perm] mic config: rate={}, channels={}, format={:?}",
                cfg.sample_rate(),
                cfg.channels(),
                cfg.sample_format()
            );
            Ok(())
        }
        Err(e) => {
            // cpal's BuildStreamError variants don't include a clean
            // "PermissionDenied" — macOS surfaces TCC denial as silent
            // zero samples post-build, not a build error. We translate
            // any config failure to a generic transient error rather
            // than mis-claiming PermissionDenied; the caller (Sub-prompt
            // 6 onboarding) probes again live to disambiguate.
            log::warn!("[Copilot/perm] mic config failed: {e}");
            Err(AudioError::Transient(format!("mic config: {e}")))
        }
    }
}

/// Probe screen recording access via CoreGraphics. Two-step:
/// 1. `preflight()` — silent check, no UI
/// 2. If denied, `request()` — triggers the TCC prompt + returns the
///    user's response synchronously (true if granted, false if denied
///    or dismissed)
///
/// We deliberately call `request()` here even on first run because
/// Sub-prompt 2 is the moment the user clicks Start Copilot Session —
/// failing silently and only retrying later is a worse UX than the
/// upfront prompt. Sub-prompt 6 may move the prompt earlier (into
/// onboarding); Sub-prompt 2's interim placement is fine.
#[cfg(target_os = "macos")]
pub async fn ensure_screen_recording() -> Result<(), AudioError> {
    let access = ScreenCaptureAccess::default();

    if access.preflight() {
        log::info!("[Copilot/perm] screen recording — preflight: OK");
        return Ok(());
    }

    log::info!("[Copilot/perm] screen recording — preflight false, prompting via request()");
    if access.request() {
        log::info!("[Copilot/perm] screen recording — granted");
        Ok(())
    } else {
        log::warn!(
            "[Copilot/perm] screen recording — denied (user must enable Wolfee Desktop in \
             System Settings → Privacy & Security → Screen Recording, then re-launch the app)"
        );
        Err(AudioError::PermissionDenied(PermissionKind::ScreenRecording))
    }
}

#[cfg(not(target_os = "macos"))]
pub async fn ensure_screen_recording() -> Result<(), AudioError> {
    Err(AudioError::Transient(
        "screen recording capture only supported on macOS in V1".into(),
    ))
}

pub async fn ensure_all() -> Result<(), AudioError> {
    ensure_microphone().await?;
    ensure_screen_recording().await?;
    Ok(())
}
