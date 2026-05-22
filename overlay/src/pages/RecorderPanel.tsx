//! Loom-style pre-record panel (recorder UI redesign — iteration 1).
//!
//! Rendered into its own Tauri webview window via the `#/recorder`
//! hash route (see main.tsx). Opened from the tray "Record Screen"
//! item. The panel collects the recording setup — mode, screen
//! target, camera, mic — and on "Start recording" hands off to the
//! existing native capture flow by emitting `wolfee-action:
//! loom-record-screen`; Rust closes this window and runs the
//! countdown + capture.
//!
//! Iteration 1 scope: the panel + device pickers + live webcam
//! preview. Camera/mic *selection* is collected here but not yet
//! plumbed into the capture (the recorder still uses the primary
//! display + default mic + system audio — which match the panel
//! defaults). Countdown overlay, recording control bar and webcam
//! bubble are the next iteration.

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  Camera,
  Check,
  ChevronDown,
  HelpCircle,
  Mic,
  Monitor,
  MoreHorizontal,
  Smile,
  StickyNote,
  Video,
  X,
} from "lucide-react";
import clsx from "clsx";

type Mode = "screen" | "webcam" | "screenshot";
type Device = { id: string; label: string };
type DropdownId = "screen" | "camera" | "mic" | "more" | null;

function emitAction(payload: unknown) {
  void emit("wolfee-action", payload);
}

