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
  /**
   * Sub-prompt 4.7 — populated for fact_check responses (search-
   * preview model). Backend extracts `annotations.url_citation`
   * entries and forwards them; frontend renders as clickable chips.
   */
  sources?: FactCheckSource[];
}

export interface FactCheckSource {
  title: string;
  url: string;
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

/**
 * Sub-prompt 4.7 — chat threads. Each thread is an independent
 * conversation with its own message history; the active thread's
 * messages are included as `chat_history` on every backend
 * /quick-action call so the LLM has conversational memory.
 *
 * "Auto-fired suggestions" do NOT live in threads — they go into a
 * separate stream so they don't pollute the user's conversation.
 */
export interface ChatThreadMeta {
  id: string;
  /** Default = `Chat 1`, `Chat 2`, ...; user-renamable via long-press. */
  name: string;
  createdAt: number;
  /** Snapshot of when this thread was started — Sub-prompt 4.8 may
   * use this for "what transcript was the rep looking at when they
   * asked this question." V1 just records it. */
  transcriptSnapshotAt: number;
}

export interface ChatThread extends ChatThreadMeta {
  messages: ChatMessage[];
}

// ── Sub-prompt 4.6 (Cluely 1:1 redesign) ────────────────────────────

/** Strip = thin always-visible bar; Expanded = panel with Chat+Transcript. */
export type OverlayMode = "strip" | "expanded";

/** Tab inside the expanded panel. */
export type ExpandedTab = "chat" | "transcript";

/**
 * Persistent chat thread inside the expanded panel. Auto-suggestions,
 * quick-action results, and user questions all flow into the same
 * scrollable history so the rep has a single source of truth for
 * what Wolfee has surfaced this call.
 */
export type ChatMessage =
  | {
      id: string;
      type: "auto-suggestion";
      trigger: TriggerType;
      text: string;
      secondary: string | null;
      reasoning: string | null;
      timestamp: number;
    }
  | {
      id: string;
      type: "quick-action-result";
      action: QuickActionType;
      text: string;
      secondary: string | null;
      reasoning: string | null;
      timestamp: number;
      /** Sub-prompt 4.7 — fact-check messages carry their search sources. */
      sources?: FactCheckSource[];
    }
  | {
      id: string;
      type: "user-question";
      question: string;
      timestamp: number;
    }
  | {
      id: string;
      /** Linked to the user-question id immediately above it in the thread. */
      questionId: string;
      type: "ai-response";
      text: string;
      timestamp: number;
      streaming: boolean;
    };

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

/**
 * Sub-prompt 6.0 — onboarding wizard. The wizard sits in
 * ExpandedPanel via bodyOverride and walks new users through 6 steps:
 * 1) what wolfee does, 2) the listen→suggest→recap loop,
 * 3) link account, 4) grant permissions, 5) pick a mode,
 * 6) you're ready. State persists per-user via tauri-plugin-store
 * so the wizard auto-resumes mid-tour after a quit.
 */
export type PermissionStatus = "granted" | "denied" | "undetermined";

export interface OnboardingPermissionStatus {
  mic: PermissionStatus | null;
  screen: PermissionStatus | null;
}

/**
 * Sub-prompt 5.0 — most-recently-finalized session, used to drive the
 * post-session takeover card. `null` outside the takeover window.
 */
export interface FinalizedSessionInfo {
  sessionId: string;
  shareSlug: string | null;
  durationMs: number | null;
  modeName: string | null;
  finalizedAtMs: number;
}

export interface OverlayState {
  uiPhase: UiPhase;
  /** Sub-prompt 4.6 — Cluely strip vs expanded panel. */
  mode: OverlayMode;
  /**
   * Sub-prompt 5.0 — first-launch welcome flag.
   *  - `null`  → not yet loaded from store (initial boot, before
   *               the welcome-flag-loaded event arrives).
   *  - `false` → never seen welcome → show it on first expand.
   *  - `true`  → already shown → skip.
   * Apps-grid icon respects this: if false, replay welcome; if true,
   * open wolfee.io/copilot/modes.
   */
  welcomeShown: boolean | null;
  /** Sub-prompt 5.0 — currently rendering the welcome card via panel
   * bodyOverride. Independent of welcomeShown so the user can replay
   * after dismiss. */
  welcomeOpen: boolean;
  /** Sub-prompt 5.0 — most recently finalized session metadata, drives
   * the SessionCompleteCard takeover. Null = no card visible. */
  lastFinalizedSession: FinalizedSessionInfo | null;
  /** Sub-prompt 5.0 — wall-clock when SessionCompleteCard was opened.
   * TICK auto-dismisses 8s later. Null when card not visible. */
  sessionCompleteOpenedAtMs: number | null;
  // ── Sub-prompt 6.0 — onboarding wizard ─────────────────────────
  /** True while the wizard is rendering (bodyOverride in expanded panel). */
  onboardingOpen: boolean;
  /** Current step 1..6. Persists between sessions so quit-mid-tour resumes. */
  onboardingStep: number;
  /**
   * - `null`  → not yet loaded from store
   * - `false` → never completed → wizard auto-shows on first launch
   * - `true`  → completed/skipped → only shows on tray "Show Onboarding Tour"
   */
  onboardingCompleted: boolean | null;
  /** True while Step 3 is polling for the auth-status flip. */
  pairingPolling: boolean;
  /** Step 4 — silent permission preflight results. */
  onboardingPermissionStatus: OnboardingPermissionStatus;
  /** Sub-prompt 4.6 — which tab is active in expanded mode. */
  activeTab: ExpandedTab;
  /**
   * Sub-prompt 4.6 — full transcript history for the Transcript tab.
   * The 2-utterance `transcript` array is for the legacy strip preview;
   * fullTranscript is the complete in-memory list for the panel view.
   * Capped at MAX_FULL_TRANSCRIPT to keep the React list manageable.
   */
  fullTranscript: Utterance[];
  /**
   * Sub-prompt 4.7 — multiple independent chat threads. The active
   * thread's messages are sent to the backend as chat_history so
   * the LLM has conversational memory. Replaces the single
   * chatThread field from Sub-prompt 4.6.
   */
  chatThreads: ChatThread[];
  /** Sub-prompt 4.7 — id of currently-displayed thread, or null
   * (initial state — empty Chat tab shows "start a chat" CTA). */
  activeThreadId: string | null;
  /**
   * Sub-prompt 4.7 — auto-fired moment suggestions live OUTSIDE
   * threads so they don't pollute user conversation history. Shown
   * as a small ribbon at the top of the Chat tab.
   */
  autoSuggestionStream: ChatMessage[];

