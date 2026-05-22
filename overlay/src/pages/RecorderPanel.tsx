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

      <button
        onClick={p.onStart}
        disabled={p.starting || blocked}
        className={clsx(
          "mt-1.5 h-[42px] w-full rounded-[11px] text-[14px] font-semibold text-white transition-colors",
          p.starting || blocked ? "cursor-default bg-[#f0926f]" : "bg-[#fb5b36] hover:bg-[#ea4f2c]",
        )}
      >
        {p.starting ? "Starting…" : "Start recording"}
      </button>
      {blocked && (
        <p className="px-1 pt-1 text-center text-[11px] text-[#9a9a9e]">
          End your Copilot session to record.
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

      {!inSession ? (
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
        <button
          onClick={() => !transient && emitAction("end-copilot-session")}
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