export function RecorderPanel() {
  const [mode, setMode] = useState<Mode>("screen");
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

  const previewRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopPreview = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
  }, []);

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
      /* enumeration failure — leave lists empty */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      md?.removeEventListener?.("devicechange", refreshDevices);
      stopPreview();
    };
  }, [refreshDevices, stopPreview]);

  // Live webcam preview. Runs whenever the camera is toggled on (or
  // we're in webcam-only mode, where the camera is mandatory).
  const wantCamera = cameraOn || mode === "webcam";
  useEffect(() => {
    let cancelled = false;
    if (!wantCamera) {
      stopPreview();
      return;
    }
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraId ? { deviceId: { exact: cameraId } } : true,
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stopPreview();
        streamRef.current = stream;
        if (previewRef.current) previewRef.current.srcObject = stream;
        // Labels become available once a camera stream is live.
        void refreshDevices();
      } catch {
        if (!cancelled) setCameraOn(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantCamera, cameraId, refreshDevices, stopPreview]);

  const cameraLabel = cameras.find((c) => c.id === cameraId)?.label ?? "No camera detected";
  const micLabel = mics.find((m) => m.id === micId)?.label ?? "No microphone detected";

  function handleStart() {
    if (starting) return;
    setStarting(true);
    stopPreview();
    // Iteration 1: trigger the existing native capture flow. It
    // records the primary display + mic + system audio — which is
    // exactly the panel's defaults. Wiring the per-device selections
    // through is the next iteration.
    emitAction("loom-record-screen");
  }

  function handleCancel() {
    stopPreview();
    emitAction("cancel-recorder-panel");
  }

  return (
    <div
      className="flex h-screen w-screen items-center justify-center font-sans"
      style={{ colorScheme: "light" }}
    >
      <div className="relative w-[324px] overflow-visible rounded-[18px] bg-white text-[#1c1c1e] shadow-[0_14px_44px_rgba(0,0,0,0.30)]">
        {/* ── Header: mode tabs + close ───────────────────────── */}
        <div
          data-tauri-drag-region
          className="flex items-center justify-between px-3 pb-1.5 pt-3"
        >
          <div className="flex items-center gap-1">
            <ModeTab icon={Monitor} active={mode === "screen"} onClick={() => setMode("screen")} label="Screen" />
            <ModeTab icon={Video} active={mode === "webcam"} onClick={() => setMode("webcam")} label="Webcam" />
            <ModeTab icon={Camera} active={false} disabled label="Screenshot (soon)" />
          </div>
          <button
            onClick={handleCancel}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-lg text-[#8a8a8e] transition-colors hover:bg-[#f0f0f2] hover:text-[#1c1c1e]"
          >
            <X size={17} />
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────── */}
        <div className="space-y-1.5 px-3 pb-2">
          {mode === "webcam" && (
            <div className="flex justify-center py-1">
              <CameraCircle on={wantCamera} videoRef={previewRef} size={132} />
            </div>
          )}

          {mode === "screen" && (
            <DeviceRow
              icon={Monitor}
              label="Full screen"
              open={openDd === "screen"}
              onClick={() => setOpenDd(openDd === "screen" ? null : "screen")}
            >
              <Menu>
                <MenuItem icon={Monitor} label="Full screen" selected onClick={() => setOpenDd(null)} />
                <MenuItem icon={Monitor} label="Specific window" hint="Soon" disabled />
                <MenuItem icon={Monitor} label="Custom size" hint="Soon" disabled />
                <MenuDivider />
                <MenuItem
                  icon={Video}
                  label="Camera only"
                  onClick={() => {
                    setMode("webcam");
                    setOpenDd(null);
                  }}
                />
              </Menu>
            </DeviceRow>
          )}

          <DeviceRow
            icon={Video}
            label={wantCamera ? cameraLabel : "Camera"}
            open={openDd === "camera"}
            badge={mode === "webcam" ? "on" : cameraOn ? "on" : "off"}
            onBadgeClick={mode === "webcam" ? undefined : () => setCameraOn((v) => !v)}
            onClick={() => setOpenDd(openDd === "camera" ? null : "camera")}
          >
            <Menu>
              {mode !== "webcam" && (
                <MenuItem
                  icon={Video}
                  label="No camera"
                  selected={!cameraOn}
                  onClick={() => {
                    setCameraOn(false);
                    setOpenDd(null);
                  }}
                />
              )}
              {cameras.length === 0 && <MenuEmpty label="No cameras found" />}
              {cameras.map((c) => (
                <MenuItem
                  key={c.id}
                  icon={Video}
                  label={c.label}
                  selected={wantCamera && cameraId === c.id}
                  onClick={() => {
                    setCameraId(c.id);
                    setCameraOn(true);
                    setOpenDd(null);
                  }}
                />
              ))}
            </Menu>
          </DeviceRow>

          <DeviceRow
            icon={Mic}
            label={micOn ? micLabel : "Microphone"}
            open={openDd === "mic"}
            badge={micOn ? "on" : "off"}
            onBadgeClick={() => setMicOn((v) => !v)}
            onClick={() => setOpenDd(openDd === "mic" ? null : "mic")}
          >
            <Menu>
              {mics.length === 0 && <MenuEmpty label="No microphones found" />}
              {mics.map((m) => (
                <MenuItem
                  key={m.id}
                  icon={Mic}
                  label={m.label}
                  selected={micOn && micId === m.id}
                  onClick={() => {
                    setMicId(m.id);
                    setMicOn(true);
                    setOpenDd(null);
                  }}
                />
              ))}
              <MenuDivider />
              <MenuToggle
                label="Noise filter"
                hint="Soon"
                disabled
                checked={noiseFilter}
                onChange={setNoiseFilter}
              />
              <MenuToggle
                label="Record computer sounds"
                checked={computerSounds}
                onChange={setComputerSounds}
              />
            </Menu>
          </DeviceRow>

          {mode === "screen" && cameraOn && (
            <div className="flex items-center gap-2 px-1 pt-0.5">
              <CameraCircle on videoRef={previewRef} size={52} />
              <span className="text-[11px] text-[#8a8a8e]">Webcam preview</span>
            </div>
          )}

          <button
            onClick={handleStart}
            disabled={starting}
            className={clsx(
              "mt-1.5 h-[42px] w-full rounded-[11px] text-[14px] font-semibold text-white transition-colors",
              starting ? "cursor-default bg-[#f0926f]" : "bg-[#fb5b36] hover:bg-[#ea4f2c]",
            )}
          >
            {starting ? "Starting…" : "Start recording"}
          </button>
        </div>

        {/* ── Footer ──────────────────────────────────────────── */}
        <div className="mt-1 flex items-stretch border-t border-[#efeff1]">
          <FooterButton icon={Smile} label="Effects" disabled />
          <FooterButton icon={StickyNote} label="Notes" disabled />
          <div className="relative flex-1">
            <FooterButton
              icon={MoreHorizontal}
              label="More"
              active={openDd === "more"}
              onClick={() => setOpenDd(openDd === "more" ? null : "more")}
            />
            {openDd === "more" && (
              <div className="absolute bottom-[calc(100%+6px)] right-2 z-50 w-44 overflow-hidden rounded-xl border border-[#ececef] bg-white py-1 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
                <MenuItem
                  icon={HelpCircle}
                  label="Help"
                  onClick={() => {
                    emitAction({ type: "open-external-url", url: "https://wolfee.io/help" });
                    setOpenDd(null);
                  }}
                />
                <MenuItem icon={MoreHorizontal} label="About Wolfee" hint="Soon" disabled />
              </div>
            )}
          </div>
        </div>

        {/* Click-away backdrop for any open dropdown. */}
        {openDd && (
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpenDd(null)}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}

/* ── Sub-components ───────────────────────────────────────────── */

type IconType = typeof Monitor;

function ModeTab({
  icon: Icon,
  active,
  disabled,
  onClick,
  label,
}: {
  icon: IconType;
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={clsx(
        "grid h-8 w-9 place-items-center rounded-[9px] transition-colors",
        active && "bg-[#2f6bff] text-white",
        !active && !disabled && "text-[#6b6b70] hover:bg-[#f0f0f2]",
        disabled && "cursor-not-allowed text-[#c4c4c8]",
      )}
    >
      <Icon size={17} />
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

function Menu({ children }: { children: React.ReactNode }) {
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

function CameraCircle({
  on,
  videoRef,
  size,
}: {
  on: boolean;
  videoRef: RefObject<HTMLVideoElement>;
  size: number;
}) {
  return (
    <div
      className="overflow-hidden rounded-full bg-[#e9e9ec]"
      style={{ width: size, height: size }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={clsx("h-full w-full object-cover", !on && "hidden")}
        style={{ transform: "scaleX(-1)" }}
      />
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
