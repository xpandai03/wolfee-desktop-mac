import React from "react";
import { motion } from "framer-motion";
import { Copy, X as XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { labelFor } from "@/lib/triggerLabels";
import { ReasoningIndicator } from "./ReasoningIndicator";
import type { ActiveSuggestion, UiPhase } from "@/state/types";

/**
 * The centerpiece of the overlay (plan §4 + 2026-05-04 UX retune).
 *
 * Two visual modes:
 *   - Collapsed: small card, primary text only, click to expand.
 *   - Expanded: fills the overlay, primary + secondary + reasoning.
 *               TTL paused. Stays until ✕ collapses.
 *
 * Renders three loading states: Reasoning (dots) → Streaming (still
 * dots, JSON tokens hidden) → Showing (final card with text).
 */

interface Props {
  uiPhase: UiPhase;
  active: ActiveSuggestion;
  isFading: boolean;
  copiedFlashAt: number | null;
  onDismiss: () => void;
  onToggleExpanded: () => void;
  onCopy: () => void;
}

function SuggestionCardImpl({
  uiPhase,
  active,
  isFading,
  copiedFlashAt,
  onDismiss,
  onToggleExpanded,
  onCopy,
}: Props) {
  const glyph = active.triggerSource === "hotkey" ? "✦" : "⚠";
  const label = labelFor(active.trigger);
  const sourceText = active.triggerSource === "hotkey" ? "manual" : "auto";

  // Streaming JSON tokens are NOT rendered as text. Show ReasoningIndicator
  // until the LLM completes (uiPhase = Showing) and the parsed primary
  // is in active.finalPrimary.
  const displayPrimary = active.finalPrimary;
  const isExpanded = active.expanded;

  const showCopied =
    copiedFlashAt !== null && Date.now() - copiedFlashAt < 1200;

  // Click on the suggestion body:
  //   - Collapsed + Showing → expand
  //   - Expanded → no-op (use Copy / X buttons)
  const handleCardClick = () => {
    if (uiPhase !== "Showing" || !active.finalPrimary) return;
    if (!isExpanded) onToggleExpanded();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isFading ? 0.6 : 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={
        isFading
          ? { duration: 5, ease: "linear" }
          : { duration: 0.2, ease: "easeOut" }
      }
      className={cn(
        "relative mx-3 rounded-xl border bg-zinc-900/95 shadow-lg shadow-copilot-glow/20",
        "transition-colors duration-200",
        isExpanded
          ? "border-copilot-accent/40 px-4 py-3"
          : "border-white/10 px-3 py-2",
        showCopied && "bg-copilot-accent/10",
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
          {isExpanded && (
            <span className="text-[10px] text-zinc-500">
              · {Math.round(active.confidence * 100)}% confident
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          aria-label="Dismiss suggestion"
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Primary slot */}
      <button
        type="button"
        onClick={handleCardClick}
        disabled={uiPhase !== "Showing"}
        tabIndex={uiPhase === "Showing" ? 0 : -1}
        className={cn(
          "mt-2 text-left w-full text-zinc-50 leading-snug",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/40 rounded",
          isExpanded ? "text-base font-medium" : "text-sm font-medium",
          uiPhase === "Showing" && active.finalPrimary && !isExpanded
            ? "cursor-pointer hover:text-white"
            : "cursor-default",
        )}
      >
        {uiPhase === "Showing" && displayPrimary ? (
          displayPrimary
        ) : (
          <ReasoningIndicator />
        )}
      </button>

      {/* Secondary — visible in both collapsed (if present) and expanded */}
      {uiPhase === "Showing" && active.finalSecondary && (
        <p
          className={cn(
            "leading-snug mt-1.5 before:content-['↳_'] before:text-zinc-500",
            isExpanded
              ? "text-sm text-zinc-200"
              : "text-xs text-zinc-300",
          )}
        >
          {active.finalSecondary}
        </p>
      )}

      {/* Expanded-only: reasoning + Copy button */}
      {isExpanded && uiPhase === "Showing" && (
        <>
          {active.reasoning && (
            <p className="text-xs text-zinc-400 leading-snug mt-3 italic">
              <span className="not-italic text-zinc-500 mr-1">why:</span>
              {active.reasoning}
            </p>
          )}
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCopy();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-copilot-accent/15 hover:bg-copilot-accent/25 text-copilot-accent text-xs font-medium px-3 py-1.5 transition-colors"
            >
              <Copy className="w-3 h-3" />
              {showCopied ? "Copied ✓" : "Copy primary"}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpanded();
              }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1.5"
            >
              Collapse
            </button>
          </div>
        </>
      )}

      {/* Footer hint (collapsed only) */}
      {!isExpanded && (
        <p className="text-[11px] text-zinc-500 mt-2 leading-none">
          {showCopied
            ? "Copied ✓"
            : uiPhase === "Showing"
              ? "Click to expand · ✕ to dismiss"
              : ""}
        </p>
      )}
    </motion.div>
  );
}

export const SuggestionCard = React.memo(SuggestionCardImpl);