  /** @deprecated Sub-prompt 4.7 — renamed to chatThreads. Kept until
   * all consumers migrate. Reducers no longer write to this field. */
  chatThread: ChatMessage[];
  /** Sub-prompt 4.6 — draft text in the input box. */
  inputDraft: string;
  /** Sub-prompt 4.6 — id of the in-flight AI streaming response, or null. */
  streamingAiResponseId: string | null;
  /**
   * Sub-prompt 4.7 — wall-clock when new content was appended to the
   * Chat tab while the user wasn't looking at it. Drives the brief
   * pulse animation on the tab label. Cleared by SET_ACTIVE_TAB:chat
   * or after PULSE_DURATION_MS via TICK.
   */
  chatTabPulseAt: number | null;
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
  | { type: "TICK"; nowMs: number }
  // Sub-prompt 4.6 (Cluely 1:1)
  | { type: "SET_MODE"; mode: OverlayMode }
  | { type: "SET_ACTIVE_TAB"; tab: ExpandedTab }
  | { type: "UPDATE_INPUT_DRAFT"; value: string }
  | { type: "SUBMIT_USER_QUESTION"; question: string; questionId: string; aiResponseId: string }
  | { type: "AI_RESPONSE_DELTA"; aiResponseId: string; text: string }
  | { type: "AI_RESPONSE_COMPLETE"; aiResponseId: string; text: string }
  | { type: "AI_RESPONSE_FAILED"; aiResponseId: string; reason: string }
  | { type: "CLEAR_CHAT_THREAD" }
  // Sub-prompt 4.7 — multi-thread chat
  | { type: "NEW_THREAD"; threadId: string }
  | { type: "SWITCH_THREAD"; threadId: string }
  | { type: "RENAME_THREAD"; threadId: string; name: string }
  | { type: "DELETE_THREAD"; threadId: string }
  // Sub-prompt 5.0 — onboarding + post-session takeover
  | { type: "LOAD_WELCOME_FLAG"; shown: boolean }
  | { type: "SHOW_WELCOME" }
  | { type: "DISMISS_WELCOME" }
  | {
      type: "SESSION_FINALIZED";
      sessionId: string;
      shareSlug: string | null;
      durationMs: number | null;
      modeName: string | null;
    }
  | { type: "DISMISS_SESSION_COMPLETE" }
  // Sub-prompt 6.0 — onboarding wizard
  | {
      type: "LOAD_ONBOARDING_FLAG";
      completed: boolean;
      lastStep: number;
    }
  | { type: "SHOW_ONBOARDING" }
  | { type: "ADVANCE_STEP" }
  | { type: "PREV_STEP" }
  | { type: "JUMP_TO_STEP"; step: number }
  | { type: "SKIP_TOUR" }
  | { type: "COMPLETE_ONBOARDING" }
  | { type: "SET_PAIRING_POLLING"; polling: boolean }
  | { type: "PAIRING_COMPLETE" }
  | { type: "SET_PERMISSION_STATUS"; payload: OnboardingPermissionStatus };

export const initialOverlayState: OverlayState = {
  uiPhase: "Idle",
  mode: "strip",
  welcomeShown: null,
  welcomeOpen: false,
  lastFinalizedSession: null,
  sessionCompleteOpenedAtMs: null,
  onboardingOpen: false,
  onboardingStep: 1,
  onboardingCompleted: null,
  pairingPolling: false,
  onboardingPermissionStatus: { mic: null, screen: null },
  activeTab: "chat",
  fullTranscript: [],
  chatThreads: [],
  activeThreadId: null,
  autoSuggestionStream: [],
  chatThread: [],
  inputDraft: "",
  streamingAiResponseId: null,
  chatTabPulseAt: null,
  transcript: [],
  summary: null,
  active: null,
  reasoningStartedAtMs: null,
  showingStartedAtMs: null,
  failureToast: null,
  copiedFlashAt: null,
};
