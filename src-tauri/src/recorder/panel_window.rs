//! Loom-style pre-record panel window (recorder UI redesign).
//!
//! A frameless, transparent, always-on-top webview window that hosts
//! the `#/recorder` React route (`RecorderPanel.tsx`). Opened from the
//! tray "Record Screen" item via the `open-recorder-panel`
//! wolfee-action. The panel emits `loom-record-screen` (start) or
//! `cancel-recorder-panel` (close) back to the lib.rs action handler,
//! which owns this window's lifecycle.
//!
//! Mirrors the `copilot/context_window.rs` pattern: programmatic
//! `WebviewWindowBuilder`, single-bundle hash route, destroyed (not
//! hidden) on start/cancel so the next open is always fresh state.
//! Uses only cross-platform Tauri APIs — no `screencapturekit` — so
//! this module is not macOS-gated.

use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const RECORDER_PANEL_LABEL: &str = "recorder-panel";

// Sized to the white card (324 px) plus a transparent margin so the
// CSS drop shadow has room, and tall enough that the mic dropdown
// (the longest menu) renders fully inside the window bounds.
const PANEL_WIDTH: f64 = 360.0;
const PANEL_HEIGHT: f64 = 600.0;

/// Open the pre-record panel, centered on the primary display. If it's
/// already open, just refocus it.
pub fn open_recorder_panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(RECORDER_PANEL_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        RECORDER_PANEL_LABEL,
        WebviewUrl::App("index.html#/recorder".into()),
    )
    .title("Wolfee — Record")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
    .visible(false)
    .build()?;

    // Content protection: if the user opens the panel while already
    // screen-sharing something else, their setup UI shouldn't leak.
    // (The panel is also destroyed before our own capture starts.)
    if let Err(e) = window.set_content_protected(true) {
        log::warn!("[Recorder] panel set_content_protected failed: {e}");
    }

    center_on_primary(&window);
    window.show()?;
    let _ = window.set_focus();
    log::info!("[Recorder] pre-record panel opened");
    Ok(())
}

/// Destroy the panel window (start or cancel). Safe to call when the
/// panel isn't open.
pub fn close_recorder_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(RECORDER_PANEL_LABEL) {
        if let Err(e) = window.destroy() {
            log::warn!("[Recorder] panel destroy failed: {e}");
        } else {
            log::info!("[Recorder] pre-record panel closed");
        }
    }
}

fn center_on_primary<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    match window.primary_monitor() {
        Ok(Some(monitor)) => {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let w = (PANEL_WIDTH * scale) as i32;
            let h = (PANEL_HEIGHT * scale) as i32;
            let x = ((size.width as i32) - w) / 2;
            let y = ((size.height as i32) - h) / 2;
            if let Err(e) = window.set_position(PhysicalPosition { x, y }) {
                log::warn!("[Recorder] panel positioning failed: {e}");
            }
        }
        _ => log::warn!("[Recorder] no primary monitor — panel uses default position"),
    }
}
