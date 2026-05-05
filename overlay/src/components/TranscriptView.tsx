import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Utterance } from "@/state/types";

/**
 * Sub-prompt 4.6 (Cluely 1:1) — full-history transcript view shown in
 * the expanded panel's Transcript tab. Same data source as the legacy
 * 2-utterance preview but with the room to render the entire session
 * history. Auto-scrolls to the most recent utterance unless the user
 * has manually scrolled up.
 *
 * Speaker labeling matches Cluely:
 *   "user"     → "You" (right-aligned bubble, accent-tinted)
 *   "speakers" → "Speakers" (left-aligned bubble, neutral)
 */

interface Props {
  utterances: Utterance[];
}

export function TranscriptView({ utterances }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distFromBottom < 40;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [utterances]);

  if (utterances.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-8">
        <div className="text-center">
          <p className="text-sm text-zinc-300">Waiting for audio…</p>
          <p className="text-xs text-zinc-500 mt-2">
            Once the call starts, both sides of the conversation will stream in
            here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto py-2 space-y-1.5 chat-scroll"
    >
      {utterances.map((u) => (
        <UtteranceRow key={u.key} utterance={u} />
      ))}
    </div>
  );
}

function UtteranceRow({ utterance }: { utterance: Utterance }) {
  const isYou = utterance.channel === "user";
  return (
    <div
      className={cn(
        "px-3 flex flex-col gap-0.5",
        isYou ? "items-end" : "items-start",
      )}
    >
      <span
        className={cn(
          "text-[10px] uppercase tracking-wider font-medium px-1",
          isYou ? "text-copilot-accent" : "text-zinc-500",
        )}
      >
        {isYou ? "You" : "Speakers"}
      </span>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-1.5 text-sm leading-snug whitespace-pre-wrap break-words",
          isYou
            ? "bg-copilot-accent/15 border border-copilot-accent/25 rounded-tr-sm text-zinc-50"
            : "bg-zinc-900/80 border border-white/5 rounded-tl-sm text-zinc-100",
          !utterance.isFinal && "italic opacity-60",
        )}
      >
        {utterance.text}
      </div>
    </div>
  );
}
