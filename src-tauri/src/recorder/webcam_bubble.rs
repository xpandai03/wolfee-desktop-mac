//! Floating webcam bubble window (recorder — iteration 3).
//!
//! A frameless, transparent, always-on-top circular window showing the
//! presenter's camera. Unlike the panel and (future) control bar, the
//! bubble is **deliberately NOT content-protected** — it must appear
//! in ScreenCaptureKit's output so viewers see the presenter's face in
//! the recorded video, exactly like Loom's bubble.
//!
//!   panel / control bar → `set_content_protected(true)` → hidden from capture
//!   webcam bubble        → no content protection         → captured ✅
//!
//! The bubble is opened when the user turns the camera on in the
//! panel, persists through recording after the panel closes, and is
//! destroyed on stop / cancel / camera-off. It is the only window
//! that calls `getUserMedia`, so there is no camera contention.

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder,
};

pub const WEBCAM_BUBBLE_LABEL: &str = "webcam-bubble";

/// Transparent margin around the circle so its drop shadow has room.
const MARGIN: f64 = 14.0;

/// Circle diameter (logical px) for each size.
fn bubble_px(size: &str) -> f64 {
    match size {
        "small" => 120.0,
        "large" => 320.0,
        _ => 200.0, // medium (default)
    }
}

/// Window side length = circle + shadow margin on both sides.
fn window_px(size: &str) -> f64 {
    bubble_px(size) + MARGIN * 2.0
}

/// Open the webcam bubble (default: medium, bottom-left). Idempotent.
pub fn open_webcam_bubble<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(WEBCAM_BUBBLE_LABEL) {
        let _ = existing.show();
        return Ok(());
    }

    let win = window_px("medium");
    let window = WebviewWindowBuilder::new(
        app,
        WEBCAM_BUBBLE_LABEL,
        WebviewUrl::App("index.html#/webcam-bubble".into()),
    )
    .title("Wolfee Camera")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false) // never steal focus from what the user is presenting
    .inner_size(win, win)
    .visible(false)
    .build()?;

    // ⚠️ Intentionally NO set_content_protected — the bubble MUST be
    // captured by ScreenCaptureKit so the face is in the recording.

    position_bottom_left(&window, win);
    window.show()?;
    log::info!("[Bubble] webcam bubble opened");
    Ok(())
}

/// Destroy the bubble. Safe to call when it isn't open.
pub fn close_webcam_bubble<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WEBCAM_BUBBLE_LABEL) {
        if let Err(e) = window.destroy() {
            log::warn!("[Bubble] destroy failed: {e}");
        } else {
            log::info!("[Bubble] webcam bubble closed");
        }
    }
}

/// Resize the bubble (small/medium/large), keeping its center fixed so
/// it grows/shrinks in place rather than from a corner.
pub fn resize_webcam_bubble<R: Runtime>(app: &AppHandle<R>, size: &str) {
    let Some(window) = app.get_webview_window(WEBCAM_BUBBLE_LABEL) else {
        return;
    };
    let win_logical = window_px(size);
    let scale = window.scale_factor().unwrap_or(2.0);
    let new_phys = (win_logical * scale) as i32;

    // Capture the old center before resizing.
    let center = match (window.outer_position(), window.outer_size()) {
        (Ok(pos), Ok(sz)) => Some((
            pos.x + sz.width as i32 / 2,
            pos.y + sz.height as i32 / 2,
        )),
        _ => None,
    };

    if let Err(e) = window.set_size(LogicalSize::new(win_logical, win_logical)) {
        log::warn!("[Bubble] resize failed: {e}");
        return;
    }
    if let Some((cx, cy)) = center {
        let _ = window.set_position(PhysicalPosition {
            x: cx - new_phys / 2,
            y: cy - new_phys / 2,
        });
    }
    log::info!("[Bubble] resized to {size}");
}

/// Default placement: bottom-left of the primary display.
fn position_bottom_left<R: Runtime>(window: &tauri::WebviewWindow<R>, win_logical: f64) {
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let msize = monitor.size();
        let mpos = monitor.position();
        let wp = (win_logical * scale) as i32;
        let margin = (28.0 * scale) as i32;
        let x = mpos.x + margin;
        let y = mpos.y + msize.height as i32 - wp - margin;
        if let Err(e) = window.set_position(PhysicalPosition { x, y }) {
            log::warn!("[Bubble] positioning failed: {e}");
        }
    }
}
