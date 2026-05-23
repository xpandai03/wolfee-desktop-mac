//! Unified Wolfee panel (UX redesign — iterations 2 & 3).
//!
//! One floating panel, opened by a left-click on the tray icon, with
//! Record and Copilot tabs. The webcam preview is no longer inline —
//! it lives in its own floating bubble window (`WebcamBubble.tsx`),
//! which is visible in the screen recording. Toggling the camera here
//! just opens/closes that bubble; this webview never holds the camera,
//! so there is no contention.
//!
//! State arrives from Rust via `wolfee-state` + `wolfee-loom-progress`.
//! Record and Copilot are mutually exclusive.

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  BrainCircuit,
  Camera,
  Check,
  ChevronDown,
  HelpCircle,
  LayoutGrid,
  LogOut,
  Mic,
  Monitor,
  MoreHorizontal,
  ScrollText,
  Settings,
  Sparkles,
  StickyNote,
  Video,
  X,
} from "lucide-react";
import clsx from "clsx";

type Tab = "record" | "copilot" | "screenshot";
type Device = { id: string; label: string };
type DropdownId = "screen" | "camera" | "mic" | "more" | null;

type WolfeeState = {
  loom: string; // idle | countdown | recording | stopping | uploading | complete | failed
  loomError: string | null;
  loomShareUrl: string | null;
  copilot: string; // idle | overlay | starting | listening | reconnecting | ending
  authed: boolean;
};

const DEFAULT_STATE: WolfeeState = {
  loom: "idle",
  loomError: null,
  loomShareUrl: null,
  copilot: "idle",
  authed: false,
};

const LOOM_BUSY = ["countdown", "recording", "stopping", "uploading"];
const COPILOT_ACTIVE = ["starting", "listening", "reconnecting", "ending"];

function emitAction(payload: unknown) {
  void emit("wolfee-action", payload);
}

