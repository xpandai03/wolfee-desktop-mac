use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_LABEL: &str = "copilot-overlay";

// Sub-prompt 4.6 (Cluely 1:1 redesign): single window with two
// dynamically-sized modes. Strip is the always-visible thin bar at
// the top of the screen (5 controls + status); Expanded reveals the
// Chat/Transcript panel underneath. Same window — `set_size` flips
// between them so the position stays stable on expand/collapse.
const STRIP_WIDTH: f64 = 600.0;
const STRIP_HEIGHT: f64 = 44.0;
const EXPANDED_WIDTH: f64 = 600.0;
const EXPANDED_HEIGHT: f64 = 520.0;
const TOP_MARGIN: f64 = 24.0;

pub fn create_overlay_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        log::info!("[Copilot] Overlay window already exists — skipping create");
        return Ok(());
    }

    // Note: Tauri 2's `transparent(true)` requires the `macos-private-api` feature
    // (uses Apple private APIs). We ship Sub-prompt 1 with a solid dark backdrop;
    // Sub-prompt 4 (UI polish) can opt in to private-API transparency if the design
    // calls for it.
    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Wolfee Copilot")
        .decorations(false)
        .always_on_top(true)
        // Critical for the "fullscreen Zoom/Meet" use case: by default,
        // each macOS fullscreen app gets its own Space, and an
        // always-on-top window from the default Space won't render
        // there. visible_on_all_workspaces=true sets the macOS
        // NSWindowCollectionBehaviorCanJoinAllSpaces +
        // NSWindowCollectionBehaviorFullScreenAuxiliary flags so the
        // overlay floats over fullscreen apps regardless of Space.
        // Surfaced by Sub-prompt 4 verification 2026-05-03 — PO had
        // Zoom in fullscreen, overlay only appeared on the home Space.
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        // Sub-prompt 4.6 — must be resizable for the strip→expanded
        // transition. We still hide the resize affordance (no
        // decorations + invisible-by-default border) so the user
        // never sees a resize handle.
        .resizable(true)
        .inner_size(STRIP_WIDTH, STRIP_HEIGHT)
        .visible(false)
        .focused(false)
        .shadow(false)
        .build()?;

    // Critical: the whole point of this window is content protection during screen share.
    // If this call fails we still build the window (some macOS setups may not honor it,
    // surfaced via Risk #2 in the design doc), but we log loudly so it's never a silent fail.
    if let Err(e) = overlay.set_content_protected(true) {
        log::error!("[Copilot] set_content_protected failed: {}", e);
    } else {
        log::info!("[Copilot] Overlay content protection enabled");
    }

    // Sub-prompt 4 fix 2026-05-03 — bump NSWindow level above
    // fullscreen apps. visible_on_all_workspaces=true (set on the
    // builder above) handles Spaces, but Tauri's `always_on_top`
    // only sets NSFloatingWindowLevel (3) which is below the level
    // fullscreen apps render at. We elevate to
    // NSScreenSaverWindowLevel (1000) — the level macOS uses for
    // the volume HUD and other system-wide overlays that float
    // above fullscreen content.
    #[cfg(target_os = "macos")]
    elevate_window_level(&overlay);

    position_top_center(&overlay);

    Ok(())
}

#[cfg(target_os = "macos")]
fn elevate_window_level<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // NSScreenSaverWindowLevel = CGShieldingWindowLevel - 1 = 1000.
    // Tauri's `WindowLevel` enum tops out at AlwaysOnTop which maps
    // to NSFloatingWindowLevel (3) — too low for fullscreen apps.
    const NS_SCREEN_SAVER_WINDOW_LEVEL: i64 = 1000;

    // NSWindowCollectionBehavior bit-mask. Tauri 2's
    // `visible_on_all_workspaces(true)` builder call doesn't always
    // include `FullScreenAuxiliary` — verified empirically on
    // 2026-05-03: PO had Chrome in fullscreen and overlay still
    // opened on the home Space. Setting the flags directly via
    // setCollectionBehavior: bypasses Tauri's abstraction.
    //
    //   CanJoinAllSpaces       (1 << 0 = 1)   — visible in every Space
    //   Stationary             (1 << 4 = 16)  — doesn't auto-move between Spaces
    //   IgnoresCycle           (1 << 6 = 64)  — excluded from Cmd-` window cycle
    //   FullScreenAuxiliary    (1 << 8 = 256) — renders on fullscreen-app Spaces
    //
    // FullScreenAuxiliary is the critical flag for the fullscreen
    // overlay use case — same bit Apple's volume HUD uses.
    const NS_COLLECTION_BEHAVIOR: usize = 1 | 16 | 64 | 256;

    let ns_window_ptr = match window.ns_window() {
        Ok(p) => p,
        Err(e) => {
            log::warn!(
                "[Copilot] elevate_window_level: ns_window() failed: {} — overlay may not show over fullscreen apps",
                e
            );
            return;
        }
    };

    // SAFETY: ns_window() returns a non-null pointer to a valid
    // NSWindow instance owned by the macOS runtime. Both setLevel:
    // and setCollectionBehavior: are documented NSWindow methods
    // that take NSInteger / NSWindowCollectionBehavior (NSUInteger)
    // and return void. We're not retaining / releasing — just
    // calling. msg_send! is the canonical bridge.
    unsafe {
        let ns_window = ns_window_ptr as *mut AnyObject;
        let _: () = msg_send![ns_window, setLevel: NS_SCREEN_SAVER_WINDOW_LEVEL];
        let _: () = msg_send![ns_window, setCollectionBehavior: NS_COLLECTION_BEHAVIOR];
    }
    log::info!(
        "[Copilot] Overlay window level={} + collection_behavior=0x{:X}",
        NS_SCREEN_SAVER_WINDOW_LEVEL,
        NS_COLLECTION_BEHAVIOR
    );
}

