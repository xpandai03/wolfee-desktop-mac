import React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { ChatThread } from "./ChatThread";
import { TranscriptView } from "./TranscriptView";
import { InputBar } from "./InputBar";
import { ThreadSwitcher } from "./ThreadSwitcher";
import type {
  ChatMessage,
  ChatThread as ChatThreadModel,
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
  /** Messages of the active thread only (selector-derived). */
  chatThread: ChatMessage[];
  /** All threads for the switcher chip-row. */
  chatThreads: ChatThreadModel[];
  activeThreadId: string | null;
  /** Auto-fired moment suggestions — separate ribbon, not part of threads. */
  autoSuggestionStream: ChatMessage[];
  fullTranscript: Utterance[];
  inputDraft: string;
  isAiStreaming: boolean;
  /** Sub-prompt 4.8 — show "View on Web" link once a session has been finalized. */
  showViewOnWeb?: boolean;
  onViewOnWeb?: () => void;
  /**
   * Sub-prompt 4.7 — when truthy, briefly highlights the Chat tab
   * (subtle ring) to signal that new content arrived while the user
   * was on Transcript. Cleared by the reducer 2.5s after set.
   */
  chatTabPulseAt: number | null;
  onTabChange: (tab: ExpandedTab) => void;
  onDraftChange: (value: string) => void;
  onQuickAction: (action: QuickActionType) => void;
  onSubmitQuestion: (question: string) => void;
  onNewThread: () => void;
  onSwitchThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
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
  chatThreads,
  activeThreadId,
  autoSuggestionStream,
  fullTranscript,
  inputDraft,
  isAiStreaming,
  chatTabPulseAt,
  onTabChange,
  onDraftChange,
  onQuickAction,
  onSubmitQuestion,
  onNewThread,
  onSwitchThread,
  onDeleteThread,
  showViewOnWeb,
  onViewOnWeb,
  inputRef,
  bodyOverride,
}: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      // Sub-prompt 4.7 — match the strip's glassmorphic look so the
      // strip + panel read as one floating element. Top corners
      // squared (the strip owns those); bottom corners rounded.
      className="flex-1 flex flex-col min-h-0 bg-zinc-950/70 backdrop-blur-md backdrop-saturate-150 border border-t-0 border-white/10 rounded-b-2xl shadow-lg shadow-black/40"
    >
      {bodyOverride ? (
        <div className="flex-1 min-h-0">{bodyOverride}</div>
      ) : (
        <>
          <TabBar
            activeTab={activeTab}
            onTabChange={onTabChange}
            chatTabPulseAt={chatTabPulseAt}
            showViewOnWeb={showViewOnWeb}
            onViewOnWeb={onViewOnWeb}
          />

          {activeTab === "chat" && (
            <ThreadSwitcher
              threads={chatThreads}
              activeThreadId={activeThreadId}
              onNewThread={onNewThread}
              onSwitchThread={onSwitchThread}
              onDeleteThread={onDeleteThread}
            />
          )}

          <div className="flex-1 flex flex-col min-h-0">
            {activeTab === "chat" ? (
              <ChatThread
                messages={chatThread}
                autoSuggestionStream={autoSuggestionStream}
                hasActiveThread={activeThreadId !== null}
              />
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
            onNewThread={onNewThread}
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
  chatTabPulseAt: number | null;
  showViewOnWeb?: boolean;
  onViewOnWeb?: () => void;
}

function TabBar({
  activeTab,
  onTabChange,
  chatTabPulseAt,
  showViewOnWeb,
  onViewOnWeb,
}: TabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="Panel content"
      className="flex items-center justify-between px-3 pt-2 border-b border-white/5 shrink-0"
    >
      <div className="flex items-center gap-1">
        <Tab
          active={activeTab === "chat"}
          onClick={() => onTabChange("chat")}
          label="Chat"
          pulse={chatTabPulseAt !== null && activeTab !== "chat"}
        />
        <Tab
          active={activeTab === "transcript"}
          onClick={() => onTabChange("transcript")}
          label="Transcript"
        />
      </div>
      {showViewOnWeb && onViewOnWeb && (
        <button
          type="button"
          onClick={onViewOnWeb}
          title="View this session on wolfee.io"
          className="inline-flex items-center gap-1 px-2 py-1 mb-1 rounded-md text-[11px] font-medium text-zinc-400 hover:text-copilot-accent hover:bg-white/5 transition-colors cursor-pointer"
        >
          View on web
          <svg
            className="w-3 h-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M14 5l7 7m0 0l-7 7m7-7H3"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

interface TabProps {
  active: boolean;
  onClick: () => void;
  label: string;
  pulse?: boolean;
}

function Tab({ active, onClick, label, pulse }: TabProps) {
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
      {/* Sub-prompt 4.7 — pulse dot on the inactive Chat tab when
          new content arrives. Auto-clears via reducer TICK after 2.5s. */}
      {pulse && (
        <motion.span
          key={`pulse-${label}`}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          className="absolute right-1 top-1.5 w-1.5 h-1.5 rounded-full bg-copilot-accent shadow-[0_0_6px_rgba(34,211,238,0.7)]"
        />
      )}
    </button>
  );
}
