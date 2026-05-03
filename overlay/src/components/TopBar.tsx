import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UiPhase } from "@/state/types";

/**
 * Top bar (28px tall) — status pill on the left, Settings ⚙ hook
 * on the right. Settings is a no-op in V1 per plan §12; Sub-prompt 6
 * wires it to a real settings panel.
 */

interface Props {
  uiPhase: UiPhase;
  hasActiveSession: boolean;
}

export function TopBar({ uiPhase, hasActiveSession }: Props) {
  const { dotClass, label } = derivePill(uiPhase, hasActiveSession);

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
      <button
        type="button"
        onClick={() =>
          console.log("[Copilot] settings clicked — Sub-prompt 6")
        }
        aria-label="Open Wolfee Copilot settings"
        className="text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <Settings className="w-4 h-4" />
      </button>
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
