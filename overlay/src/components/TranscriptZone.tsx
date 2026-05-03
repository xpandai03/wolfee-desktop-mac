import React from "react";
import { cn } from "@/lib/utils";
import type { Utterance } from "@/state/types";

/**
 * Last-2-utterances live transcript view (plan §3).
 *
 * Partials render with `opacity-60 italic`; finals solid.
 * Stable keys ensure partial → final substitution doesn't re-mount
 * the React node (avoids losing in-progress focus state).
 *
 * No timestamps in V1. No scrolling — utterances drop off the top
 * as new ones arrive. Older history lives in Notes (separate
 * product) or the rolling summary (hidden in V1).
 */

interface Props {
  utterances: Utterance[];
}

function TranscriptZoneImpl({ utterances }: Props) {
  return (
    <div className="h-[100px] overflow-hidden px-3 py-1 space-y-1">
      {utterances.map((u) => (
        <div key={u.key} className="flex items-baseline gap-2 leading-snug">
          <span className="shrink-0 text-zinc-500 text-[10px] uppercase tracking-wider w-12">
            {u.channel === "user" ? "You" : "Speakers"}
          </span>
          <span
            className={cn(
              "text-zinc-100 text-sm leading-snug min-w-0",
              !u.isFinal && "opacity-60 italic",
            )}
          >
            {u.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export const TranscriptZone = React.memo(TranscriptZoneImpl);