export function RecorderPanel() {
  const [tab, setTab] = useState<Tab>("record");
  const [app, setApp] = useState<WolfeeState>(DEFAULT_STATE);
  const [uploadPct, setUploadPct] = useState(0);

  // Record-tab device state.
  const [cameras, setCameras] = useState<Device[]>([]);
  const [mics, setMics] = useState<Device[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [micId, setMicId] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [computerSounds, setComputerSounds] = useState(true);
  const [noiseFilter, setNoiseFilter] = useState(false);
  const [openDd, setOpenDd] = useState<DropdownId>(null);
  const [starting, setStarting] = useState(false);

  // Phase 1 Teleprompter — toggle + script draft. Persisted in
  // localStorage so an accidental panel close doesn't lose work.
  // Cleared once the recording starts (the script lives in Rust state
  // from that point until Stop/Discard/failure).
  const [teleprompterOn, setTeleprompterOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem("wolfee.recorder.teleprompter.enabled") === "1";
    } catch {
      return false;
    }
  });
  const [teleprompterScript, setTeleprompterScript] = useState<string>(() => {
    try {
      return localStorage.getItem("wolfee.recorder.teleprompter.draft") ?? "";
    } catch {
      return "";
    }
  });
  // Phase 2 — active-paragraph font size (24 / 28 / 32). Persisted.
  const [teleprompterFontSize, setTeleprompterFontSize] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("wolfee.recorder.teleprompter.fontSize");
      const n = raw ? parseInt(raw, 10) : NaN;
      return n === 24 || n === 28 || n === 32 ? n : 28;
    } catch {
      return 28;
    }
  });
  // Phase 3 — whether auto-scroll starts ON when the recording begins.
  // The overlay's footer pill lets the user flip it mid-recording, but
  // many users will want it on every time without thinking.
  const [teleprompterAutoDefault, setTeleprompterAutoDefault] = useState<boolean>(() => {
    try {
      return localStorage.getItem("wolfee.recorder.teleprompter.autoDefault") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "wolfee.recorder.teleprompter.enabled",
        teleprompterOn ? "1" : "0",
      );
    } catch { /* private mode — no-op */ }
  }, [teleprompterOn]);
  useEffect(() => {
    try {
      localStorage.setItem("wolfee.recorder.teleprompter.draft", teleprompterScript);
    } catch { /* private mode — no-op */ }
  }, [teleprompterScript]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "wolfee.recorder.teleprompter.fontSize",
        String(teleprompterFontSize),
      );
    } catch { /* private mode — no-op */ }
  }, [teleprompterFontSize]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "wolfee.recorder.teleprompter.autoDefault",
        teleprompterAutoDefault ? "1" : "0",
      );
    } catch { /* private mode — no-op */ }
  }, [teleprompterAutoDefault]);

  const loomBusy = LOOM_BUSY.includes(app.loom);
  const copilotActive = COPILOT_ACTIVE.includes(app.copilot);

  // ── App-state plumbing ────────────────────────────────────────────
  // Register the listeners BEFORE requesting a snapshot — otherwise the
  // `wolfee-state` reply can arrive before `listen` is wired up and be
  // missed, leaving the panel showing a stale "idle" (so a recording
  // in progress would wrongly render the setup view instead of Stop).
  useEffect(() => {
    let offState: (() => void) | undefined;
    let offProg: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      offState = await listen<WolfeeState>("wolfee-state", (e) => setApp(e.payload));
      offProg = await listen<number>("wolfee-loom-progress", (e) => setUploadPct(e.payload));
      if (disposed) {
        offState();
        offProg();
        return;
      }
      emitAction("request-wolfee-state");
    })();
    return () => {
      disposed = true;
      offState?.();
      offProg?.();
    };
  }, []);

  // ── Device enumeration (Record tab) ───────────────────────────────
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const vids = all.filter((d) => d.kind === "videoinput");
      const auds = all.filter((d) => d.kind === "audioinput");
      setCameras(vids.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })));
      setMics(auds.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })));
      setMicId((cur) => cur ?? auds[0]?.deviceId ?? null);
      setCameraId((cur) => cur ?? vids[0]?.deviceId ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", refreshDevices);
    return () => md?.removeEventListener?.("devicechange", refreshDevices);
  }, [refreshDevices]);

  // Camera On/Off = open/close the floating bubble window. This webview
  // never holds the camera itself. Only fired by explicit user action
  // (never on mount), so reopening the panel mid-recording can't close
  // a live bubble.
  function applyCamera(on: boolean) {
    setCameraOn(on);
    emitAction(on ? "webcam-bubble-open" : "webcam-bubble-close");
  }

  function handleStart() {
    if (starting || loomBusy || copilotActive) return;
    // Defensive bubble re-emit: if the user has the camera on, fire
    // webcam-bubble-open again right before Start. The bubble *should*
    // already be open from when the user toggled it, but if anything
    // (a stray cancel, an earlier close, a focus-event glitch) tore
    // it down between toggling and Start, this brings it back. Rust's
    // open handler is idempotent (`get_webview_window(...).show()` on
    // an existing window).
    if (cameraOn) {
      emitAction("webcam-bubble-open");
    }
    // Phase 1 Teleprompter — stage script before the loom-record-screen
    // arm fires. The Rust handler reads it once the capture is live
    // and emits copilot-teleprompter-open to the overlay.
    if (teleprompterOn && teleprompterScript.trim()) {
      emitAction({
        type: "teleprompter-start",
        script: teleprompterScript,
        fontSize: teleprompterFontSize,
        autoScroll: teleprompterAutoDefault,
        // wpm uses the AppState default (130) unless the user has
        // changed it in a previous session — the Rust side keeps
        // the last set value.
      });
    }
    setStarting(true);
    // The bubble persists into the recording (Rust does not close it
    // on loom-record-screen).
    emitAction("loom-record-screen");
  }

  function handleClose() {
    // Rust's cancel-recorder-panel handler also closes the bubble.
    emitAction("cancel-recorder-panel");
  }

  return (
    <div
      className="flex h-screen w-screen items-start justify-center pt-2 font-sans"
      style={{ colorScheme: "light" }}
    >
      <div className="relative w-[324px] overflow-visible rounded-[18px] bg-white text-[#1c1c1e] shadow-[0_14px_44px_rgba(0,0,0,0.30)]">
        {/* ── Header: tabs + close ────────────────────────────── */}
        <div data-tauri-drag-region className="flex items-center justify-between px-3 pb-1.5 pt-3">
          <div className="flex items-center gap-1">
            <TabButton icon={Video} label="Record" active={tab === "record"} onClick={() => setTab("record")} />
            <TabButton icon={BrainCircuit} label="Copilot" active={tab === "copilot"} onClick={() => setTab("copilot")} />
            <TabButton icon={Camera} label="Screenshot (soon)" active={false} disabled />
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-lg text-[#8a8a8e] transition-colors hover:bg-[#f0f0f2] hover:text-[#1c1c1e]"
          >
            <X size={17} />
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────── */}
        {tab === "record" ? (
          <RecordTab
            app={app}
            uploadPct={uploadPct}
            copilotActive={copilotActive}
            starting={starting}
            cameras={cameras}
            mics={mics}
            cameraId={cameraId}
            micId={micId}
            cameraOn={cameraOn}
            micOn={micOn}
            computerSounds={computerSounds}
            noiseFilter={noiseFilter}
            openDd={openDd}
            setCameraId={setCameraId}
            setMicId={setMicId}
            applyCamera={applyCamera}
            setMicOn={setMicOn}
            setComputerSounds={setComputerSounds}
            setNoiseFilter={setNoiseFilter}
            setOpenDd={setOpenDd}
            onStart={handleStart}
            teleprompterOn={teleprompterOn}
            setTeleprompterOn={setTeleprompterOn}
            teleprompterScript={teleprompterScript}
            setTeleprompterScript={setTeleprompterScript}
            teleprompterFontSize={teleprompterFontSize}
            setTeleprompterFontSize={setTeleprompterFontSize}
            teleprompterAutoDefault={teleprompterAutoDefault}
            setTeleprompterAutoDefault={setTeleprompterAutoDefault}
          />
        ) : (
          <CopilotTab app={app} loomBusy={loomBusy} />
        )}

        {/* ── Footer ──────────────────────────────────────────── */}
        <div className="mt-1 flex items-stretch border-t border-[#efeff1]">
          <FooterButton icon={StickyNote} label="Notes" disabled />
          <FooterButton icon={Settings} label="Settings" disabled />
          <div className="relative flex-1">
            <FooterButton
              icon={MoreHorizontal}
              label="More"
              active={openDd === "more"}
              onClick={() => setOpenDd(openDd === "more" ? null : "more")}
            />
            {openDd === "more" && (
              <div className="absolute bottom-[calc(100%+6px)] right-2 z-50 w-48 overflow-hidden rounded-xl border border-[#ececef] bg-white py-1 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
                <MenuItem
                  icon={HelpCircle}
                  label="Help"
                  onClick={() => {
                    emitAction({ type: "open-external-url", url: "https://wolfee.io/help" });
                    setOpenDd(null);
                  }}
                />
                <MenuItem icon={Sparkles} label="Check for updates" hint="Soon" disabled />
                <MenuItem icon={MoreHorizontal} label="About Wolfee" hint="Soon" disabled />
                <MenuDivider />
                <MenuItem icon={LogOut} label="Quit Wolfee" onClick={() => emitAction("quit-app")} />
              </div>
            )}
          </div>
        </div>

        {openDd && <div className="fixed inset-0 z-40" onClick={() => setOpenDd(null)} aria-hidden />}
      </div>
    </div>
  );
}

