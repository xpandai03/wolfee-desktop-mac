import { Settings, X } from "lucide-react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cn } from "@/lib/utils";
import type { UiPhase } from "@/state/types";

/**
 * Top bar (28px tall) — status pill on the left, Settings ⚙ + X
 * close button on the right. Settings is a no-op stub for Sub-prompt 6
 * to wire. The X explicitly hides the overlay window — needed because
 * we removed auto-hide-on-blur (overlay used to flicker shut the
 * instant another app reclaimed focus).
 */

interface Props {
  uiPhase: UiPhase;
  hasActiveSession: boolean;
}

export function TopBar({ uiPhase, hasActiveSession }: Props) {
  const { dotClass, label } = derivePill(uiPhase, hasActiveSession);

  const handleClose = async () => {
    // Hide via the webview window directly — the Rust state stays
    // synced because hotkey.rs's toggle_overlay reads window
    // visibility (not CopilotState) when deciding show vs hide.
    const win = getCurrentWebviewWindow();
    await win.hide();
  };

  return (
    <div className="flex items-center justify-between px-3 py-1.5 h-7 select-none">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-block w-1.5 h-1.5 rounded-full",
            dotClass,
          )}
        />
        <span className="text-[11px] text-zinc-400 leading-none">{label}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() =>
            console.log("[Copilot] settings clicked — Sub-prompt 6")
          }
          aria-label="Open Wolfee Copilot settings"
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close Wolfee Copilot overlay"
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function derivePill(uiPhase: UiPhase, hasActiveSession: boolean) {
  if (!hasActiveSession) {
    return {
      dotClass: "bg-zinc-600",
      label: "Idle",
    };
  }
  switch (uiPhase) {
    case "Reasoning":
    case "Streaming":
      return {
        dotClass: "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]",
        label: "Thinking…",
      };
    case "Showing":
      return {
        dotClass: "bg-copilot-accent shadow-[0_0_6px_rgba(34,211,238,0.6)]",
        label: "Suggestion",
      };
    case "Failed":
      return { dotClass: "bg-red-400", label: "Error" };
    case "Idle":
    default:
      return {
        dotClass: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]",
        label: "Listening",
      };
  }
}
