//! Floating recording control bar (recorder — iteration 4).
//!
//! Rendered into a content-protected, always-on-top window
//! (`#/control-bar`) shown for the duration of a recording. The timer
//! counts up from when this window mounts (i.e. when capture starts);
//! a restart destroys and recreates the window, so the timer resets
//! naturally.
//!
//! There is no Pause button — ScreenCaptureKit's `SCRecordingOutput`
//! has no pause/resume API, so rather than ship a dead control the bar
//! offers Restart (redo this take), Stop and Discard.

import { useEffect, useState, type ReactNode } from "react";
import { emit } from "@tauri-apps/api/event";
import { RotateCcw, Square, Trash2 } from "lucide-react";
import clsx from "clsx";

function fmt(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function ControlBar() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const act = (action: string) => () => void emit("wolfee-action", action);

  return (
    <div className="flex h-screen w-screen items-center justify-center font-sans">
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 rounded-full bg-[#161619] px-3 py-2 shadow-[0_8px_30px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
      >
        <span
          data-tauri-drag-region
          className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[#fb3b3b]"
        />
        <span
          data-tauri-drag-region
          className="min-w-[46px] text-[14px] font-semibold tabular-nums text-white"
        >
          {fmt(elapsed)}
        </span>
        <span data-tauri-drag-region className="mx-0.5 h-5 w-px bg-white/15" />

        <CtrlButton title="Restart recording" onClick={act("loom-restart-recording")}>
          <RotateCcw size={15} />
        </CtrlButton>
        <CtrlButton title="Stop & upload" onClick={act("loom-stop-recording")} variant="stop">
          <Square size={12} fill="currentColor" />
        </CtrlButton>
        <CtrlButton title="Discard recording" onClick={act("loom-discard-recording")}>
          <Trash2 size={15} />
        </CtrlButton>
      </div>
    </div>
  );
}

function CtrlButton({
  title,
  onClick,
  disabled,
  variant,
  children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "stop";
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "grid h-8 w-8 place-items-center rounded-full transition-colors",
        disabled && "cursor-not-allowed text-white/25",
        !disabled && variant === "stop" && "bg-[#fb3b3b] text-white hover:bg-[#e23030]",
        !disabled && !variant && "text-white/80 hover:bg-white/12 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

export default ControlBar;