/* ── Record tab ───────────────────────────────────────────────── */

type RecordTabProps = {
  app: WolfeeState;
  uploadPct: number;
  copilotActive: boolean;
  starting: boolean;
  cameras: Device[];
  mics: Device[];
  cameraId: string | null;
  micId: string | null;
  cameraOn: boolean;
  micOn: boolean;
  computerSounds: boolean;
  noiseFilter: boolean;
  openDd: DropdownId;
  setCameraId: Dispatch<SetStateAction<string | null>>;
  setMicId: Dispatch<SetStateAction<string | null>>;
  applyCamera: (on: boolean) => void;
  setMicOn: Dispatch<SetStateAction<boolean>>;
  setComputerSounds: Dispatch<SetStateAction<boolean>>;
  setNoiseFilter: Dispatch<SetStateAction<boolean>>;
  setOpenDd: Dispatch<SetStateAction<DropdownId>>;
  onStart: () => void;
  // Phase 1 Teleprompter
  teleprompterOn: boolean;
  setTeleprompterOn: Dispatch<SetStateAction<boolean>>;
  teleprompterScript: string;
  setTeleprompterScript: Dispatch<SetStateAction<string>>;
  // Phase 2 + 3 Teleprompter
  teleprompterFontSize: number;
  setTeleprompterFontSize: Dispatch<SetStateAction<number>>;
  teleprompterAutoDefault: boolean;
  setTeleprompterAutoDefault: Dispatch<SetStateAction<boolean>>;
};

