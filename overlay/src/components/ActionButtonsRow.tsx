import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageCircle, HelpCircle, CheckCircle, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickActionType } from "@/state/types";

/**
 * Sub-prompt 4.5 — 4 always-visible action buttons in the suggestion
 * zone. Two visual modes:
 *
 *   Idle   → 2x2 grid of large buttons (icon + label) filling 130px
 *   Active → 28px horizontal icon-only strip above the suggestion
 *            card, hover-tooltip on each icon
 *
 * Click semantics: each button dispatches a Tauri `wolfee-action`
 * event with `{type: "trigger-copilot-quick-action", action}`. The
 * Rust handler does the cooldown + state checks (Decision N1 user-
 * click-wins is enforced server- and client-side: in-flight auto-
 * suggestions are aborted before the new stream opens).
 */

const ACTIONS: Array<{
  key: QuickActionType;
  label: string;
  icon: typeof MessageCircle;
}> = [
  { key: "ask", label: "Ask", icon: MessageCircle },
  { key: "follow_up", label: "Follow-up", icon: HelpCircle },
  { key: "fact_check", label: "Fact-check", icon: CheckCircle },
  { key: "recap", label: "Recap", icon: RotateCw },
];

interface Props {
  mode: "idle" | "active";
  onAction: (action: QuickActionType) => void;
  disabled?: boolean;
}

function ActionButtonsRowImpl({ mode, onAction, disabled }: Props) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {mode === "idle" ? (
        <motion.div
          key="idle"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="grid grid-cols-2 gap-2 px-3 py-2 h-[130px]"
        >
          {ACTIONS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => onAction(key)}
              disabled={disabled}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg",
                "border border-white/10 bg-zinc-900 text-zinc-100 text-sm font-medium",
                "transition-colors duration-150",
                "hover:border-copilot-accent/40 hover:bg-zinc-800 hover:text-copilot-accent",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </button>
          ))}
        </motion.div>
      ) : (
        <motion.div
          key="active"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex items-center justify-around px-3 h-7 border-b border-white/10"
        >
          {ACTIONS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => onAction(key)}
              disabled={disabled}
              title={label}
              className={cn(
                "text-zinc-400 transition-colors duration-150",
                "hover:text-copilot-accent",
                "focus:outline-none focus-visible:text-copilot-accent",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
              aria-label={label}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const ActionButtonsRow = React.memo(ActionButtonsRowImpl);
