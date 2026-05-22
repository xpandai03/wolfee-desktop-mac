# Loom Recorder 0.8.0 — Two-Bug Diagnosis

**Date:** 2026-05-21
**Reported:** (1) 401 on video upload; (2) recording "seemed audio-only".
**Outcome:** Bug 1 is real — a **web-app-only** fix (desktop is already correct). Bug 2 is a **misdiagnosis** — the recorder captures screen video correctly. **No desktop code changes.**

---

## Bug 2 — "audio-only recording" → NOT A BUG ✅

The user's failed test left its recording on disk (the 401 keeps the local file). Inspected it directly:

`~/Library/Application Support/io.wolfee.desktop/recordings/screen_2026-05-21T22-15-01.mp4`

| Property | Value |
|---|---|
| Size / duration | 3.4 MB / 23.6 s |
| `kMDItemMediaTypes` | **`(Sound, Video)`** — both tracks present |
| `kMDItemCodecs` | **`H.264`** + `MPEG-4 AAC` |
| Video dimensions | **1672 × 1080** |
| Audio | AAC, 2 channels |
| Bitrate | ~1149 kbps (an all-black video would be a few tens of kbps) |

A frame extracted with `qlmanage` shows a **real, full screen capture** (desktop with editor/terminal windows) — not black, not blank.

**Conclusion:** `SCRecordingOutput` in `screen_capture.rs` is capturing screen video + audio correctly into a proper H.264/AAC MP4. The configuration (`with_width`/`with_height`/`with_fps` on `SCStreamConfiguration`, `H264` codec + `MP4` on `SCRecordingOutputConfiguration`) is correct. **Nothing to fix.** The user most likely inferred "audio-only" from the upload failure (tray showed "❌ Recording failed"), not from inspecting the file.

---

## Bug 1 — 401 on `POST /api/videos` → REAL (web-app fix)

### Root cause

The desktop sends `Authorization: Bearer <device-token>` — **identical** to the working `POST /api/meetings/import/desktop` and the Copilot `/api/copilot/sessions/*` endpoints. The desktop side is **correct**; verified in `src-tauri/src/recorder/uploader_v2.rs` (`create_video` and `mark_uploaded` both set `Authorization: Bearer {token}`).

The mismatch is entirely server-side. In the web app repo (`wolfee-mvp`):

- **`server/lib/videos/videoRoutes.ts`** guards `POST /api/videos` (line 30) and `POST /api/videos/:id/uploaded` (line 72) with **`requireAuth`**.
- **`requireAuth`** (`server/lib/auth.ts:83`) is **session-cookie only** — it reads the `wolfee_session` cookie via `optionalAuth` and 401s if there's no `req.user`. It never looks at the `Authorization` header.
- The desktop has no session cookie. Its Bearer token → ignored → `req.user` unset → **401 "Not authenticated"**.

The desktop's other endpoints work because they use **`requireDeviceAuth`** (`server/routes.ts:6184`), which reads the Bearer token, looks it up in the `devices` table (then falls back to `api_keys`), and sets `req.user`. `POST /api/meetings/import/desktop` (`routes.ts:7363`) uses it; the videos endpoints don't.

### The fix (web app — `wolfee-mvp` repo)

The web app **already has the right middleware**: `requireUserOrDevice` (`server/routes.ts:6692`) — accepts a session cookie (browser) **or** a Bearer device token (desktop), dispatching on whether an `Authorization: Bearer` header is present. The browser upload flow keeps working; the desktop flow starts working. No regression.

`requireUserOrDevice` is a local function inside `registerRoutes()`. It's a hoisted function declaration, so it's already in scope at the `registerVideoRoutes(app)` call site (`routes.ts:233`) even though that line is textually above the definition. So the minimal fix is to pass it in:

**Edit 1 — `server/lib/videos/videoRoutes.ts`**
- Line 1: add `RequestHandler` to the express type import:
  `import type { Express, RequestHandler } from "express";`
- Line 28: add a middleware parameter:
  `export function registerVideoRoutes(app: Express, requireUserOrDevice: RequestHandler): void {`
- Line 30: `app.post("/api/videos", requireAuth, …)` → `app.post("/api/videos", requireUserOrDevice, …)`
- Line 72: `app.post("/api/videos/:id/uploaded", requireAuth, …)` → `app.post("/api/videos/:id/uploaded", requireUserOrDevice, …)`
- Keep the `import { requireAuth }` — the GET/PATCH/DELETE routes still use it.

**Edit 2 — `server/routes.ts`**
- Line 233: `registerVideoRoutes(app);` → `registerVideoRoutes(app, requireUserOrDevice);`

That's the whole fix — 2 files, ~5 lines. Then redeploy `wolfee-mvp`.

Note: `requireDeviceAuth` sets `(req as any).user = device.user`, so the existing handler bodies (`const userId = req.user!.id`) work unchanged — a desktop-created video is owned by the device's user, exactly as intended.

Optional (not needed for Phase 1, only the two POSTs above are): if the desktop later polls processing status, also switch `GET /api/videos/:id` (line 128) to `requireUserOrDevice`.

### Why no desktop change

The desktop request is already correct and well-formed — verified against the web app endpoint:

| Desktop sends (`uploader_v2.rs`) | `/api/videos` expects (`videoRoutes.ts`) |
|---|---|
| `Authorization: Bearer <token>` | accepted by `requireDeviceAuth` (devices + api_keys) |
| `{ title, contentType:"video/mp4", fileSize, ext:"mp4" }` | `contentType` in `CONTENT_TYPE_TO_EXT` ✓, `ext` matches `/^[a-z0-9]{2,5}$/i` ✓, `fileSize` < 2 GB ✓ |
| parses `{ id, shortId, uploadUrl }` | returns exactly that (201) ✓ |
| `PUT` with `Content-Type: video/mp4` | presigned URL signed for `video/mp4` ✓ |
| `POST /api/videos/:id/uploaded` `{ durationSeconds, sizeBytes }` | exactly those fields ✓ |

Every piece lines up except the auth middleware. Once the web app uses `requireUserOrDevice`, the desktop's existing 0.8.0 build completes the create → presigned-PUT → uploaded flow with **no rebuild**.

---

## Status

- ☑ Bug 1 root cause identified — `requireAuth` (session-only) on the videos endpoints rejects the desktop's device token.
- ☑ Web-app fix documented — exact files + lines + middleware swap (`requireAuth` → existing `requireUserOrDevice`).
- ☑ Desktop verified correct — no change; request shape confirmed against the endpoint.
- ☑ Bug 2 verified a non-issue — recording MP4 has a real H.264 video track + AAC audio (evidence above).
- ☐ **Action required:** apply Edit 1 + Edit 2 in `wolfee-mvp` and redeploy. Then the released 0.8.0 desktop app works end-to-end with no desktop update.