function RecordTab(p: RecordTabProps) {
  const { app, uploadPct } = p;

  if (app.loom === "countdown")
    return <StatusBody tone="accent" title="Recording starts in 3…" sub="Switch to what you want to capture." />;
  if (app.loom === "recording")
    return (
      <StatusBody tone="rec" title="● Recording" sub="Recording your screen.">
        <BigButton color="rec" label="Stop recording" onClick={() => emitAction("loom-stop-recording")} />
      </StatusBody>
    );
  if (app.loom === "stopping")
    return <StatusBody tone="muted" title="Finishing recording…" sub="Saving the video file." />;
  if (app.loom === "uploading")
    return (
      <StatusBody tone="accent" title={`Uploading… ${uploadPct}%`} sub="Sending your recording to Wolfee.">
        <Progress pct={uploadPct} />
      </StatusBody>
    );
  if (app.loom === "needslink")
    return (
      <StatusBody
        tone="ok"
        title="✅ Recording saved"
        sub={app.loomError ?? "Saved locally on your Mac — link your account to upload it."}
      >
        <BigButton
          color="accent"
          label="Link account to upload"
          onClick={() => emitAction("link-account")}
        />
        <TextButton label="Already linked? Upload now" onClick={() => emitAction("loom-retry-upload")} />
        <TextButton label="Not now" onClick={() => emitAction("loom-dismiss")} />
      </StatusBody>
    );
  if (app.loom === "complete")
    return (
      <StatusBody tone="ok" title="✅ Recording uploaded" sub="The share link is on your clipboard.">
        <BigButton color="accent" label="Open & copy link" onClick={() => emitAction("loom-open-recording")} />
        <TextButton label="Done" onClick={() => emitAction("loom-dismiss")} />
      </StatusBody>
    );
  if (app.loom === "failed")
    return (
      <StatusBody tone="bad" title="❌ Recording failed" sub={app.loomError ?? "Something went wrong."}>
        <BigButton color="neutral" label="Dismiss" onClick={() => emitAction("loom-dismiss")} />
      </StatusBody>
    );

  // ── Setup view (loom idle) ──
  const cameraLabel = p.cameras.find((c) => c.id === p.cameraId)?.label ?? "No camera detected";
  const micLabel = p.mics.find((m) => m.id === p.micId)?.label ?? "No microphone detected";
  const blocked = p.copilotActive;

  return (
    <div className="space-y-1.5 px-3 pb-2">
      <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[11px]">
        <span
          className={clsx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            p.app.authed ? "bg-[#1faa4f]" : "bg-[#e0a82e]",
          )}
        />
        <span className="text-[#8a8a8e]">
          {p.app.authed
            ? "Connected to Wolfee"
            : "Not linked — recordings save to your Mac"}
        </span>
      </div>

      <DeviceRow
        icon={Monitor}
        label="Full screen"
        open={p.openDd === "screen"}
        onClick={() => p.setOpenDd(p.openDd === "screen" ? null : "screen")}
      >
        <Menu>
          <MenuItem icon={Monitor} label="Full screen" selected onClick={() => p.setOpenDd(null)} />
          <MenuItem icon={Monitor} label="Specific window" hint="Soon" disabled />
          <MenuItem icon={Monitor} label="Custom size" hint="Soon" disabled />
        </Menu>
      </DeviceRow>

      <DeviceRow
        icon={Video}
        label={p.cameraOn ? cameraLabel : "Camera"}
        open={p.openDd === "camera"}
        badge={p.cameraOn ? "on" : "off"}
        onBadgeClick={() => p.applyCamera(!p.cameraOn)}
        onClick={() => p.setOpenDd(p.openDd === "camera" ? null : "camera")}
      >
        <Menu>
          <MenuItem
            icon={Video}
            label="No camera"
            selected={!p.cameraOn}
            onClick={() => {
              p.applyCamera(false);
              p.setOpenDd(null);
            }}
          />
          {p.cameras.length === 0 && <MenuEmpty label="No cameras found" />}
          {p.cameras.map((c) => (
            <MenuItem
              key={c.id}
              icon={Video}
              label={c.label}
              selected={p.cameraOn && p.cameraId === c.id}
              onClick={() => {
                p.setCameraId(c.id);
                p.applyCamera(true);
                p.setOpenDd(null);
              }}
            />
          ))}
        </Menu>
      </DeviceRow>

      <DeviceRow
        icon={Mic}
        label={p.micOn ? micLabel : "Microphone"}
        open={p.openDd === "mic"}
        badge={p.micOn ? "on" : "off"}
        onBadgeClick={() => p.setMicOn((v) => !v)}
        onClick={() => p.setOpenDd(p.openDd === "mic" ? null : "mic")}
      >
        <Menu>
          {p.mics.length === 0 && <MenuEmpty label="No microphones found" />}
          {p.mics.map((m) => (
            <MenuItem
              key={m.id}
              icon={Mic}
              label={m.label}
              selected={p.micOn && p.micId === m.id}
              onClick={() => {
                p.setMicId(m.id);
                p.setMicOn(() => true);
                p.setOpenDd(null);
              }}
            />
          ))}
          <MenuDivider />
          <MenuToggle label="Noise filter" hint="Soon" disabled checked={p.noiseFilter} onChange={p.setNoiseFilter} />
          <MenuToggle label="Record computer sounds" checked={p.computerSounds} onChange={p.setComputerSounds} />
        </Menu>
      </DeviceRow>

      {p.cameraOn && (
        <div className="flex items-center gap-1.5 px-1 pt-0.5 text-[11px] text-[#1faa4f]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#1faa4f]" />
          <span className="text-[#8a8a8e]">Camera bubble is on screen — drag it anywhere.</span>
        </div>
      )}

      {/* ── Phase 1 Teleprompter — toggle + script textarea ── */}
      <div className="rounded-[12px] border border-[#2a2a2c] bg-[#1c1c1e] overflow-hidden">
        <button
          type="button"
          onClick={() => p.setTeleprompterOn((v) => !v)}
          className="flex h-9 w-full items-center justify-between px-3 transition-colors hover:bg-[#252527]"
        >
          <span className="flex items-center gap-2 text-[13px] text-[#e8e8ec]">
            <ScrollText className="h-3.5 w-3.5 text-[#9a9a9e]" />
            Teleprompter
          </span>
          <span
            className={clsx(
              "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
              p.teleprompterOn
                ? "bg-[#2f6bff]/25 text-[#9fb6ff]"
                : "bg-[#2a2a2c] text-[#9a9a9e]",
            )}
          >
            {p.teleprompterOn ? "On" : "Off"}
          </span>
        </button>
        {p.teleprompterOn && (
          <div className="border-t border-[#2a2a2c] p-3">
            <textarea
              value={p.teleprompterScript}
              onChange={(e) => p.setTeleprompterScript(e.target.value)}
              placeholder="Type or paste your script — invisible to viewers during the recording."
              className="block w-full resize-y rounded-[8px] border border-[#2a2a2c] bg-[#0e0e10] px-2.5 py-2 text-[12px] leading-snug text-[#e8e8ec] placeholder-[#5a5a5e] focus:border-[#3a3a3e] focus:outline-none"
              style={{ minHeight: 88, maxHeight: 260 }}
              rows={4}
              maxLength={50000}
            />
            <div className="mt-2 flex items-center justify-between text-[10.5px] text-[#8a8a8e]">
              <button
                type="button"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text) p.setTeleprompterScript(text);
                  } catch { /* permission denied / private mode — no-op */ }
                }}
                className="transition-colors hover:text-[#c0c0c4]"
              >
                📋 Paste from clipboard
              </button>
              <span className="tabular-nums">
                {p.teleprompterScript.trim().split(/\s+/).filter(Boolean).length} words
                {p.teleprompterScript.trim() && (
                  <span className="text-[#5a5a5e]">
                    {" "}
                    · ~{Math.max(
                      1,
                      Math.round(
                        p.teleprompterScript.trim().split(/\s+/).filter(Boolean).length / 130,
                      ),
                    )}{" "}
                    min read
                  </span>
                )}
              </span>
            </div>

            {/* Phase 2/3 — display + pacing controls. The overlay's
                footer pill also flips Manual/Auto mid-recording; this
                is just the default for the next "Start recording". */}
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[#2a2a2c] pt-2.5">
              <div className="flex items-center gap-1.5 text-[10.5px] text-[#8a8a8e]">
                <span>Size</span>
                <div className="flex overflow-hidden rounded-md bg-[#0e0e10] ring-1 ring-[#2a2a2c]">
                  {([
                    { size: 24, label: "S" },
                    { size: 28, label: "M" },
                    { size: 32, label: "L" },
                  ] as const).map(({ size, label }) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => p.setTeleprompterFontSize(size)}
                      className={clsx(
                        "h-5 w-6 text-[10.5px] font-semibold transition-colors",
                        p.teleprompterFontSize === size
                          ? "bg-[#2f6bff]/30 text-[#cfdcff]"
                          : "text-[#9a9a9e] hover:bg-[#1c1c1e]",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => p.setTeleprompterAutoDefault((v) => !v)}
                className={clsx(
                  "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold transition-colors",
                  p.teleprompterAutoDefault
                    ? "bg-[#2f6bff]/25 text-[#9fb6ff]"
                    : "bg-[#0e0e10] text-[#9a9a9e] ring-1 ring-[#2a2a2c] hover:text-[#c0c0c4]",
                )}
                title="When on, the teleprompter advances paragraphs automatically. You can flip Manual/Auto mid-recording from the overlay."
              >
                Auto-scroll {p.teleprompterAutoDefault ? "On" : "Off"}
              </button>
            </div>
          </div>
        )}
      </div>

      <button
        onClick={p.onStart}
        disabled={
          p.starting ||
          blocked ||
          (p.teleprompterOn && !p.teleprompterScript.trim())
        }
        className={clsx(
          "mt-1.5 h-[42px] w-full rounded-[11px] text-[14px] font-semibold text-white transition-colors",
          p.starting ||
          blocked ||
          (p.teleprompterOn && !p.teleprompterScript.trim())
            ? "cursor-default bg-[#f0926f]"
            : "bg-[#fb5b36] hover:bg-[#ea4f2c]",
        )}
      >
        {p.starting ? "Starting…" : "Start recording"}
      </button>
      {blocked && (
        <p className="px-1 pt-1 text-center text-[11px] text-[#9a9a9e]">
          End your Copilot session to record.
        </p>
      )}
      {!blocked && p.teleprompterOn && !p.teleprompterScript.trim() && (
        <p className="px-1 pt-1 text-center text-[11px] text-[#9a9a9e]">
          Add a script for the teleprompter, or turn it off.
        </p>
      )}
    </div>
  );
}

