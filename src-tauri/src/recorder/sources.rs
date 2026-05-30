//! Capture-source enumeration (recorder — Phase 1 source picker).
//!
//! Wraps `SCShareableContent` to list the displays and on-screen
//! windows the user can pick as a recording target, and provides the
//! presence checks the auto-stop watchdog polls. macOS-only: it leans
//! entirely on the `screencapturekit` crate.
//!
//! No new permission: this is the *same* `SCShareableContent` API
//! behind the *same* Screen Recording TCC grant the recorder already
//! requires — there is no separate window-list prompt (unlike the old
//! `CGWindowList` world).

#![cfg(target_os = "macos")]

use serde::Serialize;

use screencapturekit::shareable_content::SCShareableContent;

/// Wolfee's own bundle identifier. Windows owned by this app are
/// filtered out of the picker so the user can't pick a Wolfee window as
/// the capture target (recursion / capturing our own overlay).
const OWN_BUNDLE_ID: &str = "io.wolfee.desktop";

#[derive(Debug, Clone, Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    /// Synthesized label ("Display 1", …) — SCK exposes no display name.
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub app_bundle_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureSources {
    pub displays: Vec<DisplayInfo>,
    pub windows: Vec<WindowInfo>,
}

/// Enumerate displays + on-screen windows for the source picker.
///
/// `app_icon_base64` from the original data contract is intentionally
/// omitted in v1 — fetching per-window icons is expensive and the
/// picker shows the app name as the subtitle instead. (Flagged in the
/// Phase 1 build notes.)
pub fn list_capture_sources() -> Result<CaptureSources, String> {
    let content = SCShareableContent::get().map_err(|e| {
        format!(
            "Couldn't read the list of windows. Enable Wolfee under System Settings → \
             Privacy & Security → Screen Recording, then quit and reopen Wolfee. ({e})"
        )
    })?;

    let displays: Vec<DisplayInfo> = content
        .displays()
        .iter()
        .enumerate()
        .map(|(i, d)| DisplayInfo {
            id: d.display_id(),
            name: format!("Display {}", i + 1),
            width: d.width(),
            height: d.height(),
        })
        .collect();

    let mut windows = Vec::new();
    for w in content.windows() {
        // Only windows the user can actually see right now.
        if !w.is_on_screen() {
            continue;
        }
        let app = w.owning_application();
        let app_bundle_id = app
            .as_ref()
            .map(|a| a.bundle_identifier())
            .unwrap_or_default();
        // Recursion guard: never offer a Wolfee window as a target.
        if app_bundle_id == OWN_BUNDLE_ID {
            continue;
        }
        let title = w.title().unwrap_or_default();
        let app_name = app.as_ref().map(|a| a.application_name()).unwrap_or_default();
        // Drop chrome-less utility surfaces (menu-bar extras, shadows)
        // that have neither a title nor an owning app name.
        if title.trim().is_empty() && app_name.trim().is_empty() {
            continue;
        }
        windows.push(WindowInfo {
            id: w.window_id(),
            title,
            app_name,
            app_bundle_id,
        });
    }

    log::info!(
        "[sources] enumerated {} display(s), {} window(s)",
        displays.len(),
        windows.len()
    );
    Ok(CaptureSources { displays, windows })
}

/// `display_id` of the primary display, if any. Used to attach a
/// display to a region the selector reported in display-local coords.
pub fn primary_display_id() -> Option<u32> {
    SCShareableContent::get()
        .ok()
        .and_then(|c| c.displays().first().map(|d| d.display_id()))
}

/// Is `window_id` still present in shareable content? Used by the
/// auto-stop watchdog. **Presence**, not on-screen-ness: a window moved
/// to another Space is still present (so we don't false-stop on a Space
/// switch), but a closed/quit window disappears entirely.
///
/// Fails safe: a transient `SCShareableContent` read error returns
/// `true` (assume still there) so a hiccup never aborts a recording.
pub fn window_present(window_id: u32) -> bool {
    match SCShareableContent::get() {
        Ok(c) => c.windows().iter().any(|w| w.window_id() == window_id),
        Err(e) => {
            log::warn!("[sources] window_present read failed ({e}) — assuming present");
            true
        }
    }
}

/// Is `display_id` still connected? Used by the auto-stop watchdog so a
/// display unplugged mid-recording stops the capture. Fails safe like
/// [`window_present`].
pub fn display_present(display_id: u32) -> bool {
    match SCShareableContent::get() {
        Ok(c) => c.displays().iter().any(|d| d.display_id() == display_id),
        Err(e) => {
            log::warn!("[sources] display_present read failed ({e}) — assuming present");
            true
        }
    }
}
