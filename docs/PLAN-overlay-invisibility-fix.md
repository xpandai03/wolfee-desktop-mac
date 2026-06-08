# PLAN — Fix CoPilot overlay invisibility (welcome card + strip) for fresh installs

Status: pre-implementation. Owner: this session. Target: 0.5.2 hotfix.

## Root cause

The Sub-prompt 5.0 boot welcome flow emits `wolfee-action: "expand-overlay"` while the overlay's `WebviewWindow` is still hidden, causing `NSWindow.setContentSize` to mutate a hidden window's GPU-backed surface before its first `orderFront:` call. On macOS Sequoia + Tauri 2 + `transparent: true` + `set_content_protected(true)`, this leaves the WKWebView's surface in a detached state. When `show_overlay()` is later called (during session start or ⌘⌥W), the `NSWindow` orders-front but its content layer never repaints — user sees nothing.

The `expand-overlay` wolfee-action handler at [src-tauri/src/lib.rs:1758-1767](src-tauri/src/lib.rs#L1758-L1767) calls `expand_overlay` (which calls `set_size`) but **never calls `show_overlay`**. For fresh-install boot, the window stays hidden through the whole sequence, so the welcome card never appears either.

## Evidence

**Smoking-gun log line** captured in prior diagnostic on 0.5.0 build (verbatim, from running .app stderr capture `/tmp/wolfee-501-diag.log`):

```
[2026-05-05T04:50:14.262Z INFO  wolfee_desktop] [Copilot] Foundation initialized
[2026-05-05T04:50:14.859Z INFO  wolfee_desktop::copilot::window] [Copilot] Overlay content protection enabled
[2026-05-05T04:50:14.860Z INFO  wolfee_desktop::copilot] [Copilot] Foundation initialized — overlay window + hotkey ready
[2026-05-05T04:50:34.348Z DEBUG wolfee_desktop::copilot::window] [Copilot] overlay expanded to 600x520
```

The `overlay expanded to 600x520` line fires ~700ms after foundation init — driven entirely by the React side's boot listeners — before the user has interacted with anything and **before any `show_overlay()` call**. Window remained hidden when this resize happened.

**Code citations:**

1. [overlay/src/CopilotOverlay.tsx:361-379](overlay/src/CopilotOverlay.tsx#L361-L379) — boot listener emits `expand-overlay` whenever welcome flag is unset (every fresh install):
   ```js
   welcomeFlagUnlisten = await listen<{ shown: boolean }>(
     "welcome-flag-loaded", (event) => {
       dispatch({ type: "LOAD_WELCOME_FLAG", shown: event.payload.shown });
       if (!event.payload.shown) {
         dispatch({ type: "SHOW_WELCOME" });
         if (modeRef.current !== "expanded") {
           void emit("wolfee-action", "expand-overlay");   // ← fires while window still hidden
         }
       }
     },
   );
   void emit("wolfee-action", { type: "request-welcome-flag" });
   ```

2. [src-tauri/src/lib.rs:1758-1767](src-tauri/src/lib.rs#L1758-L1767) — handler resizes but doesn't show:
   ```rust
   "expand-overlay" => {
       if let Err(e) = copilot::window::expand_overlay(handle_ref) {
           log::warn!("[Copilot] expand_overlay failed: {}", e);
           return;
       }
       let _ = handle_ref.emit(
           "copilot-panel-state",
           serde_json::json!({ "mode": "expanded" }),
       );
   }
   ```

3. [src-tauri/src/copilot/window.rs:203-214](src-tauri/src/copilot/window.rs#L203-L214) — `expand_overlay` only resizes, never shows:
   ```rust
   pub fn expand_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
       let window = match app.get_webview_window(OVERLAY_LABEL) { ... };
       set_expanded_mode(&window)?;   // set_size — no show()
       log::debug!("[Copilot] overlay expanded to {}x{}", EXPANDED_WIDTH, EXPANDED_HEIGHT);
       Ok(())
   }
   ```

4. [src-tauri/src/copilot/window.rs:30-55](src-tauri/src/copilot/window.rs#L30-L55) — overlay built with `.visible(false)` (correct on its own; the bug is the resize-before-first-show pattern, not the initial hidden state):
   ```rust
   .inner_size(STRIP_WIDTH, STRIP_HEIGHT)
   .visible(false)
   ```

## Why it worked in 4.9 and broke in 5.0

- **4.9 (commit `a4dd611`)**: no welcome flow. Window stayed at 600×44 from `create_overlay_window` until first `show_overlay()` triggered by ⌘⌥W or session start. No pre-show resize → WKWebView surface attached cleanly on first show. Strip visible.
- **5.0 (commit `515e1f5`)**: introduced the welcome flow at [CopilotOverlay.tsx:361-379](overlay/src/CopilotOverlay.tsx#L361-L379). On every fresh install, React emits `expand-overlay` while window is still hidden → resize-while-hidden → surface corruption → window never visually renders even after later `show_overlay()`.
- **5.2 (commit `6b73848`)**: scoped welcome key by user_id. Did NOT change the auto-emit pattern. Bug persisted.

This regression is **only** in the boot welcome flow. ⌘⌥W toggle, tray "Open Copilot Overlay", session-start `show_overlay` — all unchanged from 4.9 — still call `show_overlay` cleanly and would work fine if the window hadn't been pre-corrupted.

## Fix scope (smallest possible diff)

**One-line semantic fix:** make the `expand-overlay` wolfee-action handler always call `show_overlay()` before `expand_overlay()`. This:
- Breaks the "resize-while-hidden" pattern (window is shown first → resize happens on a visible window → no surface corruption).
- Is idempotent for already-visible callers (welcome auto-fire, suggestion arrival, focus-input hotkey, new-thread hotkey, finalize takeover, permission-needed) — `window.show()` on an already-visible window is a no-op.
- Semantically correct: every caller of `expand-overlay` wants the user to SEE the panel anyway.

**File touched:** `src-tauri/src/lib.rs` — single function body, ~3 lines added.

**Estimated lines changed:** ≤5 net.

**Estimated commit count:** 2 (1 fix commit, 1 chore release commit for version bump).

## Risk surface

- `expand-overlay` is called from 7 sites across [CopilotOverlay.tsx]: welcome flow, suggestion auto-expand, focus-input hotkey, new-thread hotkey, finalize takeover, permission-needed, quick-action click. Adding an idempotent `.show()` to all of them = always correct behavior. No site wants a hidden window after expand.
- `collapse-overlay` is left untouched — it's only emitted from the strip's chevron button, which the user can only click when the window is already visible.
- `show_overlay()` itself unchanged — already in production since 4.6.
- No window config changes (`tauri.conf.json` untouched beyond the version line).
- No frontend logic changes — React side stays as-is.
- Welcome flag persistence + per-user scoping (SP5.2) untouched.

## Test strategy

**Dev-mode smoke (mandatory before .dmg build):**

```bash
# Wipe persistence
rm -rf "$HOME/Library/Application Support/io.wolfee.desktop"
# Run dev
RUST_LOG=debug pnpm tauri dev
```

8 checks:
1. Welcome card auto-appears on first launch with all 6 bullets ✓
2. "Got it" dismisses welcome card → strip visible ✓
3. Strip is visible idle (44px tall) ✓
4. ⌘⌥W toggles overlay visibility ✓
5. ⌘+\ toggles overlay visibility ✓
6. Apps-grid icon click — tested only after dismiss flips welcomeShown=true ✓
7. Session start → strip stays visible, expanded panel reachable ✓
8. Session stop → SessionCompleteCard renders ✓

**Production smoke after .dmg ships:** PO runs the full fresh-install path on a clean Mac (cleanup recipe shipped with final report).

## Rollback plan

If fix doesn't hold or surfaces unexpected breakage during dev smoke:
- `git revert` the fix commit; ship 0.5.2 reverted to 0.5.1 behavior
- Workaround for fresh users: pre-mark welcome as shown by writing `flags.json` directly (not user-facing but unblocks session start)
- Investigate alternative fix paths: (a) refactor welcome to be a strip-modal overlay rather than panel-bodyOverride, (b) move welcome auto-emit to fire AFTER first `show_overlay()` (e.g., on permission-checked or tray-click), (c) move welcome flow entirely Rust-side so window state machine owns visibility.

## Out of scope (noted for follow-up)

- Welcome card UX after dismiss — currently leaves user in expanded ExpandedPanel with empty chat tab (no session). Acceptable for V1 onboarding; consider auto-collapse to strip on dismiss in SP5.x.
- Strip lacks `shrink-0` ([Strip.tsx:50-69](overlay/src/components/Strip.tsx#L50-L69)) — not actually triggering the bug per H1 evidence, but a latent risk if welcome content forced a flex-shrink event. Leave for future hardening.
- `show_overlay()` is silent on failure (`window.show()?` returns Result but no panel-state event is emitted to React when this fires). Not a regression; not in scope.
