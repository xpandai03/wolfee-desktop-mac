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

// ── Sub-prompt 6.0 — silent permission status probes ─────────────────
//
// These probes inspect TCC state WITHOUT triggering a prompt — used by
// the onboarding wizard's Step 4 to render live status indicators.
// Distinct from `ensure_*` which actively prompt during session start.

/// Probe result for the wizard's status indicators. Maps cleanly to
/// the JS `PermissionStatus` union ("granted" | "denied" | "undetermined").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionProbe {
    Granted,
    Denied,
    Undetermined,
}

impl PermissionProbe {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Undetermined => "undetermined",
        }
    }
}

/// Silent microphone permission check via AVCaptureDevice
/// authorizationStatus. macOS-only; non-mac always reports
/// `Undetermined` so the wizard renders the "open settings" CTA.
///
/// AVAuthorizationStatus values (NSInteger):
///   0 NotDetermined → Undetermined
///   1 Restricted    → Denied  (parental controls etc.)
///   2 Denied        → Denied
///   3 Authorized    → Granted
#[cfg(target_os = "macos")]
pub fn probe_microphone() -> PermissionProbe {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use objc2::ffi::NSInteger;

    // SAFETY: AVCaptureDevice + authorizationStatusForMediaType: are
    // documented public APIs. Returns NSInteger by value. We pass a
    // C string to NSString helper since we don't link AVMediaType
    // constants directly.
    unsafe {
        let cls = match AnyClass::get(c"AVCaptureDevice") {
            Some(c) => c,
            None => {
                log::warn!(
                    "[Copilot/perm/probe] AVCaptureDevice class not found — \
                     AVFoundation not loaded? returning Undetermined"
                );
                return PermissionProbe::Undetermined;
            }
        };
        let nsstring_cls = match AnyClass::get(c"NSString") {
            Some(c) => c,
            None => return PermissionProbe::Undetermined,
        };
        // AVMediaTypeAudio = "soun" (Apple's FourCC literal)
        let media_type: *mut objc2::runtime::AnyObject =
            msg_send![nsstring_cls, stringWithUTF8String: c"soun".as_ptr()];
        let status: NSInteger =
            msg_send![cls, authorizationStatusForMediaType: media_type];
        match status {
            3 => PermissionProbe::Granted,
            1 | 2 => PermissionProbe::Denied,
            _ => PermissionProbe::Undetermined,
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn probe_microphone() -> PermissionProbe {
    PermissionProbe::Undetermined
}

/// Silent screen-recording permission check via CoreGraphics preflight.
/// Cannot distinguish Denied vs Undetermined — both surface as
/// preflight=false. We surface Undetermined for safety so the user
/// sees a "needs permission" hint rather than a misleading "denied".
#[cfg(target_os = "macos")]
pub fn probe_screen_recording() -> PermissionProbe {
    let access = ScreenCaptureAccess::default();
    if access.preflight() {
        PermissionProbe::Granted
    } else {
        PermissionProbe::Undetermined
    }
}

#[cfg(not(target_os = "macos"))]
pub fn probe_screen_recording() -> PermissionProbe {
    PermissionProbe::Undetermined
}