fn position_top_center<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let monitor = match window.primary_monitor() {
        Ok(Some(m)) => m,
        _ => {
            log::warn!("[Copilot] No primary monitor — overlay using default position");
            return;
        }
    };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let window_px = (STRIP_WIDTH * scale) as i32;
    let x = ((size.width as i32) - window_px) / 2;
    let y = (TOP_MARGIN * scale) as i32;
    if let Err(e) = window.set_position(PhysicalPosition { x, y }) {
        log::warn!("[Copilot] Failed to position overlay: {}", e);
    }
}

pub fn show_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => {
            log::error!("[Copilot] show_overlay: overlay window not found");
            return Ok(());
        }
    };
    // Sub-prompt 4.6: always restore to strip mode on show. Don't
    // re-position: Cluely lets the user drag the window anywhere
    // and expects it to stay there for the session. We only
    // re-center on a fresh app launch (the build phase above).
    let _ = set_strip_mode(&window);
    window.show()?;
    // 2026-05-04: do NOT call set_focus(). The overlay should appear
    // ON TOP of whatever the user is working in (Chrome, Zoom, etc.)
    // without stealing keyboard focus from that app.
    Ok(())
}

pub fn hide_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window.hide()?;
    }
    Ok(())
}

pub fn is_overlay_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(OVERLAY_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

// ── Sub-prompt 4.6: strip / expanded mode helpers ───────────────────

fn set_strip_mode<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    window.set_size(LogicalSize::new(STRIP_WIDTH, STRIP_HEIGHT))?;
    Ok(())
}

fn set_expanded_mode<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    window.set_size(LogicalSize::new(EXPANDED_WIDTH, EXPANDED_HEIGHT))?;
    Ok(())
}

/// Grow the overlay to expanded mode (~600×520). Idempotent — calling
/// twice is harmless. Position stays put (no re-center) so the user's
/// drag is preserved.
pub fn expand_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => {
            log::warn!("[Copilot] expand_overlay: window not found");
            return Ok(());
        }
    };
    set_expanded_mode(&window)?;
    log::debug!("[Copilot] overlay expanded to {}x{}", EXPANDED_WIDTH, EXPANDED_HEIGHT);
    Ok(())
}

/// Shrink the overlay back to strip mode (~600×44). Idempotent.
pub fn collapse_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => {
            log::warn!("[Copilot] collapse_overlay: window not found");
            return Ok(());
        }
    };
    set_strip_mode(&window)?;
    log::debug!("[Copilot] overlay collapsed to {}x{}", STRIP_WIDTH, STRIP_HEIGHT);
    Ok(())
}

/// Sub-prompt 4.6 — Ctrl+Arrow accessibility repositioning. Moves the
/// overlay window by `dx`/`dy` physical pixels. Bounds-checked against
/// the primary monitor so the user can't accidentally drag it off
/// screen.
pub fn nudge_overlay<R: Runtime>(app: &AppHandle<R>, dx: i32, dy: i32) -> tauri::Result<()> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => return Ok(()),
    };
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    let mut new_x = pos.x + dx;
    let mut new_y = pos.y + dy;

    // Clamp to monitor bounds — leave at least 20px of the window
    // on screen so the user always has a drag handle.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let m = monitor.size();
        let min_visible: i32 = 20;
        new_x = new_x
            .max(min_visible - size.width as i32)
            .min(m.width as i32 - min_visible);
        new_y = new_y
            .max(0)
            .min(m.height as i32 - min_visible);
    }

    window.set_position(PhysicalPosition { x: new_x, y: new_y })?;
    Ok(())
}
