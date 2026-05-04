import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { labelFor } from "@/lib/triggerLabels";
import { ReasoningIndicator } from "./ReasoningIndicator";
import type { ActiveSuggestion, UiPhase } from "@/state/types";

/**
 * The centerpiece of the overlay (plan §4).
 *
 * Renders three states: Reasoning (dots) → Streaming (filling text)
 * → Showing (final card with primary + optional secondary + footer).
 *
 * Wrapped by AnimatePresence in the parent for mount/unmount animations.
 */

interface Props {
  uiPhase: UiPhase;
  active: ActiveSuggestion;
  isFading: boolean;
  copiedFlashAt: number | null;
  onDismiss: () => void;
  onCopy: () => void;
}

function SuggestionCardImpl({
  uiPhase,
  active,
  isFading,
  copiedFlashAt,
  onDismiss,
  onCopy,
}: Props) {
  const glyph = active.triggerSource === "hotkey" ? "✦" : "⚠";
  const label = labelFor(active.trigger);
  const sourceText = active.triggerSource === "hotkey" ? "manual" : "auto";

  // We don't render `streamingPrimary` because OpenAI's JSON-mode
  // stream emits raw JSON tokens ({"primary":"the actual text"...) —
  // displaying that as text shows JSON garbage. Instead, keep showing
  // the Reasoning indicator while the LLM streams, and only render
  // text once SUGGESTION_COMPLETE has arrived with `finalPrimary` set
  // (uiPhase === "Showing"). Text pops in instantly when ready, no
  // "code-like AI-y" intermediate state.
  const displayPrimary = active.finalPrimary;

  // Brief "Copied ✓" flash when copiedFlashAt is recent.
  const showCopied =
    copiedFlashAt !== null && Date.now() - copiedFlashAt < 1200;
  // Card-level flash overlay tied to the same trigger.
  const showFlashOverlay = showCopied;

  const handlePrimaryClick = () => {
    if (uiPhase !== "Showing" || !active.finalPrimary) return;
    onCopy();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isFading ? 0.6 : 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={
        // Long fade if we're entering the TTL warning window;
        // standard 200ms otherwise.
        isFading
          ? { duration: 5, ease: "linear" }
          : { duration: 0.2, ease: "easeOut" }
      }
      className={cn(
        "relative mx-3 rounded-xl border border-white/10 bg-zinc-900/95",
        "px-3 py-2 shadow-lg shadow-copilot-glow/20",
        "transition-colors duration-200",
        showFlashOverlay && "bg-copilot-accent/10",
      )}
      role="dialog"
      aria-live="polite"
      aria-label="Wolfee Copilot suggestion"
    >
      {/* Badge row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="inline-flex items-center gap-1 rounded-full bg-copilot-accent/15 text-copilot-accent text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5">
            <span aria-hidden>{glyph}</span>
            <span>{label}</span>
          </span>
          <span className="text-[10px] text-zinc-500">· {sourceText}</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss suggestion"
          className="text-zinc-500 hover:text-zinc-300 text-xs leading-none px-1"
        >
          ×
        </button>
      </div>

      {/* Primary slot — Reasoning dots OR streaming/final text */}
      <button
        type="button"
        onClick={handlePrimaryClick}
        disabled={uiPhase !== "Showing"}
        tabIndex={uiPhase === "Showing" ? 0 : -1}
        className={cn(
          "mt-2 text-left w-full text-sm font-medium text-zinc-50 leading-snug",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/40 rounded",
          uiPhase === "Showing" && active.finalPrimary
            ? "cursor-pointer hover:text-white"
            : "cursor-default",
        )}
      >
        {uiPhase === "Showing" && displayPrimary ? (
          displayPrimary
        ) : (
          // Reasoning OR Streaming OR Showing-but-no-primary-yet —
          // keep the dots so the user sees "AI is thinking" through
          // the whole LLM round-trip.
          <ReasoningIndicator />
        )}
      </button>

      {/* Secondary (only when complete) */}
      {uiPhase === "Showing" && active.finalSecondary && (
        <p className="text-xs text-zinc-300 leading-snug mt-1.5 before:content-['↳_'] before:text-zinc-500">
          {active.finalSecondary}
        </p>
      )}

      {/* Footer hint */}
      <p className="text-[11px] text-zinc-500 mt-2 leading-none">
        {showCopied
          ? "Copied ✓"
          : uiPhase === "Showing"
            ? "Esc · Click to copy"
            : ""}
      </p>
    </motion.div>
  );
}

export const SuggestionCard = React.memo(SuggestionCardImpl);
