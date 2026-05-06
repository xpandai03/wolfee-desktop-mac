# Sub-prompt 6.0 — Onboarding Wizard + Tray Simplification — Plan

Status: pre-implementation. Owner: this session. Target: 0.6.0.

## Decisions

### Step count: **6**
Matches the PO spec verbatim. A compressed 5-step shape (merging permissions + session-setup) was considered but rejected — they're conceptually distinct ("permissions enables CoPilot to function" vs "modes choose what CoPilot does"), and squashing them would dilute the call-to-action on each. 6 steps stay.

### Pairing detection mechanism: **frontend polling via existing AppState.auth_token**
Existing flow ([src-tauri/src/auth.rs:124-178](src-tauri/src/auth.rs#L124-L178)): tray "Link with Wolfee…" opens browser → desktop's `link-poll` thread polls `/api/devices/<id>/status` every 2s for up to 120s → on success, persists `auth_token` + `user_id` to `auth.json` via `AuthConfig::save()` AND mutates `state.auth_token`/`state.user_id` mutexes ([lib.rs:1407-1424](src-tauri/src/lib.rs#L1407-L1424)).

For wizard Step 3 we'll add a new wolfee-action `request-auth-status` that reads the AppState mutex and emits `auth-status-loaded {paired: bool, user_id: Option<String>}`. Frontend polls this every 2s while on Step 3. When paired flips true, dispatch `PAIRING_COMPLETE` and auto-advance after 1.5s delay.

This re-uses the working AuthConfig path with zero changes; no new state machine.

### SVG illustration style
- Inline JSX SVG components (no asset bundling, no external files)
- Viewport: 280×140 (fits within ExpandedPanel ~520×460 content area with comfortable padding)
- Palette: `currentColor` for primary strokes (inherits from text-zinc-200), `text-copilot-accent` (#22D3EE) for accent strokes, `text-zinc-700` for secondary fills
- Stroke weight: 1.5px (1.25 for fine details)
- Style: line-art / stroke-based (NOT filled), low-detail, brand-aligned. No emojis embedded as artwork (emoji icons are OK as inline-text accents like in Step 2's flow row)
- All SVGs centralized in `overlay/src/components/onboarding/illustrations.tsx` for easy iteration

### Permission status check: **silent preflight via `objc2` + `core_graphics::access::ScreenCaptureAccess`**
Already-in-deps approach (no new crates):
- **Microphone**: `msg_send!` to `AVCaptureDevice.authorizationStatus(forMediaType: AVMediaTypeAudio)` — returns `AVAuthorizationStatus` (3 = Authorized). Silent, no prompt.
- **Screen Recording**: `ScreenCaptureAccess::default().preflight()` — already used in [permissions.rs:84](src-tauri/src/copilot/audio/permissions.rs#L84). Silent, no prompt.
- New wolfee-action `request-permission-status` → emits `permission-status-loaded {mic: PermStatus, screen: PermStatus}` where `PermStatus = "granted" | "denied" | "undetermined"`. Re-checks on window focus + every 5s while on Step 4.

## State machine (wizard reducer)

Wizard owns its own state inside the existing `OverlayState`. New fields:

```ts
interface OverlayState {
  // … existing fields …
  // Sub-prompt 6.0 — onboarding wizard
  onboardingOpen: boolean;          // wizard currently rendering
  onboardingStep: number;           // 1..6
  onboardingCompleted: boolean | null;  // null = not loaded yet
  pairingPolling: boolean;          // Step 3 — true while polling auth-status
  permissionStatus: {                // Step 4 — silent check results
    mic: "granted" | "denied" | "undetermined" | null;
    screen: "granted" | "denied" | "undetermined" | null;
  };
}
```

Actions:
- `LOAD_ONBOARDING_FLAG`: `{ completed: boolean; lastStep: number }` — boot read from `flags.json`
- `SHOW_ONBOARDING`: opens wizard, sets step to lastStep || 1
- `ADVANCE_STEP`: step++, clamped to 6
- `PREV_STEP`: step--, clamped to 1
- `JUMP_TO_STEP`: `{ step: number }` (used by PAIRING_COMPLETE auto-advance)
- `SKIP_TOUR`: marks completed, closes
- `COMPLETE_ONBOARDING`: marks completed, closes (Step 6 "Get started")
- `SET_PAIRING_POLLING`: `{ polling: boolean }`
- `PAIRING_COMPLETE`: `{ user_id: string }` — auto-advances Step 3 → Step 4 after 1.5s delay
- `SET_PERMISSION_STATUS`: `{ mic, screen }`

Persistence (via existing tauri-plugin-store `flags.json`):
- `wolfee_onboarding_completed_v1_<user_id|unpaired>` — boolean, written on COMPLETE_ONBOARDING / SKIP_TOUR
- `wolfee_onboarding_last_step_v1_<user_id|unpaired>` — number, written on every ADVANCE_STEP (so quit-mid-tour resumes correctly)

bodyOverride precedence (updated): Permission > SessionComplete > **Onboarding** > Welcome (legacy, deprecated). Onboarding sits above legacy welcome since the wizard supersedes it.

## File map

### New files
- `overlay/src/components/onboarding/OnboardingWizard.tsx` — top-level wizard component, dispatches NEXT/PREV/SKIP/COMPLETE
- `overlay/src/components/onboarding/illustrations.tsx` — 6 inline SVG components keyed by step
- `overlay/src/components/onboarding/wizardCopy.ts` — title + body + CTAs per step (centralized for iteration)
- `overlay/src/components/onboarding/StepLayout.tsx` — shared frame: header, illustration slot, body slot, footer with Continue/Back/Skip
- `overlay/src/components/onboarding/Step3Pairing.tsx` — polling + auto-advance logic
- `overlay/src/components/onboarding/Step4Permissions.tsx` — live status indicators + System Settings deeplinks

### Modified files
- `overlay/src/state/types.ts` — extend OverlayState + Action union with onboarding fields/actions
- `overlay/src/state/overlayReducer.ts` — handle new actions
- `overlay/src/CopilotOverlay.tsx` — mount OnboardingWizard via bodyOverride; remove WelcomeCard auto-show wiring; add new event listeners (`onboarding-flag-loaded`, `auth-status-loaded`, `permission-status-loaded`); replace handleAppsClick replay-welcome path with replay-onboarding
- `src-tauri/src/lib.rs` — three new wolfee-action handlers (`request-onboarding-flag`, `mark-onboarding-completed`, `mark-onboarding-step`, `request-auth-status`, `request-permission-status`); new `show-onboarding` handler; remove `start-recording`/`stop-recording` from match (keep recorder.rs intact, just unwire)
- `src-tauri/src/tray.rs` — remove RecordingState block (lines 353-383), remove `start`/`stop` handlers, add `copilot_show_onboarding` MenuItem after copilot_setup, add handler emitting `show-onboarding`
- `src-tauri/src/Cargo.toml` — version bump 0.5.2 → 0.6.0
- `src-tauri/tauri.conf.json` — version bump
- `package.json` — version bump
- `WOLFEE-MVP/server/routes.ts` — DESKTOP_VERSION + DESKTOP_SIZE bump

### Deleted files
- None. WelcomeCard component file kept as legacy (cheap; nothing else references it after wiring removal). Tray recording handlers removed but recorder.rs module preserved per spec.

## Tray menu changes (MenuBuilder diff)

**Before** ([tray.rs:353-383](src-tauri/src/tray.rs#L353-L383)):
```rust
match state {
    RecordingState::Recording => { status + Stop Recording  ⌘⌥Space }
    RecordingState::Stopping  => { Saving recording... }
    RecordingState::Uploading => { ↑ Uploading... }
    RecordingState::Complete  => { ✓ Uploaded! + Open in Wolfee }
    RecordingState::Idle      => { Start Recording  ⌘⌥Space }
}
```

**After**: entire match block deleted. Recording state still exists in AppState for future re-wiring; tray simply doesn't surface it.

**New entry added** in the copilot block (after `copilot_setup` at line 217):
```rust
let show_tour = MenuItem::with_id(app, "copilot_show_onboarding", "Show Onboarding Tour", true, None::<&str>)?;
menu.append(&show_tour)?;
```

**handle_menu_event**:
- Remove `"start"` and `"stop"` arms (lines 458-465)
- Add `"copilot_show_onboarding"` arm: `let _ = app.emit("wolfee-action", "show-onboarding");`

**Hotkey:** ⌘⌥Space was a label-only string, never registered as a global Shortcut ([hotkey.rs](src-tauri/src/copilot/hotkey.rs) confirmed — only KeyW/KeyG/Backslash/Enter/KeyN/arrows). No `unregister` call needed.

## Step-by-step implementation order (commits)

1. `docs(plan): onboarding wizard + tray simplification (0.6.0)` — this file
2. `feat(overlay): scaffold OnboardingWizard component + reducer state` — types.ts + reducer + StepLayout + empty wizard skeleton
3. `feat(overlay): wizard step content + 6 SVG illustrations + copy file`
4. `feat(copilot): rust handlers for onboarding flag + auth-status + permission-status`
5. `feat(overlay): wire pairing polling + auto-advance on Step 3`
6. `feat(overlay): wire permission live-status + recheck on focus on Step 4`
7. `feat(overlay): wire onboarding persistence + bodyOverride precedence`
8. `feat(tray): remove Start Recording entries, add Show Onboarding Tour`
9. `chore: remove WelcomeCard auto-show (superseded by wizard)`
10. `chore(release): bump to 0.6.0 — onboarding wizard`

## Risk surface

- **Pairing race**: user pairs in another tab while wizard is open on Step 3. Mitigation: poll every 2s via the same AppState the link-poll thread writes to; PAIRING_COMPLETE is idempotent (no-op if already on Step 4+).
- **Permission re-check on focus**: Tauri 2's window-focus event isn't trivially exposed to JS. Use a 5s poll while on Step 4 + a manual "Recheck" button as backup. Acceptable for the use case (user is moving between Wolfee + System Settings, 5s lag is fine).
- **Old welcome flag interaction**: `wolfee_welcome_shown_v1_*` becomes legacy. The wizard checks its OWN flag (`onboarding_completed_v1_*`). Existing 0.5.2 users see the wizard once even if welcome was previously dismissed. PO accepted this.
- **Tray menu rebuild during session**: `update_tray_menu` is called on every state transition. Adding `copilot_show_onboarding` to the static block (always present) avoids state-conditional rebuild bugs.
- **AVCaptureDevice msg_send! ABI**: returns NSInteger which is `isize` on 64-bit. Map to `i64` in Rust binding. Tested at runtime in dev smoke before .dmg build.
- **0.5.2 overlay invisibility fix regression**: the wizard mounts via the same bodyOverride pattern that already works post-fix. Strip is rendered unconditionally. No regression vector identified.

## Test strategy

### Dev-mode smoke gate (15 checks, all must pass)

```bash
rm -rf "$HOME/Library/Application Support/io.wolfee.desktop"
RUST_LOG=debug pnpm tauri dev
```

1. ✅ Wizard auto-appears on first launch — Step 1 visible with SVG + Continue + Skip
2. ✅ Continue advances to Step 2; SVG + 3-phase flow renders
3. ✅ Step 3 "Open Wolfee to link" opens browser to correct pairing URL
4. ✅ When pairing completes in browser, Step 3 auto-advances to Step 4 within 5s
5. ✅ Step 4 shows live permission status (granted ✅ / needed ⚠️) for both Mic + Screen Recording
6. ✅ "Open System Settings" deep-link works for both permissions
7. ✅ When user grants permission and returns to app, status updates within 5s (poll cadence)
8. ✅ Step 5 "Open session setup" opens correct web URL
9. ✅ Step 6 Continue closes wizard + marks complete
10. ✅ Restart app — wizard does NOT re-appear (completion flag persisted)
11. ✅ Tray menu → "Show Onboarding Tour" → wizard re-opens at Step 1
12. ✅ Tray menu has NO "Start Recording" entry, NO ⌘⌥Space hotkey response
13. ✅ ⌘⌥W still toggles overlay (regression vs 0.5.2)
14. ✅ Session start from web app → strip stays visible + expanded reachable (regression vs 0.5.2)
15. ✅ Skip tour on any step marks complete + closes; restart confirms no re-show

### Production smoke (PO drives after .dmg ships)
Paranoid wipe + reinstall + 15 checks above on the published 0.6.0 .dmg.

## Rollback plan

If the wizard regresses 0.5.2 strip-rendering or the tray simplification surfaces a recorder coupling we missed:
- `git revert` the failing commits (each commit is logically isolated)
- Worst case: `git reset --hard <0.5.2 commit>` and rebuild 0.5.2 .dmg
- 0.5.2 .dmg is preserved on R2 history (Cloudflare retains versioned objects); fall back to that key if needed

## Out of scope (flagged for future)

- Animated SVG illustrations / Lottie — V2 polish; static SVGs ship V1
- Onboarding deep-links from web app (e.g. `wolfee://onboarding/step/4`) — V2; for now web hands users back to desktop and they navigate manually
- Per-step analytics (which step users abandon at) — needs telemetry infra; deferred
- Onboarding restart from settings (vs only tray) — apps-grid icon path could replay too; assess after dogfooding
- WelcomeCard component file deletion — leaving in place for cheap; if noisy in future cleanup pass, delete then
