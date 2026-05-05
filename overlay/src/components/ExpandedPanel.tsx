import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { ChatThread } from "./ChatThread";
import { TranscriptView } from "./TranscriptView";
import { InputBar } from "./InputBar";
import type {
  ChatMessage,
  ExpandedTab,
  QuickActionType,
  Utterance,
} from "@/state/types";

/**
 * Sub-prompt 4.6 (Cluely 1:1) — the panel that slides in below the
 * always-visible Strip when the user clicks the expand chevron.
 *
 * Layout (matches Cluely screenshots 2 + 3):
 *   ┌────────────────────────────────────────┐
 *   │  Chat │ Transcript                     │ ← tab bar
 *   ├────────────────────────────────────────┤
 *   │                                        │
 *   │     scrollable tab content             │
 *   │     (ChatThread or TranscriptView)     │
 *   │                                        │
 *   ├────────────────────────────────────────┤
 *   │ [Assist] [Follow-up] [Fact-check]…    │ ← always-visible
 *   │ ┌──────────────────────────────────┐ │   InputBar
 *   │ │ Ask about your screen…       [▶] │ │
 *   │ └──────────────────────────────────┘ │
 *   └────────────────────────────────────────┘
 *
 * Body container is flex-col — tab bar + content takes remaining
 * height, InputBar is shrink-0 at the bottom so it never gets
 * pushed off when content grows.
 */

interface Props {
  activeTab: ExpandedTab;
  chatThread: ChatMessage[];
  fullTranscript: Utterance[];
  inputDraft: string;
  isAiStreaming: boolean;
  onTabChange: (tab: ExpandedTab) => void;
  onDraftChange: (value: string) => void;
  onQuickAction: (action: QuickActionType) => void;
  onSubmitQuestion: (question: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Optional override for the body content (e.g. Phase 6 permission
   * modal). When set, hides tabs + body and renders the override
   * full-bleed. InputBar is also hidden so the modal owns the panel.
   */
  bodyOverride?: React.ReactNode;
}

export function ExpandedPanel({
  activeTab,
  chatThread,
  fullTranscript,
  inputDraft,
  isAiStreaming,
  onTabChange,
  onDraftChange,
  onQuickAction,
  onSubmitQuestion,
  inputRef,
  bodyOverride,
}: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex-1 flex flex-col min-h-0 bg-zinc-950"
    >
      {bodyOverride ? (
        <div className="flex-1 min-h-0">{bodyOverride}</div>
      ) : (
        <>
          <TabBar activeTab={activeTab} onTabChange={onTabChange} />

          <div className="flex-1 flex flex-col min-h-0">
            {activeTab === "chat" ? (
              <ChatThread messages={chatThread} />
            ) : (
              <TranscriptView utterances={fullTranscript} />
            )}
          </div>

          <InputBar
            draft={inputDraft}
            isAiStreaming={isAiStreaming}
            onDraftChange={onDraftChange}
            onQuickAction={onQuickAction}
            onSubmitQuestion={onSubmitQuestion}
            inputRef={inputRef}
          />
        </>
      )}
    </motion.div>
  );
}

interface TabBarProps {
  activeTab: ExpandedTab;
  onTabChange: (tab: ExpandedTab) => void;
}

function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="Panel content"
      className="flex items-center gap-1 px-3 pt-2 border-b border-white/5 shrink-0"
    >
      <Tab
        active={activeTab === "chat"}
        onClick={() => onTabChange("chat")}
        label="Chat"
      />
      <Tab
        active={activeTab === "transcript"}
        onClick={() => onTabChange("transcript")}
        label="Transcript"
      />
    </div>
  );
}

interface TabProps {
  active: boolean;
  onClick: () => void;
  label: string;
}

function Tab({ active, onClick, label }: TabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative px-3 py-2 text-xs font-medium cursor-pointer",
        "transition-colors focus:outline-none",
        active ? "text-copilot-accent" : "text-zinc-400 hover:text-zinc-200",
      )}
    >
      {label}
      {active && (
        <motion.span
          layoutId="tab-underline"
          className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full bg-copilot-accent"
        />
      )}
    </button>
  );
}
