/**
 * Phase 1 Teleprompter view.
 *
 * Renders the user's script in the existing content-protected
 * Copilot overlay during a recording. The window is already
 * invisible to ScreenCaptureKit, so this text is visible to the
 * user but never to anyone watching the recording.
 *
 * Manual scroll only in Phase 1 — wheel over the view, or
 * ⌘⌥↑/↓ globally (the global hotkey emits
 * `copilot-teleprompter-scroll` → reducer SCROLL_TELEPROMPTER).
 * Phase 3 will add Deepgram-driven auto-scroll.
 *
 * Visual contract:
 *   - 28 px font, line-height 1.4 for the active paragraph.
 *   - 24 px and dimmed (~50% opacity) for surrounding paragraphs.
 *   - Renders a 5-paragraph window centred on `lineIdx` so even a
 *     very long script doesn't paint the whole DOM at once.
 *   - "Line N of M" footer, right-aligned, tiny.
 */
import { useRef } from "react";
import clsx from "clsx";

type Props = {
  paragraphs: string[];
  lineIdx: number;
  onScroll: (delta: number) => void;
};

export function TeleprompterView({ paragraphs, lineIdx, onScroll }: Props) {
  // Wheel accumulator — fires one paragraph step per ~30 px of vertical
  // wheel delta. Without this a trackpad swipe would race through the
  // whole script.
  const accum = useRef(0);
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    accum.current += e.deltaY;
    if (accum.current > 30) {
      onScroll(1);
      accum.current = 0;
    } else if (accum.current < -30) {
      onScroll(-1);
      accum.current = 0;
    }
  };

  // Render a 5-paragraph window around the active line. Fixed-size
  // window keeps layout stable as the user scrolls.
  const total = paragraphs.length;
  const winSize = 5;
  let start = Math.max(0, lineIdx - 1);
  let end = Math.min(total, start + winSize);
  // If we're near the end, pull the start back so we still show
  // `winSize` rows when there's room for them.
  start = Math.max(0, end - winSize);

  const visible: Array<{ idx: number; text: string } | null> = [];
  for (let i = start; i < end; i++) {
    visible.push({ idx: i, text: paragraphs[i] });
  }
  // Pad with nulls to keep the box from collapsing on short scripts.
  while (visible.length < winSize) visible.push(null);

  return (
    <div
      onWheel={handleWheel}
      className="select-none px-6 py-5"
      // Stop the wheel from bubbling up to the window — without this
      // the wheel also nudges the overlay's scroll position which we
      // don't want during teleprompter mode.
      style={{ touchAction: "none" }}
    >
      <div className="space-y-4">
        {visible.map((p, i) =>
          p === null ? (
            <div key={`pad-${i}`} className="h-7" aria-hidden />
          ) : (
            <p
              key={p.idx}
              className={clsx(
                "leading-[1.4] transition-colors duration-150",
                p.idx === lineIdx
                  ? "text-[28px] font-semibold text-zinc-50"
                  : "text-[22px] text-zinc-500/80",
              )}
            >
              {p.idx === lineIdx && (
                <span className="mr-2 text-zinc-400">▸</span>
              )}
              {p.text}
            </p>
          ),
        )}
      </div>
      <div className="mt-5 flex items-center justify-between text-[11px] text-zinc-600">
        <span className="opacity-70">⌘⌥↑/↓ to scroll · invisible to viewers</span>
        <span className="tabular-nums">
          Line {Math.min(lineIdx + 1, total)} of {total}
        </span>
      </div>
    </div>
  );
}