/* ── Copilot tab ──────────────────────────────────────────────── */

function CopilotTab({ app, loomBusy }: { app: WolfeeState; loomBusy: boolean }) {
  const c = app.copilot;
  const inSession = COPILOT_ACTIVE.includes(c);
  const transient = c === "starting" || c === "ending";
  const canSuggest = c === "listening" || c === "reconnecting";

  const statusText =
    c === "listening"
      ? "● Listening"
      : c === "reconnecting"
        ? "⚠ Reconnecting…"
        : c === "starting"
          ? "Starting session…"
          : c === "ending"
            ? "Ending session…"
            : c === "overlay"
              ? "Overlay open · idle"
              : "Idle";
  const tone: Tone =
    c === "listening" ? "ok" : c === "reconnecting" ? "bad" : transient ? "muted" : "neutral";

  return (
    <div className="space-y-1.5 px-3 pb-2">
      <div className={clsx("rounded-xl px-3 py-3", toneBg(tone))}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8e]">Copilot</p>
        <p className={clsx("text-[15px] font-semibold", toneText(tone))}>{statusText}</p>
      </div>

      {!app.authed ? (
        // Copilot needs a linked account (it mints a Deepgram token via
        // the backend). The backend's start-copilot-session handler
        // returns silently when unlinked — so surface linking here
        // rather than showing a Start button that does nothing.
        <>
          <div className="rounded-xl bg-[#fdf3e6] px-3 py-2.5">
            <p className="text-[12.5px] font-semibold text-[#9a6a16]">
              Link your Wolfee account
            </p>
            <p className="mt-0.5 text-[11.5px] text-[#8a8a8e]">
              Copilot needs a linked account for live meeting transcription.
            </p>
          </div>
          <button
            onClick={() => emitAction("link-account")}
            className="h-[42px] w-full rounded-[11px] bg-[#2f6bff] text-[14px] font-semibold text-white transition-colors hover:bg-[#2a60e6]"
          >
            Link Account
          </button>
        </>
      ) : !inSession ? (
        <>
          <button
            onClick={() => !loomBusy && emitAction("start-copilot-session")}
            disabled={loomBusy}
            className={clsx(
              "h-[42px] w-full rounded-[11px] text-[14px] font-semibold text-white transition-colors",
              loomBusy ? "cursor-default bg-[#9bb3e8]" : "bg-[#2f6bff] hover:bg-[#2a60e6]",
            )}
          >
            Start Copilot session
          </button>
          {loomBusy && (
            <p className="px-1 text-center text-[11px] text-[#9a9a9e]">Stop your recording first.</p>
          )}
        </>
      ) : (
        <>
          <button
            onClick={() => !transient && emitAction("request-end-copilot-session")}
            disabled={transient}
            className={clsx(
              "h-[42px] w-full rounded-[11px] text-[14px] font-semibold transition-colors",
              transient
                ? "cursor-default bg-[#f1f1f3] text-[#a0a0a5]"
                : "bg-[#f1f1f3] text-[#1c1c1e] hover:bg-[#e8e8ec]",
            )}
          >
            {transient ? "Please wait…" : "End Copilot session"}
          </button>
          <button
            onClick={() => canSuggest && emitAction("trigger-copilot-suggestion")}
            disabled={!canSuggest}
            className={clsx(
              "h-[38px] w-full rounded-[11px] text-[13px] font-semibold transition-colors",
              canSuggest
                ? "bg-[#eef2fe] text-[#2f6bff] hover:bg-[#e3e9fd]"
                : "cursor-default bg-[#f1f1f3] text-[#a0a0a5]",
            )}
          >
            Generate suggestion · ⌘⌥G
          </button>
        </>
      )}

      <LinkRow icon={Monitor} label="Open Copilot overlay" hint="⌘⌥W" onClick={() => emitAction("open-copilot-overlay")} />
      <LinkRow icon={Settings} label="Set up Copilot" onClick={() => emitAction("open-copilot-settings")} />
      <LinkRow
        icon={LayoutGrid}
        label="Manage Modes"
        onClick={() => emitAction({ type: "open-external-url", url: "https://wolfee.io/copilot/modes" })}
      />
      <LinkRow icon={Sparkles} label="Onboarding tour" onClick={() => emitAction("show-onboarding")} />
    </div>
  );
}

