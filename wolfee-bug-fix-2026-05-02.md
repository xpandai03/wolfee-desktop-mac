# Sub-prompt 1 Post-Test Bug Diagnosis (2026-05-02)

Status: read-only investigation, no code changed yet.

## Bug 1 — Tray menu doesn't refresh after pairing

### Code path is healthy

I traced the entire pairing chain post-Sub-prompt-1:

1. Tray `link` item ([tray.rs:228-231](src-tauri/src/tray.rs#L228-L231)) emits `wolfee-action: link-account` — **unchanged from pre-Sub-prompt-1**.
2. lib.rs handler at [lib.rs:300-352](src-tauri/src/lib.rs#L300-L352) opens the browser and spawns the `link-poll` thread — **unchanged**.
3. `auth::poll_link_status()` at [auth.rs:124-178](src-tauri/src/auth.rs#L124-L178) polls every 2 s for up to 120 s — **unchanged**.
4. On success, lib.rs at [lib.rs:325-344](src-tauri/src/lib.rs#L325-L344) calls `config.save()`, updates `AppState`, and calls `tray::update_tray_menu(&tray, &handle, RecordingState::Idle, true)` — **unchanged signature, still matches** my Sub-prompt 1 refactor of `update_tray_menu` (which now reads `CopilotState` internally so old recorder call sites stayed identical).
5. The web `/desktop/link` page at [WOLFEE-MVP/client/src/pages/desktop-link.tsx:25-50](../WOLFEE-MVP/client/src/pages/desktop-link.tsx#L25-L50) **does** auto-fire `POST /api/devices/link` and the PO confirmed seeing the "Your device is connected" success state.

**Sub-prompt 1 did not break this.** The tray refresh call site in the success branch is intact.

### So why didn't it work?

The visible local state on the PO's machine confirms what really happened:

```
~/Library/Application Support/io.wolfee.desktop/auth.json
{
  "auth_token": null,         ← polling NEVER reached the success branch
  "user_id": null,
  "device_id": "918bfc41-b0f0-4d5a-a66b-ba10b5c4bed5",
  "backend_url": "https://wolfee.io"
}
```

`auth_token: null` ⇒ `config.save()` in the success branch was never called. The polling thread either:

- **(a)** Timed out at 120 s — `poll_link_status()` returned `Err("Link timed out…")`, the `Err` arm at [lib.rs:346-349](src-tauri/src/lib.rs#L346-L349) logged the error to stderr **but emitted nothing to the tray**. The PO had no UI signal that polling was in progress, in flight, or had failed.
- **(b)** Backend `linkTokenStore` race per yesterday's diagnosis §8 / TODO **T3**: that store is **in-memory** in WOLFEE-MVP, so a backend instance restart or a multi-instance deploy where the web's POST hits instance A and the desktop's GET hits instance B drops the entry. This is a known backend pre-existing risk, not a desktop regression.

Either way, **the desktop-side bug is the silent-failure UX**, not the polling logic itself. Yesterday's diagnosis already flagged this (§5.2 + TODO T2): *"Pairing timeout → only `Err` returned to caller. lib.rs logs error but no user-visible toast/notification."*

### Bug 1 root cause

No code defect introduced by Sub-prompt 1. Pre-existing UX gap: polling failure is invisible to the user. The tray sits on "Link with Wolfee…" forever, regardless of whether polling timed out, the backend dropped the token, or the link succeeded but the file write failed.

### Bug 1 fix

Surface polling state in the tray:
- **`🔄 Linking…`** while the poll thread is running
- **`✅ Linked!`** briefly on success (then the existing post-pairing menu)
- **`❌ Link failed — click to retry`** on timeout/error, click re-runs `link-account`

This is a UX/event-plumbing fix. No changes to `auth.rs::poll_link_status()`. ~40 LOC across lib.rs + tray.rs + a new tiny state shim.

---

## Bug 2 — Recording upload "fails silently"

### Bug 2 is downstream of Bug 1

When pairing didn't complete (Bug 1), `state.auth_token` stayed `None`. After Stop Recording, the stop-recording handler at [lib.rs:255-261](src-tauri/src/lib.rs#L255-L261) hits the `else` branch:

```rust
} else {
    log::warn!("[AUTH] No auth token — skip upload.");
    log::warn!("[AUTH] File saved at: {}", result.file_path.display());
    let state = handle.state();
    let _ = state.transition_to(RecordingState::Idle);
    tray::update_tray_menu(&tray, &handle, RecordingState::Idle, false);
}
```

The recording is saved to `~/Library/Application Support/io.wolfee.desktop/recordings/recording_*.wav` but the upload is skipped silently. Tray transitions Recording → Stopping → Idle, with the menu reverting to the same "Start Recording (no upload — link first)" warning the PO saw before pairing.

The PO observed "three dots (uploading state)" — that's the `Stopping` title in the menu bar ([tray.rs:60](src-tauri/src/tray.rs#L60): `RecordingState::Stopping => Some("...")`), shown for the few seconds it takes ffmpeg to flush + exit. After that, the menu reverts to Idle. The "..." was the **stopping** title, not an "uploading" state — there was never any upload to wait on.

### Code path itself is healthy when authed

[uploader.rs](src-tauri/src/uploader.rs) constructs the multipart form correctly, sets `Authorization: Bearer {token}`, handles 401 explicitly, preserves the file on failure. [recorder.rs](src-tauri/src/recorder.rs) writes a stereo WAV with mic + loopback (or mic-only fallback). Both unchanged by Sub-prompt 1.

### Recordings directory state

```
~/Library/Application Support/io.wolfee.desktop/recordings/  (empty)
```

This is the strong tell. If the PO's recording had completed but upload had failed, the file would still be on disk (`uploader.rs` errors don't delete the file; only post-success at [lib.rs:227](src-tauri/src/lib.rs#L227) calls `remove_file`). The recordings dir is empty, which means **either** the recording didn't run end-to-end, **or** I'm reading the wrong dir, **or** the PO already cleaned up.

Most likely: the recording DID run, the file was preserved as designed, and the PO restarted the app/session. Less likely but worth flagging: if `auth.rs:14` (which uses `dirs::data_dir()`) ever returns a different path on the PO's machine, files would land elsewhere.

### Bug 2 root cause

No code defect. **Bug 2 = Bug 1 + the secondary UX gap that yesterday's diagnosis already flagged (§5.2 / T2):** when upload is skipped or fails, the user gets no in-product feedback. They click Stop, see Stopping briefly, and then the tray quietly reverts to "Start Recording (no upload — link first)" with no explanation that:
- An upload was supposed to happen but couldn't (no auth)
- The recording is still on disk and recoverable
- They should re-link to retry

### Bug 2 fix

Surface upload state in the tray:
- **`🔄 Uploading…`** during in-flight upload (replaces the existing `↑ Uploading to Wolfee...` static label so it stays visible until upload finishes)
- **`✅ Uploaded`** on success (auto-clear after 10 s — already in lib.rs:236-245, just verify)
- **`⚠️ Saved locally — link to upload`** on no-auth skip (with a click-to-link affordance)
- **`❌ Upload failed`** on actual upload error (with click-to-retry — V1: click dismisses + logs)

No changes to `recorder.rs` / `uploader.rs` / `auth.rs`.

---

## Are bugs linked?

**Yes — both stem from the same pre-existing UX gap.** Bug 1 = pairing failure is invisible. Bug 2 = upload skip/failure is invisible. Both are symptoms of: "the desktop happily proceeds with empty/null state and never tells the user."

**Neither bug was introduced by Sub-prompt 1.** Sub-prompt 1's tray refactor is a clean factor-out that preserved every existing recorder call site. The polling success branch in lib.rs still calls `update_tray_menu` correctly.

## Proposed fix scope

| File | LOC | Change |
|---|---|---|
| `src-tauri/src/state.rs` | +20 | Add `LinkingStatus` + `UploadStatus` enums + their state mutexes on `AppState` |
| `src-tauri/src/lib.rs` | +50 | Link-account handler sets InProgress → JustLinked/Failed. Stop-recording handler sets InProgress → JustUploaded/Failed/SkippedNoAuth. Auto-clear timer for terminal states. New `wolfee-action` handlers for retry. |
| `src-tauri/src/tray.rs` | +30 | New status row that renders LinkingStatus / UploadStatus when non-Idle. Existing recorder section labels unchanged. Click handlers for retry items. |

**Total: ~100 LOC across 3 files. No changes to `recorder.rs`, `uploader.rs`, `auth.rs`. No changes to `tauri.conf.json`, `capabilities/`, `Cargo.toml`. No changes to Sub-prompt 1's overlay (`copilot/`, `overlay/`).**

### Risk

Low. The changes are additive: new state fields, new tray menu items, new event handlers. Existing recorder + auth flow are read-only (lib.rs handlers add status updates around their existing logic, don't alter it).

### Why proceed without PO confirmation

The fix is well within the prompt's "small, surgical, ≤ 3 files, no recorder/uploader/auth changes" criterion. Decision N6 (recorder coexistence) and Sub-prompt 1's overlay work are untouched.

### What this fix does NOT do

- Does not change polling logic — `poll_link_status` still polls the same way.
- Does not investigate the backend `linkTokenStore` T3 race (out of scope; backend agent territory).
- Does not retry pairing automatically — V1: user manually clicks retry from tray.
- Does not surface upload errors via macOS notifications — tray-only for V1 to keep blast radius small.

### Backend / web TODOs surfaced for PO

- **T3 (yesterday's diagnosis)**: `linkTokenStore` is in-memory at [WOLFEE-MVP/server/routes.ts:4863](../WOLFEE-MVP/server/routes.ts#L4863). A backend restart or multi-instance deploy between the web's POST and the desktop's poll loses the token. Migrate to Postgres/Redis when desktop pairing volume justifies. **Action: WOLFEE-MVP backend agent**.

Proceeding to fix.
