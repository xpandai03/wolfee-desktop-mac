//! Custom-region drag-select overlay (recorder — Phase 1 source picker).
//!
//! A full-display, frameless, transparent, **content-protected**
//! webview (`#/region-selector`) the user drags a rectangle on. It is
//! content-protected so the selection chrome (dimming, marquee,
//! buttons) is never itself captured. The window covers the primary
//! display; its CSS/logical coordinates are therefore display-local
//! logical points, which on macOS equal SCK `content_rect` points — so
//! the rect the front-end reports needs no Retina conversion before it
//! becomes a `RegionRect` (see `lib.rs` `region-selected`).
//!
//! Lifecycle: opened by the `open-region-selector` action; the React
//! page emits `region-selected` (confirm) or `close-region-selector`
//! (cancel), both of which tear the window down.

#![cfg(target_os = "macos")]

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder,
};

pub const REGION_SELECTOR_LABEL: &str = "region-selector";

/// Open the region selector on the primary display. Idempotent.
pub fn open_region_selector<R: Runtime>(app: &AppHandle<R>) {
    let a = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = build(&a) {
            log::error!("[Region] build failed: {e}");
        }
    }) {
        log::error!("[Region] dispatch failed: {e}");
    }
}

/// Destroy the region selector. Safe to call when it isn't open.
pub fn close_region_selector<R: Runtime>(app: &AppHandle<R>) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = a.get_webview_window(REGION_SELECTOR_LABEL) {
            let _ = window.destroy();
        }
    });
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(REGION_SELECTOR_LABEL).is_some() {
        return Ok(());
    }

    // Echo the SCK display_id into the URL so the page reports back the
    // exact display it selected on (correct for multi-display).
    let display_id = super::sources::primary_display_id().unwrap_or(0);
    let url = format!("index.html#/region-selector?display={display_id}");

    let window = WebviewWindowBuilder::new(
        app,
        REGION_SELECTOR_LABEL,
        WebviewUrl::App(url.into()),
    )
    .title("Wolfee — Select region")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(true)
    .visible(false)
    .build()?;

    // Content-protected — the marquee/dimming/buttons must not appear in
    // the recording the user is about to make.
    if let Err(e) = window.set_content_protected(true) {
        log::warn!("[Region] set_content_protected failed: {e}");
    }

    // Cover the full primary display.
    if let Ok(Some(m)) = window.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size();
        let pos = m.position();
        let _ = window.set_position(PhysicalPosition { x: pos.x, y: pos.y });
        let _ = window.set_size(LogicalSize::new(
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
        ));
    }

    window.show()?;
    let _ = window.set_focus();
    log::info!("[Region] selector opened (display_id={display_id})");
    Ok(())
}
