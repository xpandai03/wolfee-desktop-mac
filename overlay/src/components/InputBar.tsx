import React, { useEffect, useRef } from "react";
import { Send, Sparkles, MessageCircleQuestion, ShieldCheck, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuickActionType } from "@/state/types";

/**
 * Sub-prompt 4.6 (Cluely 1:1) — bottom of the expanded panel. Always
 * visible regardless of which tab (Chat / Transcript) is active.
 *
 * Layout matches Cluely's reference screenshot:
 *   row 1: 4 quick-action buttons in a horizontal row
 *          [✨ Assist] [❓ What should I say?] [✓ Follow-up] [↻ Recap]
 *   row 2: input box + send button
 *          "Ask about your screen or conversation, or ⌃ ⏎ for Assist"
 *
 * Empty input + click Assist → fires existing /quick-action with
 * action="ask" and no user_question (auto-generated tactical advice).
 *
 * Filled input + Enter (or Send) → fires /quick-action with
 * action="ask" + user_question=draft (Sub-prompt 4.6 chat path).
 *
 * The Tauri side handles dispatch in both cases — InputBar is purely
 * presentational. Quick-action button clicks pass the action enum;
 * input submit calls onSubmitQuestion.
 */

interface Props {
  draft: string;
  isAiStreaming: boolean;
  onDraftChange: (value: string) => void;
  onQuickAction: (action: QuickActionType) => void;
  onSubmitQuestion: (question: string) => void;
  /** Forwarded ref so the global Cmd+Enter handler can focus the input. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

const QUICK_ACTIONS: Array<{
  key: QuickActionType;
  label: string;
  icon: typeof Sparkles;
}> = [
  { key: "ask", label: "Assist", icon: Sparkles },
  { key: "follow_up", label: "Follow-up", icon: MessageCircleQuestion },
  { key: "fact_check", label: "Fact-check", icon: ShieldCheck },
  { key: "recap", label: "Recap", icon: RotateCw },
];

export function InputBar({
  draft,
  isAiStreaming,
  onDraftChange,
  onQuickAction,
  onSubmitQuestion,
  inputRef,
}: Props) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? localRef;

  // Auto-grow the textarea up to ~3 lines. Tailwind's resize-none
  // hides the OS handle; we adjust scrollHeight manually.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
  }, [draft, ref]);

  const trimmed = draft.trim();
  const canSubmit = trimmed.length > 0 && !isAiStreaming;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmitQuestion(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Plain Enter submits; Shift+Enter adds a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t border-white/10 bg-zinc-950/95 px-3 py-2.5 flex flex-col gap-2 shrink-0">
      {/* Quick actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {QUICK_ACTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onQuickAction(key)}
            disabled={isAiStreaming}
            className={cn(
              "inline-flex items-center gap-1.5",
              "px-2.5 py-1 rounded-md text-xs font-medium",
              "border border-white/10 bg-zinc-900",
              "text-zinc-200 hover:text-copilot-accent hover:border-copilot-accent/40",
              "transition-colors cursor-pointer",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60",
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Input + send */}
      <div
        className={cn(
          "flex items-end gap-2 rounded-lg border border-white/10 bg-zinc-900",
          "focus-within:border-copilot-accent/40",
          "transition-colors",
        )}
      >
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          rows={1}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your screen or conversation, or ⌘ ⏎ for Assist"
          disabled={isAiStreaming}
          className={cn(
            "flex-1 px-3 py-2 bg-transparent resize-none",
            "text-sm text-zinc-100 placeholder:text-zinc-600",
            "focus:outline-none",
            "disabled:opacity-50",
          )}
          style={{ maxHeight: "80px" }}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          aria-label="Send"
          className={cn(
            "m-1.5 p-1.5 rounded-md cursor-pointer",
            "transition-colors",
            canSubmit
              ? "bg-copilot-accent text-zinc-950 hover:bg-cyan-300"
              : "bg-zinc-800 text-zinc-500 cursor-not-allowed",
          )}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
