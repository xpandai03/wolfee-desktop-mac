/**
 * Teleprompter view — Phase 1 (script overlay) + Phase 2 (smooth
 * scroll, font-size control) + Phase 3 (time-based auto-scroll).
 *
 * Visual:
 *   - Active paragraph at `fontSize` px (24 / 28 / 32), font-semibold.
 *   - Surrounding paragraphs at fontSize-6 px, dimmed.
 *   - 5-paragraph render window around lineIdx so 2000-word scripts
 *     paint cheaply.
 *   - CSS opacity / transform transitions on the active swap give a
 *     gentle slide-up feel without disorienting the reader.
 *
 * Scroll:
 *   - Wheel over the view → onScroll(±1, "user") → reducer advances
 *     AND disables auto.
 *   - Global ⌘⌥↑/↓ hotkey (Rust → SCROLL_TELEPROMPTER source="user")
 *     does the same.
 *   - Footer "Manual ⇄ Auto" pill toggles autoScroll.
 *   - When auto: a setTimeout per paragraph, duration =
 *     wordCount / wpm * 60 s. Fires SCROLL_TELEPROMPTER source="auto"
 *     so it doesn't disable itself. Pauses if the page isn't visible.
 *
 * Footer:
 *   - "Manual ⌘⌥↑/↓" or "Auto · NNN wpm · −/+" (when auto).
 *   - "Line N of M".
 */
import { useEffect, useRef } from "react";
import clsx from "clsx";

type Props = {
  paragraphs: string[];
  lineIdx: number;
  fontSize: number;
  autoScroll: boolean;
  wpm: number;
  onScroll: (delta: number, source: "user" | "auto") => void;
  onToggleAuto: () => void;
  onSetWpm: (wpm: number) => void;
};

