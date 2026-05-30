//! Custom-region drag-select overlay (recorder — Phase 1 source picker).
//!
//! Rendered in the content-protected `#/region-selector` window, which
//! covers the full primary display. The user drags a rectangle; on
//! confirm we emit `region-selected` with the rect in display-local
//! logical points (== SCK `content_rect` points on macOS, so Rust needs
//! no Retina conversion). Cancel/ESC emits `close-region-selector`.

import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

// display_id the Rust builder opened us on, echoed in the URL hash.
function readDisplayId(): number {
  const q = window.location.hash.split("?")[1] ?? "";
  const raw = new URLSearchParams(q).get("display");
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function rectFrom(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

const MIN_SIZE = 16; // ignore accidental clicks / hairline drags

export function RegionSelector() {
  const displayId = useRef(readDisplayId());
  const [start, setStart] = useState<Pt | null>(null);
  const [cur, setCur] = useState<Pt | null>(null);
  const [committed, setCommitted] = useState<Rect | null>(null);

  const dragRect = start && cur ? rectFrom(start, cur) : null;
  const rect = dragRect ?? committed;
  const valid = !!rect && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;

  const cancel = useCallback(() => {
    void emit("wolfee-action", "close-region-selector");
  }, []);

  const confirm = useCallback(() => {
    if (!rect || rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;
    void emit("wolfee-action", {
      type: "region-selected",
      display_id: displayId.current,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  }, [rect]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter") confirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, confirm]);

  function onDown(e: React.MouseEvent) {
    // Ignore clicks on the toolbar buttons.
    if ((e.target as HTMLElement).closest("[data-toolbar]")) return;
    const p = { x: e.clientX, y: e.clientY };
    setStart(p);
    setCur(p);
    setCommitted(null);
  }
  function onMove(e: React.MouseEvent) {
    if (start) setCur({ x: e.clientX, y: e.clientY });
  }
  function onUp() {
    if (dragRect) setCommitted(dragRect);
    setStart(null);
    setCur(null);
  }

  return (
    <div
      className="relative h-screen w-screen cursor-crosshair select-none overflow-hidden"
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      style={{ colorScheme: "dark" }}
    >
      {/* Dim everything; the selection is a clear cut-out via box-shadow. */}
      <div className="absolute inset-0 bg-black/35" />

      {rect && (
        <div
          className="absolute border-2 border-[#fb5b36]"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            // Punch a hole: the huge spread shadow dims only outside.
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
            background: "transparent",
          }}
        >
          <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      )}

      {/* Instructions / toolbar — content-protected, so never recorded. */}
      <div
        data-toolbar
        className="absolute left-1/2 top-6 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-[#1c1c1e]/95 px-3 py-2 text-[13px] text-white shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
      >
        <span className="px-1 text-[#c8c8cc]">
          {valid ? "Drag to adjust, then Record region" : "Drag to select a region"}
        </span>
        <button
          onClick={cancel}
          className="rounded-lg bg-[#2a2a2c] px-3 py-1 font-semibold text-[#e8e8ec] transition-colors hover:bg-[#333]"
        >
          Cancel
        </button>
        <button
          onClick={confirm}
          disabled={!valid}
          className={
            "rounded-lg px-3 py-1 font-semibold transition-colors " +
            (valid
              ? "bg-[#fb5b36] text-white hover:bg-[#ea4f2c]"
              : "cursor-default bg-[#3a2a26] text-[#9a9a9e]")
          }
        >
          Record region
        </button>
      </div>
    </div>
  );
}

export default RegionSelector;
