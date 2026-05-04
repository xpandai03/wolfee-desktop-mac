/**
 * TypeScript types for Sub-prompt 4 overlay state machine.
 *
 * Mirrors Rust event payloads emitted by Sub-prompt 2/3 + the new
 * Sub-prompt 4 N3 event (`copilot-suggestion-pending`).
 *
 * Keep these in sync with:
 *   - `src-tauri/src/copilot/transcribe/deepgram.rs` (transcript-chunk)
 *   - `src-tauri/src/copilot/intelligence/summary_worker.rs` (summary-updated)
 *   - `src-tauri/src/copilot/intelligence/moment_worker.rs` (moment-detected)
 *   - `src-tauri/src/copilot/intelligence/suggest_client.rs` (suggestion + streaming + failed)
 *   - `src-tauri/src/lib.rs` (suggestion-pending — Sub-prompt 4 N3 additive)
 */

// ── Tauri event payloads ─────────────────────────────────────────

export interface TranscriptChunkPayload {
  session_id: string;
  channel: "user" | "speakers";
  is_final: boolean;
  transcript: string;
  confidence: number;
  started_at_ms: number;
  ended_at_ms: number;
}

export interface SummaryUpdatedPayload {
  session_id: string;
  summary: string;
  generated_at_ms: number;
  generation_count: number;
}

export interface MomentDetectedPayload {
  session_id: string;
  trigger: TriggerType;
  trigger_phrase: string | null;
  urgency: number;
  rationale: string;
}

/**
 * Sub-prompt 4 N3 — emitted instantly when ⌘⌥G is pressed or a moment
 * fires, BEFORE the LLM call begins. Eliminates 200-800ms dead air.
 */
export interface SuggestionPendingPayload {
  trigger_source: "moment" | "hotkey";
  trigger?: TriggerType | null;
  trigger_phrase?: string | null;
}

export interface SuggestionStreamingPayload {
  session_id: string;
  suggestion_id: string;
  kind: "start" | "delta" | "complete";
  text: string | null;
  moment_type: string | null;
}

export interface SuggestionCompletePayload {
  session_id: string;
  // Inner payload is what the suggest_client.rs run_stream emits via
  // #[derive(Serialize)] CompletePayload { session_id, payload }.
  // The reducer reads action.payload.payload — not flat.
  payload: {
    suggestion_id: string;
    moment_type: string;
    primary: string;
    secondary: string | null;
    confidence: number;
    reasoning: string;
    ttl_seconds: number;
  };
}

export interface SuggestionFailedPayload {
  session_id: string;
  reason: string;
}

// ── Trigger types (mirror backend allowlist, plan §4) ────────────

export type TriggerType =
  | "objection"
  | "pricing_question"
  | "silence_after_question"
  | "decision_moment"
  | "buying_signal"
  | "confusion"
  | "competitor_mentioned"
  | "question_asked"
  | "general"
  // Sub-prompt 4.5 quick-action moment_types — surfaced for badge label
  // routing (labelFor) and reducer payload typing.
  | "follow_up"
  | "fact_check"
  | "recap";

export type TriggerSource = "moment" | "hotkey";

// Sub-prompt 4.5 — the 4 user-clickable action buttons.
export type QuickActionType = "ask" | "follow_up" | "fact_check" | "recap";

// ── Reducer state ────────────────────────────────────────────────

export type UiPhase =
  | "Idle"
  | "Reasoning"
  | "Streaming"
  | "Showing"
  | "Failed";

export type DismissReason = "esc" | "click" | "auto";

export interface Utterance {
  /** Stable React key: `${channel}:${started_at_ms}` */
  key: string;
  channel: "user" | "speakers";
  text: string;
  isFinal: boolean;
  startedAtMs: number;
}

export interface ActiveSuggestion {
  suggestionId: string | null;
  trigger: TriggerType;
  triggerSource: TriggerSource;
  triggerPhrase: string | null;
  /** Accumulated streaming text (filled by SUGGESTION_STREAMING delta events). */
  streamingPrimary: string;
  /** Final payload, populated by SUGGESTION_COMPLETE. Null while still streaming. */
  finalPrimary: string | null;
  finalSecondary: string | null;
  /** Reasoning string from the LLM. Visible in expanded view only. */
  reasoning: string | null;
  /** Confidence (0.0-1.0). Currently shown only in expanded view, per Decision N4. */
  confidence: number;
  ttlSeconds: number;
  /**
   * User clicked the suggestion to "keep" it — TTL paused, full
   * primary + secondary + reasoning visible at larger sizes. Stays
   * until X is clicked. Auto-suggestions arriving while expanded
   * are queued (V1 just drops them; replaces on collapse).
   */
  expanded: boolean;
}

export interface OverlayState {
  uiPhase: UiPhase;
  /** Last 2 utterances (older drop off). */
  transcript: Utterance[];
  /** Latest rolling summary text (hidden in V1 but kept for Sub-prompt 5+). */
  summary: string | null;
  /** Active suggestion or null when uiPhase = Idle. */
  active: ActiveSuggestion | null;
  /** Wall-clock when uiPhase entered Reasoning (for 2s no-delta fallback). */
  reasoningStartedAtMs: number | null;
  /** Wall-clock when uiPhase entered Showing (for 30s TTL). */
  showingStartedAtMs: number | null;
  /** Brief "Couldn't generate suggestion" toast — auto-clears after 1.2s. */
  failureToast: string | null;
  /** Brief "Copied ✓" footer flash — auto-clears after 1.2s. */
  copiedFlashAt: number | null;
}

// ── Reducer actions ──────────────────────────────────────────────

export type Action =
  | { type: "TRANSCRIPT_CHUNK"; payload: TranscriptChunkPayload }
  | { type: "SUMMARY_UPDATED"; payload: SummaryUpdatedPayload }
  | { type: "MOMENT_DETECTED"; payload: MomentDetectedPayload }
  | { type: "SUGGESTION_PENDING"; payload: SuggestionPendingPayload }
  | { type: "SUGGESTION_STREAMING"; payload: SuggestionStreamingPayload }
  | { type: "SUGGESTION_COMPLETE"; payload: SuggestionCompletePayload }
  | { type: "SUGGESTION_FAILED"; payload: SuggestionFailedPayload }
  | { type: "DISMISS_SUGGESTION"; via: DismissReason }
  | { type: "TOGGLE_EXPANDED" }
  | { type: "COPY_FLASH" }
  | { type: "CLEAR_FAILURE_TOAST" }
  | { type: "TICK"; nowMs: number };

export const initialOverlayState: OverlayState = {
  uiPhase: "Idle",
  transcript: [],
  summary: null,
  active: null,
  reasoningStartedAtMs: null,
  showingStartedAtMs: null,
  failureToast: null,
  copiedFlashAt: null,
};