const WHEEL_STEP = 30; // px of cumulative wheel delta per paragraph step.
const MIN_PARAGRAPH_MS = 1200; // floor so single-word paragraphs aren't sub-second
const MAX_PARAGRAPH_MS = 30_000; // ceiling so a giant paragraph doesn't hang

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function TeleprompterView({
  paragraphs,
  lineIdx,
  fontSize,
  autoScroll,
  wpm,
  onScroll,
  onToggleAuto,
  onSetWpm,
}: Props) {
  const total = paragraphs.length;
  const activeFontSize = fontSize;
  const dimFontSize = Math.max(16, fontSize - 6);

  // ── Wheel accumulator (Phase 1, polished) ────────────────────────
  const accum = useRef(0);
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    accum.current += e.deltaY;
    if (accum.current > WHEEL_STEP) {
      console.log(`[teleprompter] wheel down → scroll +1 (accum=${accum.current.toFixed(0)}px)`);
      onScroll(1, "user");
      accum.current = 0;
    } else if (accum.current < -WHEEL_STEP) {
      console.log(`[teleprompter] wheel up → scroll -1 (accum=${accum.current.toFixed(0)}px)`);
      onScroll(-1, "user");
      accum.current = 0;
    }
  };

  // ── Phase 3 auto-advance timer ───────────────────────────────────
  // CRITICAL: `onScroll` is recreated every render of the parent (it's
  // an inline arrow that closes over `dispatch`). The parent re-renders
  // every TICK (250 ms). If we depended on `onScroll` in the effect's
  // deps, the effect would tear down and re-create the timer every
  // 250 ms — the timer (≥ 1.2 s) would never fire. So we stash
  // onScroll in a ref that's kept up to date but doesn't trigger
  // re-runs of the effect.
  const onScrollRef = useRef(onScroll);
  useEffect(() => {
    onScrollRef.current = onScroll;
  });

  useEffect(() => {
    if (!autoScroll) {
      console.log("[teleprompter] auto-scroll OFF — timer not armed");
      return;
    }
    if (lineIdx >= total - 1) {
      console.log("[teleprompter] auto-scroll at last paragraph — timer not armed");
      return;
    }

    const text = paragraphs[lineIdx] ?? "";
    const words = Math.max(1, wordCount(text));
    const seconds = (words / wpm) * 60;
    const ms = Math.max(
      MIN_PARAGRAPH_MS,
      Math.min(MAX_PARAGRAPH_MS, seconds * 1000),
    );
    console.log(
      `[teleprompter] auto-scroll ARMED — paragraph ${lineIdx + 1}/${total}, ${words} words @ ${wpm} wpm → ${ms} ms`,
    );

    let remaining = ms;
    let startedAt = 0;
    let handle: number | null = null;

    const start = () => {
      startedAt = Date.now();
      handle = window.setTimeout(() => {
        console.log(`[teleprompter] auto-advance fired (${ms} ms target)`);
        onScrollRef.current(1, "auto");
      }, remaining);
    };
    const stop = () => {
      if (handle != null) {
        window.clearTimeout(handle);
        handle = null;
        remaining -= Date.now() - startedAt;
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === "visible") {
        if (remaining > 0) {
          console.log(`[teleprompter] visible — resume (${remaining} ms left)`);
          start();
        }
      } else {
        console.log("[teleprompter] hidden — pause");
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisChange);
    };
    // Deliberately omit `onScroll` — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScroll, lineIdx, wpm, paragraphs, total]);

  // ── 5-paragraph window with ACTIVE PARAGRAPH ALWAYS CENTRED ──────
  // The visible window has 5 slots, slot 2 is always the active one.
  // Slots 0/1 = previous two paragraphs (or empty pads near the top);
  // slots 3/4 = next two paragraphs (or empty pads near the end).
  // This way the highlighted current line never moves vertically; the
  // text scrolls "through" it — the classic teleprompter feel.
  const visible: Array<{ idx: number; text: string } | null> = [];
  for (let offset = -2; offset <= 2; offset++) {
    const idx = lineIdx + offset;
    if (idx >= 0 && idx < total) {
      visible.push({ idx, text: paragraphs[idx] });
    } else {
      visible.push(null);
    }
  }

  return (
    <div
      onWheel={handleWheel}
      className="flex h-full flex-col select-none px-6 py-4"
      style={{ touchAction: "none" }}
    >
      {/* Script paragraphs — center column, active is the middle row.
          flex-1 makes this region fill the window so the footer pins
          to the bottom; items-stretch + per-row min-height keeps the
          spacing predictable as fontSize changes. */}
      <div className="flex flex-1 flex-col justify-center gap-3">
        {visible.map((p, i) => {
          const isActive = p?.idx === lineIdx;
          return p === null ? (
            <div
              key={`pad-${i}`}
              style={{ minHeight: dimFontSize * 1.4 }}
              aria-hidden
            />
          ) : (
            <p
              key={p.idx}
              className={clsx(
                // Color + size transition gives the swap a clear,
                // visible feel even though the slot itself doesn't move.
                "leading-[1.4] transition-all duration-300 ease-out",
                isActive
                  ? "font-semibold text-white opacity-100"
                  : "text-zinc-500 opacity-50",
              )}
              style={{ fontSize: isActive ? activeFontSize : dimFontSize }}
            >
              {isActive && <span className="mr-2 text-zinc-300">▸</span>}
              {p.text}
            </p>
          );
        })}
      </div>

      {/* ── Footer: Manual/Auto · WPM · Line N of M ──────────────── */}
      <div className="mt-5 flex items-center justify-between text-[11px] text-zinc-500">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleAuto}
            className={clsx(
              "rounded-full px-2 py-0.5 font-medium transition-colors",
              autoScroll
                ? "bg-blue-500/25 text-blue-200"
                : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700/70",
            )}
            title={
              autoScroll
                ? "Auto-scroll on — paragraphs advance at the WPM rate. Click to switch to manual."
                : "Manual scroll — wheel or ⌘⌥↑/↓ to advance. Click to enable auto-scroll."
            }
          >
            {autoScroll ? "Auto" : "Manual"}
          </button>
          {autoScroll ? (
            <span className="flex items-center gap-1 tabular-nums">
              <button
                type="button"
                onClick={() => onSetWpm(wpm - 10)}
                className="h-5 w-5 rounded bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700/70"
                aria-label="Slower"
              >
                −
              </button>
              <span className="w-12 text-center">{wpm} wpm</span>
              <button
                type="button"
                onClick={() => onSetWpm(wpm + 10)}
                className="h-5 w-5 rounded bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700/70"
                aria-label="Faster"
              >
                +
              </button>
            </span>
          ) : (
            <span className="opacity-70">⌘⌥↑/↓ to scroll · invisible to viewers</span>
          )}
        </div>
        <span className="tabular-nums">
          Line {Math.min(lineIdx + 1, total)} of {total}
        </span>
      </div>
    </div>
  );
}
