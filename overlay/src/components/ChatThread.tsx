import React, { useEffect, useRef, useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/copyToClipboard";
import { labelFor } from "@/lib/triggerLabels";
import type {
  ChatMessage,
  FactCheckSource,
  QuickActionType,
} from "@/state/types";

/**
 * Sub-prompt 4.6 (Cluely 1:1) — chat thread inside the expanded panel's
 * Chat tab. Auto-suggestions, quick-action results, and user-typed
 * questions all flow into the same vertically-scrollable history.
 *
 * Auto-scrolls to the latest message on append unless the user has
 * manually scrolled up — in which case we leave the scroll position
 * alone (avoid yanking content out from under their cursor).
 */

interface Props {
  messages: ChatMessage[];
  /** Sub-prompt 4.7 — auto-fired moment suggestions surface in a
   * separate dimmed ribbon at the top so they don't pollute the
   * user's conversation. */
  autoSuggestionStream?: ChatMessage[];
  /** Sub-prompt 4.7 — when false, the user has no active thread.
   * Empty state shows the "start a chat" CTA instead of just a
   * blank panel. */
  hasActiveThread?: boolean;
}

export function ChatThread({
  messages,
  autoSuggestionStream = [],
  hasActiveThread = true,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Track whether the user is at the bottom; if so, auto-scroll on
  // new messages. If they've scrolled up to read history, leave it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const showEmpty = messages.length === 0;
  const showAutoRibbon = autoSuggestionStream.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {showAutoRibbon && (
        <AutoSuggestionRibbon stream={autoSuggestionStream} />
      )}

      {showEmpty ? (
        <div className="flex-1 flex items-center justify-center px-6 py-8">
          <div className="text-center max-w-sm">
            {hasActiveThread ? (
              <>
                <p className="text-sm text-zinc-300 leading-relaxed">
                  This chat is empty.
                </p>
                <p className="text-xs text-zinc-500 leading-relaxed mt-2">
                  Use the quick actions below or type a question — your
                  follow-ups stay in this thread.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-300 leading-relaxed">
                  Start a chat.
                </p>
                <p className="text-xs text-zinc-500 leading-relaxed mt-2">
                  Click <span className="text-copilot-accent">+ New chat</span>
                  {" "}above, or just type a question — your conversation will
                  build up so follow-ups stay in context.
                </p>
              </>
            )}
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto py-2 space-y-1 chat-scroll min-h-0"
        >
          {messages.map((m) => (
            <ChatMessageView key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Sub-prompt 4.7 — auto-fired suggestions in a small dimmed ribbon
 * above the user's active thread. Visually distinct so the rep
 * recognizes "this is Wolfee surfacing something on its own" vs
 * "this is the chat I'm in." Only shows the most recent 1-2.
 */
function AutoSuggestionRibbon({ stream }: { stream: ChatMessage[] }) {
  const recent = stream.slice(-2);
  return (
    <div className="px-3 py-1.5 bg-amber-500/5 border-b border-amber-500/15 shrink-0">
      <div className="text-[10px] uppercase tracking-wider text-amber-300/80 mb-0.5">
        Auto-suggestions
      </div>
      <div className="space-y-1">
        {recent.map((m) => {
          if (m.type === "auto-suggestion") {
            return (
              <div key={m.id} className="text-xs text-zinc-200 leading-snug">
                <span className="text-amber-300/80 font-semibold mr-1.5">
                  ⚠
                </span>
                {m.text}
              </div>
            );
          }
          if (m.type === "quick-action-result") {
            return (
              <div key={m.id} className="text-xs text-zinc-200 leading-snug">
                {m.text}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function ChatMessageView({ message }: { message: ChatMessage }) {
  if (message.type === "user-question") {
    return <UserBubble text={message.question} timestamp={message.timestamp} />;
  }
  if (message.type === "ai-response") {
    return (
      <AiResponseBubble
        text={message.text}
        timestamp={message.timestamp}
        streaming={message.streaming}
      />
    );
  }
  if (message.type === "quick-action-result") {
    return (
      <SuggestionBubble
        badge={badgeForAction(message.action)}
        text={message.text}
        secondary={message.secondary}
        reasoning={message.reasoning}
        timestamp={message.timestamp}
        sources={message.sources}
      />
    );
  }
  // auto-suggestion
  return (
    <SuggestionBubble
      badge={`⚠ ${labelFor(message.trigger)}`}
      text={message.text}
      secondary={message.secondary}
      reasoning={message.reasoning}
      timestamp={message.timestamp}
    />
  );
}

function UserBubble({ text, timestamp }: { text: string; timestamp: number }) {
  return (
    <div className="px-3 py-1.5 flex justify-end">
      <div className="max-w-[80%] flex flex-col items-end gap-1">
        <div className="bg-copilot-accent/20 border border-copilot-accent/30 rounded-2xl rounded-tr-sm px-3 py-1.5 text-sm text-zinc-50 leading-snug">
          {text}
        </div>
        <span className="text-[10px] text-zinc-600 px-1">
          {formatTime(timestamp)}
        </span>
      </div>
    </div>
  );
}

function AiResponseBubble({
  text,
  timestamp,
  streaming,
}: {
  text: string;
  timestamp: number;
  streaming: boolean;
}) {
  const showCursor = streaming;
  const showText = text.length > 0;
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-copilot-accent">
          Wolfee
        </span>
        <span className="text-[10px] text-zinc-600">
          {formatTime(timestamp)}
        </span>
      </div>
      <p className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap break-words">
        {showText ? text : streaming ? "Thinking…" : ""}
        {showCursor && (
          <span className="inline-block w-1 h-3 ml-0.5 bg-copilot-accent/70 animate-pulse" />
        )}
      </p>
      {!streaming && showText && <CopyAffordance text={text} />}
    </div>
  );
}

function SuggestionBubble({
  badge,
  text,
  secondary,
  reasoning,
  timestamp,
  sources,
}: {
  badge: string;
  text: string;
  secondary: string | null;
  reasoning: string | null;
  timestamp: number;
  sources?: FactCheckSource[];
}) {
  const [open, setOpen] = useState(false);
  const hasSources = sources && sources.length > 0;
  return (
    <div className="px-3 py-1.5 group">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "w-full text-left rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2",
          "hover:border-copilot-accent/30 hover:bg-zinc-900",
          "transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60",
        )}
      >
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-copilot-accent">
            {badge}
          </span>
          <span className="text-[10px] text-zinc-600">
            {formatTime(timestamp)}
          </span>
        </div>
        <p className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap break-words">
          {text}
        </p>
        {open && secondary && (
          <p className="mt-2 text-xs text-zinc-300 leading-snug before:content-['↳_'] before:text-zinc-500">
            {secondary}
          </p>
        )}
        {open && reasoning && (
          <p className="mt-2 text-xs text-zinc-400 leading-snug italic">
            <span className="not-italic text-zinc-500 mr-1">why:</span>
            {reasoning}
          </p>
        )}
      </button>
      {/* Sub-prompt 4.7 — fact-check source chips. Always rendered
          when present (no need to expand the card). Click opens in
          system browser via Rust open_url. */}
      {hasSources && <SourcesRow sources={sources!} />}
      <CopyAffordance text={text} />
    </div>
  );
}

/**
 * Sub-prompt 4.7 — small clickable chip-row of fact-check citations.
 * Click → emit wolfee-action open-external-url → Rust opens in
 * system default browser via the existing open_url helper.
 */
function SourcesRow({ sources }: { sources: FactCheckSource[] }) {
  const handleOpen = (url: string) => {
    void emit("wolfee-action", { type: "open-external-url", url });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">
        Sources
      </span>
      {sources.map((s, i) => {
        const host = hostnameOf(s.url);
        return (
          <button
            key={`${s.url}-${i}`}
            type="button"
            onClick={() => handleOpen(s.url)}
            title={s.url}
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md shrink-0",
              "text-[10px] border border-white/10 bg-zinc-900/40",
              "text-zinc-300 hover:text-copilot-accent hover:border-copilot-accent/40",
              "transition-colors cursor-pointer",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60",
            )}
          >
            <ExternalLink className="w-2.5 h-2.5" />
            <span className="truncate max-w-[140px]">{s.title || host}</span>
          </button>
        );
      })}
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function CopyAffordance({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <div className="flex justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy"
        className="text-[10px] text-zinc-500 hover:text-zinc-200 inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
      >
        {copied ? (
          <>
            <Check className="w-3 h-3" />
            Copied
          </>
        ) : (
          <>
            <Copy className="w-3 h-3" />
            Copy
          </>
        )}
      </button>
    </div>
  );
}

function badgeForAction(action: QuickActionType): string {
  switch (action) {
    case "ask":
      return "Assist";
    case "follow_up":
      return "Follow-up";
    case "fact_check":
      return "Fact-check";
    case "recap":
      return "Recap";
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