/* ── Shared bits ──────────────────────────────────────────────── */

type IconType = typeof Monitor;
type Tone = "neutral" | "accent" | "rec" | "ok" | "bad" | "muted";

function toneBg(t: Tone): string {
  return {
    neutral: "bg-[#f4f4f6]",
    accent: "bg-[#eef2fe]",
    rec: "bg-[#fdecea]",
    ok: "bg-[#e9f7ee]",
    bad: "bg-[#fdeceb]",
    muted: "bg-[#f4f4f6]",
  }[t];
}
function toneText(t: Tone): string {
  return {
    neutral: "text-[#1c1c1e]",
    accent: "text-[#2f6bff]",
    rec: "text-[#e0402a]",
    ok: "text-[#1faa4f]",
    bad: "text-[#e0402a]",
    muted: "text-[#6b6b70]",
  }[t];
}

function StatusBody({
  tone,
  title,
  sub,
  children,
}: {
  tone: Tone;
  title: string;
  sub: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2 px-3 pb-3 pt-1">
      <div className={clsx("rounded-xl px-3 py-4 text-center", toneBg(tone))}>
        <p className={clsx("text-[16px] font-semibold", toneText(tone))}>{title}</p>
        <p className="mt-0.5 text-[12px] text-[#8a8a8e]">{sub}</p>
      </div>
      {children}
    </div>
  );
}

