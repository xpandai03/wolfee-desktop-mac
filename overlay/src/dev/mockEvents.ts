/**
 * Dev-only mock event generator (plan §11).
 *
 * Toggled with `Ctrl+Shift+M` when `import.meta.env.DEV` is true.
 * Fires synthetic Tauri events into the same listener registrations
 * the production overlay uses, so the engineer can iterate visual
 * design without needing the backend running.
 *
 * Uses `@tauri-apps/api/event::emit` — the dev server runs inside
 * a Tauri devUrl webview, so emit() goes through the real Tauri
 * IPC bridge. The overlay's listen() calls don't know or care
 * that the events came from the frontend instead of Rust.
 */

import { emit } from "@tauri-apps/api/event";
import {
  MOCK_TRANSCRIPT_LINES,
  MOCK_SUGGESTIONS,
  MOCK_SUMMARY_TEXTS,
} from "./fixtures";

const FAKE_SESSION_ID = "mock-session-00000000";

/**
 * Run a fake call session: feed transcript chunks at 600-1200ms
 * intervals, fire a moment + suggestion every ~30s, periodically
 * emit a summary update. Returns a stop() function.
 */
export function runMockSession(): () => void {
  console.log("[Copilot/dev] mock session starting");
  let stopped = false;
  let lineIndex = 0;
  let momentTimer: number | undefined;
  let summaryTimer: number | undefined;
  let transcriptTimer: number | undefined;

  // Transcript loop — partials then final per line.
  const fireNextLine = async () => {
    if (stopped) return;
    const line = MOCK_TRANSCRIPT_LINES[lineIndex % MOCK_TRANSCRIPT_LINES.length];
    const startedAtMs = Date.now();

    // Partial 1 (first 1/2 of text)
    await emit("transcript-chunk", {
      session_id: FAKE_SESSION_ID,
      channel: line.channel,
      is_final: false,
      transcript: line.text.slice(0, Math.max(8, Math.floor(line.text.length / 2))),
      confidence: 0.7,
      started_at_ms: startedAtMs,
      ended_at_ms: startedAtMs + 1500,
    });

    if (stopped) return;
    await sleep(220);

    // Final
    await emit("transcript-chunk", {
      session_id: FAKE_SESSION_ID,
      channel: line.channel,
      is_final: true,
      transcript: line.text,
      confidence: 0.95,
      started_at_ms: startedAtMs,
      ended_at_ms: startedAtMs + 2000,
    });

    lineIndex += 1;
    transcriptTimer = window.setTimeout(fireNextLine, 700 + Math.random() * 600);
  };

  // Moment + streaming suggestion loop — every 30s
  let suggestionIndex = 0;
  const fireNextSuggestion = async () => {
    if (stopped) return;
    const sug = MOCK_SUGGESTIONS[suggestionIndex % MOCK_SUGGESTIONS.length];
    suggestionIndex += 1;

    // 1. moment-detected (parallel emit of suggestion-pending too)
    await emit("copilot-moment-detected", {
      session_id: FAKE_SESSION_ID,
      trigger: sug.trigger,
      trigger_phrase: sug.trigger_phrase,
      urgency: 4,
      rationale: sug.reasoning,
    });
    await emit("copilot-suggestion-pending", {
      trigger_source: "moment",
      trigger: sug.trigger,
      trigger_phrase: sug.trigger_phrase,
    });

    // 2. ~700ms later, streaming start
    await sleep(700 + Math.random() * 500);
    if (stopped) return;
    const suggestionId = `mock-${Date.now()}`;
    await emit("copilot-suggestion-streaming", {
      session_id: FAKE_SESSION_ID,
      suggestion_id: suggestionId,
      kind: "start",
      text: null,
      moment_type: sug.trigger,
    });

    // 3. Stream the primary text in 4-6 word chunks
    const words = sug.primary.split(/(\s+)/);
    for (let i = 0; i < words.length; i++) {
      if (stopped) return;
      await sleep(60 + Math.random() * 80);
      await emit("copilot-suggestion-streaming", {
        session_id: FAKE_SESSION_ID,
        suggestion_id: suggestionId,
        kind: "delta",
        text: words[i],
        moment_type: null,
      });
    }

    // 4. complete
    await sleep(120);
    if (stopped) return;
    await emit("copilot-suggestion", {
      session_id: FAKE_SESSION_ID,
      suggestion_id: suggestionId,
      payload: {
        suggestion_id: suggestionId,
        moment_type: sug.trigger,
        primary: sug.primary,
        secondary: sug.secondary,
        confidence: sug.confidence,
        reasoning: sug.reasoning,
        ttl_seconds: 30,
      },
    });

    // Schedule next moment
    momentTimer = window.setTimeout(fireNextSuggestion, 30_000);
  };

  // Summary loop — every 30s
  let summaryGeneration = 0;
  const fireNextSummary = async () => {
    if (stopped) return;
    summaryGeneration += 1;
    const summary =
      MOCK_SUMMARY_TEXTS[summaryGeneration % MOCK_SUMMARY_TEXTS.length];
    await emit("copilot-summary-updated", {
      session_id: FAKE_SESSION_ID,
      summary,
      generated_at_ms: Date.now(),
      generation_count: summaryGeneration,
    });
    summaryTimer = window.setTimeout(fireNextSummary, 30_000);
  };

  // Kick off all three loops
  void fireNextLine();
  momentTimer = window.setTimeout(fireNextSuggestion, 8_000); // first moment ~8s in
  summaryTimer = window.setTimeout(fireNextSummary, 30_000);

  return () => {
    stopped = true;
    if (transcriptTimer !== undefined) window.clearTimeout(transcriptTimer);
    if (momentTimer !== undefined) window.clearTimeout(momentTimer);
    if (summaryTimer !== undefined) window.clearTimeout(summaryTimer);
    console.log("[Copilot/dev] mock session stopped");
  };
}

/**
 * Wire Ctrl+Shift+M as the mock-mode toggle. Idempotent: returns
 * a teardown that removes the listener.
 *
 * GUARD: only register if `import.meta.env.DEV`. Production builds
 * (vite build) tree-shake the call away.
 */
export function registerMockHotkey(): () => void {
  if (!import.meta.env.DEV) return () => {};

  let stop: (() => void) | null = null;
  const handle = (e: KeyboardEvent) => {
    if (!(e.ctrlKey && e.shiftKey && (e.key === "M" || e.key === "m"))) return;
    e.preventDefault();
    if (stop) {
      stop();
      stop = null;
    } else {
      stop = runMockSession();
    }
  };
  window.addEventListener("keydown", handle);
  return () => {
    window.removeEventListener("keydown", handle);
    if (stop) stop();
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
