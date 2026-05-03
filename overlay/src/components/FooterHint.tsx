import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 22px footer strip below the suggestion zone.
 *
 * Two responsibilities:
 *   1. Show a brief failure toast ("Couldn't generate suggestion")
 *      when the suggest stream errors.
 *   2. Otherwise show the keyboard hint that auto-fades 3s after
 *      the very first time the overlay opens.
 */

interface Props {
  failureToast: string | null;
}

export function FooterHint({ failureToast }: Props) {
  const [hintFaded, setHintFaded] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setHintFaded(true), 3_000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="h-[22px] px-3 flex items-center justify-center select-none">
      {failureToast ? (
        <span className="text-[11px] text-zinc-400">{failureToast}</span>
      ) : (
        <span
          className={cn(
            "text-[11px] text-zinc-500 transition-opacity duration-1000",
            hintFaded ? "opacity-0" : "opacity-50",
          )}
          aria-hidden={hintFaded}
        >
          ⌘⌥W to toggle · ⌘⌥G to ask · Esc to dismiss
        </span>
      )}
    </div>
  );
}