function Progress({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[#ececef]">
      <div
        className="h-full rounded-full bg-[#2f6bff] transition-all"
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

function BigButton({
  color,
  label,
  onClick,
}: {
  color: "accent" | "rec" | "neutral";
  label: string;
  onClick: () => void;
}) {
  const cls = {
    accent: "bg-[#2f6bff] hover:bg-[#2a60e6] text-white",
    rec: "bg-[#fb5b36] hover:bg-[#ea4f2c] text-white",
    neutral: "bg-[#f1f1f3] hover:bg-[#e8e8ec] text-[#1c1c1e]",
  }[color];
  return (
    <button
      onClick={onClick}
      className={clsx("h-[42px] w-full rounded-[11px] text-[14px] font-semibold transition-colors", cls)}
    >
      {label}
    </button>
  );
}

function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-8 w-full text-[12.5px] font-medium text-[#8a8a8e] transition-colors hover:text-[#1c1c1e]"
    >
      {label}
    </button>
  );
}

function TabButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: IconType;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={clsx(
        "flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-[12.5px] font-semibold transition-colors",
        active && "bg-[#2f6bff] text-white",
        !active && !disabled && "text-[#6b6b70] hover:bg-[#f0f0f2]",
        disabled && "cursor-not-allowed text-[#c4c4c8]",
      )}
    >
      <Icon size={15} />
      {!disabled && <span>{label}</span>}
    </button>
  );
}

