import { Pause, Square, ChevronDown, ChevronUp, Grid3x3, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OverlayMode, UiPhase } from "@/state/types";

/**
 * Sub-prompt 4.6 (Cluely 1:1 redesign) — always-visible thin strip
 * that sits at the top of the focused monitor. Replaces the old
 * TopBar + body sandwich. Five controls match Cluely's reference:
 *   [status pill]                [pause][stop][expand][apps][close]
 *
 * Drag region: the entire strip EXCEPT the buttons. Tauri 2 auto-
 * excludes interactive <button> elements from data-tauri-drag-region,
 * so the click handlers fire normally and click+drag on empty space
 * (or the status pill) moves the window.
 *
 * Cursor: grab on hover, grabbing while dragging.
 *
 * Brand colors: Wolfee zinc-950 + copilot.accent (NOT Cluely's purple).
 */

interface Props {
  mode: OverlayMode;
  uiPhase: UiPhase;
  hasActiveSession: boolean;
  isPaused: boolean;
  onPauseToggle: () => void;
  onStop: () => void;
  onToggleExpand: () => void;
  onAppsClick: () => void;
  onClose: () => void;
}

export function Strip({
  mode,
  uiPhase,
  hasActiveSession,
  isPaused,
  onPauseToggle,
  onStop,
  onToggleExpand,
  onAppsClick,
  onClose,
}: Props) {
  const { dotClass, label } = derivePill(uiPhase, hasActiveSession, isPaused);

  // Buttons that drive a session-only action are disabled outside a
  // live session so the user gets a visual hint Wolfee isn't recording.
  const sessionButtonsEnabled = hasActiveSession;

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex items-center justify-between h-11 px-3 gap-2",
        "bg-zinc-950/95 backdrop-blur-sm",
        "border-b border-white/10",
        // Bottom border vanishes when expanded so the strip + panel
        // read as one continuous surface.
        mode === "expanded" && "border-b-zinc-800/60",
        "select-none cursor-grab active:cursor-grabbing",
      )}
    >
      {/* Status pill — left */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 min-w-0 pr-2"
      >
        <span
          data-tauri-drag-region
          className={cn(
            "inline-block w-2 h-2 rounded-full shrink-0",
            dotClass,
          )}
        />
        <span
          data-tauri-drag-region
          className="text-[12px] font-medium text-zinc-200 leading-none truncate"
        >
          {label}
        </span>
      </div>

      {/* Controls — right */}
      <div className="flex items-center gap-0.5">
        <StripButton
          onClick={onPauseToggle}
          disabled={!sessionButtonsEnabled}
          ariaLabel={isPaused ? "Resume" : "Pause"}
        >
          <Pause className="w-3.5 h-3.5" />
        </StripButton>

        <StripButton
          onClick={onStop}
          disabled={!sessionButtonsEnabled}
          ariaLabel="Stop session"
          danger
        >
          <Square className="w-3.5 h-3.5" />
        </StripButton>

        {/* Subtle divider before navigation controls */}
        <span className="mx-1 h-4 w-px bg-white/10" data-tauri-drag-region />

        <StripButton
          onClick={onToggleExpand}
          ariaLabel={mode === "expanded" ? "Collapse panel" : "Expand panel"}
        >
          {mode === "expanded" ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </StripButton>

        <StripButton onClick={onAppsClick} ariaLabel="Modes (coming soon)">
          <Grid3x3 className="w-3.5 h-3.5" />
        </StripButton>

        <StripButton onClick={onClose} ariaLabel="Hide Wolfee">
          <X className="w-4 h-4" />
        </StripButton>
      </div>
    </div>
  );
}

interface StripButtonProps {
  onClick: () => void;
  ariaLabel: string;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}

function StripButton({
  onClick,
  ariaLabel,
  children,
  disabled,
  danger,
}: StripButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "p-1.5 rounded-md cursor-pointer transition-colors",
        "text-zinc-400",
        !disabled && !danger && "hover:bg-white/5 hover:text-zinc-100",
        !disabled && danger && "hover:bg-red-500/10 hover:text-red-400",
        disabled && "opacity-40 cursor-not-allowed",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60",
      )}
    >
      {children}
    </button>
  );
}

function derivePill(
  uiPhase: UiPhase,
  hasActiveSession: boolean,
  isPaused: boolean,
): { dotClass: string; label: string } {
  if (isPaused) {
    return {
      dotClass: "bg-amber-400",
      label: "Paused",
    };
  }
  if (!hasActiveSession) {
    return {
      dotClass: "bg-zinc-600",
      label: "Wolfee",
    };
  }
  switch (uiPhase) {
    case "Reasoning":
    case "Streaming":
      return {
        dotClass:
          "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]",
        label: "Thinking…",
      };
    case "Showing":
      return {
        dotClass:
          "bg-copilot-accent shadow-[0_0_8px_rgba(34,211,238,0.7)]",
        label: "Suggestion ready",
      };
    case "Failed":
      return { dotClass: "bg-red-400", label: "Error" };
    case "Idle":
    default:
      return {
        dotClass:
          "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]",
        label: "Listening",
      };
  }
}