function LinkRow({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: IconType;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex h-[40px] w-full items-center gap-2.5 rounded-xl bg-[#f4f4f6] px-3 text-left transition-colors hover:bg-[#ededf0]"
    >
      <Icon size={16} className="shrink-0 text-[#3a3a3e]" />
      <span className="flex-1 truncate text-[13px] font-medium">{label}</span>
      {hint && <span className="text-[10.5px] font-semibold text-[#a8a8ad]">{hint}</span>}
    </button>
  );
}

function DeviceRow({
  icon: Icon,
  label,
  open,
  badge,
  onBadgeClick,
  onClick,
  children,
}: {
  icon: IconType;
  label: string;
  open: boolean;
  badge?: "on" | "off";
  onBadgeClick?: () => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <button
        onClick={onClick}
        className={clsx(
          "flex h-[44px] w-full items-center gap-2.5 rounded-xl px-3 text-left transition-colors",
          open ? "bg-[#2f6bff] text-white" : "bg-[#f4f4f6] text-[#1c1c1e] hover:bg-[#ededf0]",
        )}
      >
        <Icon size={17} className={clsx("shrink-0", open ? "text-white" : "text-[#3a3a3e]")} />
        <span className="flex-1 truncate text-[13px] font-medium">{label}</span>
        {badge && (
          <span
            role={onBadgeClick ? "button" : undefined}
            onClick={
              onBadgeClick
                ? (e) => {
                    e.stopPropagation();
                    onBadgeClick();
                  }
                : undefined
            }
            className={clsx(
              "rounded-md px-1.5 py-[3px] text-[10px] font-bold uppercase tracking-wide",
              badge === "on" ? "bg-[#1faa4f] text-white" : "bg-[#d6d6da] text-[#6b6b70]",
              onBadgeClick && "cursor-pointer",
            )}
          >
            {badge}
          </span>
        )}
        <ChevronDown size={15} className={open ? "text-white/80" : "text-[#a8a8ad]"} />
      </button>
      {open && children}
    </div>
  );
}

function Menu({ children }: { children: ReactNode }) {
  return (
    <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-xl border border-[#ececef] bg-white py-1 shadow-[0_12px_32px_rgba(0,0,0,0.20)]">
      {children}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  selected,
  disabled,
  onClick,
}: {
  icon: IconType;
  label: string;
  hint?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px]",
        disabled ? "cursor-not-allowed text-[#bfbfc4]" : "text-[#1c1c1e] hover:bg-[#f4f4f6]",
      )}
    >
      <Icon size={15} className="shrink-0 opacity-80" />
      <span className="flex-1 truncate font-medium">{label}</span>
      {hint && <span className="text-[10px] font-semibold uppercase text-[#bdbdc2]">{hint}</span>}
      {selected && <Check size={15} className="text-[#2f6bff]" />}
    </button>
  );
}

function MenuEmpty({ label }: { label: string }) {
  return <div className="px-3 py-2 text-[12px] text-[#a0a0a5]">{label}</div>;
}

function MenuDivider() {
  return <div className="my-1 h-px bg-[#efeff1]" />;
}

function MenuToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={clsx(
        "flex items-center gap-2 px-3 py-[7px] text-[12.5px]",
        disabled ? "text-[#bfbfc4]" : "text-[#1c1c1e]",
      )}
    >
      <span className="flex-1 font-medium">{label}</span>
      {hint && <span className="text-[10px] font-semibold uppercase text-[#bdbdc2]">{hint}</span>}
      <button
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        aria-pressed={checked}
        className={clsx(
          "relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors",
          checked && !disabled ? "bg-[#1faa4f]" : "bg-[#d6d6da]",
          disabled && "opacity-60",
        )}
      >
        <span
          className={clsx(
            "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all",
            checked ? "left-[14px]" : "left-[2px]",
          )}
        />
      </button>
    </div>
  );
}

function FooterButton({
  icon: Icon,
  label,
  disabled,
  active,
  onClick,
}: {
  icon: IconType;
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium transition-colors",
        disabled && "cursor-not-allowed text-[#c8c8cc]",
        !disabled && active && "text-[#2f6bff]",
        !disabled && !active && "text-[#7a7a7e] hover:text-[#1c1c1e]",
      )}
    >
      <Icon size={17} />
      {label}
    </button>
  );
}

export default RecorderPanel;
