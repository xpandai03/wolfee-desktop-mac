/**
 * Reducer for the Sub-prompt 4 overlay state machine (plan §1, §3, §9).
 *
 * Shape:
 *   Idle ──► Reasoning ──► Streaming ──► Showing ──► Idle
 *                  │              │           │
 *                  ▼ 2s no delta  │           ▼ 30s TTL or Esc/click
 *                Idle             │           Idle
 *                                 ▼ stream error
 *                              Failed (→ Idle after 1.2s)
 *
 * Pure function. Side effects (timers, Tauri emits) live in
 * components/effects, not in here.
 */

import type {
  Action,
  OverlayState,
  Utterance,
  ActiveSuggestion,
  ChatMessage,
  ChatThread,
  TriggerType,
  QuickActionType,
} from "./types";
import { initialOverlayState } from "./types";

const MAX_VISIBLE_UTTERANCES = 2;
const MAX_FULL_TRANSCRIPT = 200;
const MAX_CHAT_THREAD = 100;
const REASONING_FALLBACK_MS = 2_000;
const SHOWING_TTL_MS = 30_000;
const COPY_FLASH_MS = 1_200;
const FAILURE_TOAST_MS = 1_200;
const PULSE_DURATION_MS = 2_500;
const SESSION_COMPLETE_AUTO_DISMISS_MS = 8_000;

// Sub-prompt 4.6 — quick-action triggers that should emit a
// chat-thread message instead of a transient suggestion card.
const QUICK_ACTION_TRIGGERS: ReadonlySet<string> = new Set([
  "follow_up",
  "fact_check",
  "recap",
]);

export { initialOverlayState };

export function overlayReducer(
  state: OverlayState,
  action: Action,
): OverlayState {
  switch (action.type) {
    case "TRANSCRIPT_CHUNK": {
      const { channel, started_at_ms, transcript, is_final } = action.payload;
      const key = `${channel}:${started_at_ms}`;
      const incoming: Utterance = {
        key,
        channel,
        text: transcript,
        isFinal: is_final,
        startedAtMs: started_at_ms,
      };

      // In-place substitution by key — partial → final upgrade
      // doesn't introduce a new entry, just replaces.
      const existingIndex = state.transcript.findIndex((u) => u.key === key);
      let next: Utterance[];
      if (existingIndex >= 0) {
        next = state.transcript.map((u, i) =>
          i === existingIndex ? incoming : u,
        );
      } else {
        next = [...state.transcript, incoming].slice(-MAX_VISIBLE_UTTERANCES);
      }

      // Sub-prompt 4.6 — also maintain the full history for the
      // Transcript tab. Same key-substitution model.
      const fullExistingIdx = state.fullTranscript.findIndex(
        (u) => u.key === key,
      );
      let fullNext: Utterance[];
      if (fullExistingIdx >= 0) {
        fullNext = state.fullTranscript.map((u, i) =>
          i === fullExistingIdx ? incoming : u,
        );
      } else {
        fullNext = [...state.fullTranscript, incoming].slice(
          -MAX_FULL_TRANSCRIPT,
        );
      }
      return { ...state, transcript: next, fullTranscript: fullNext };
    }

    case "SUMMARY_UPDATED":
      return { ...state, summary: action.payload.summary };

    case "MOMENT_DETECTED": {
      // The moment-detected event ALSO triggers Reasoning state
      // (in addition to the new suggestion-pending event from N3).
      // Defensive: if the N3 event fires first we're already in
      // Reasoning, this is a no-op.
      if (state.uiPhase !== "Idle" && state.uiPhase !== "Failed") {
        return state;
      }
      const { trigger, trigger_phrase } = action.payload;
      return enterReasoning(state, "moment", trigger, trigger_phrase);
    }

    case "SUGGESTION_PENDING": {
      // Sub-prompt 4 N3 — fired instantly on hotkey or moment.
      // Reasoning indicator appears with no dead air.
      const { trigger_source, trigger, trigger_phrase } = action.payload;
      // Sub-prompt 4.5 Decision N1 — user-click wins. A hotkey/quick-
      // action pending event always preempts whatever's currently
      // showing. Auto (moment) pendings still defer to anything in
      // flight (Rust side won't fire concurrently for moment anyway).
      if (
        trigger_source !== "hotkey" &&
        (state.uiPhase === "Streaming" || state.uiPhase === "Showing")
      ) {
        return state;
      }
      return enterReasoning(
        state,
        trigger_source,
        (trigger ?? "general") as TriggerType,
        trigger_phrase ?? null,
      );
    }

    case "SUGGESTION_STREAMING": {
      const { kind, text, suggestion_id } = action.payload;
      if (state.active === null) {
        // Stream arrived without a Reasoning entry — synthesize one
        // (covers the case where Rust didn't emit suggestion-pending,
        // e.g. an older build).
        const synthesized = enterReasoning(
          state,
          "moment",
          "general" as TriggerType,
          null,
        );
        return applyStreaming(synthesized, kind, text, suggestion_id);
      }
      return applyStreaming(state, kind, text, suggestion_id);
    }

    case "SUGGESTION_COMPLETE": {
      const { payload, sources } = action.payload;
      if (state.active === null) return state;
      // If a previous suggestion is currently expanded, the user has
      // explicitly "kept" it — don't blow it away with a new auto-fire.
      // The new suggestion is dropped silently (Sub-prompt 6 could
      // queue these into a history view; V1 keeps it simple).
      if (state.active.expanded && state.uiPhase === "Showing") {
        return state;
      }

      // Sub-prompt 4.7 routing:
      //   - Auto-fired moments (triggerSource = "moment") → autoSuggestionStream
      //   - User-clicked quick-actions (triggerSource = "hotkey") → active thread
      //     (creating one if no thread is active yet)
      const isQuickActionResult =
        state.active.triggerSource === "hotkey" &&
        QUICK_ACTION_TRIGGERS.has(payload.moment_type);
      const isAutoMoment = state.active.triggerSource === "moment";

      const chatMessage: ChatMessage = isQuickActionResult
        ? {
            id: payload.suggestion_id,
            type: "quick-action-result",
            action: payload.moment_type as QuickActionType,
            text: payload.primary,
            secondary: payload.secondary,
            reasoning: payload.reasoning,
            timestamp: Date.now(),
            // Sub-prompt 4.7 — sources accompany fact-check verdicts.
            sources: sources && sources.length > 0 ? sources : undefined,
          }
        : {
            id: payload.suggestion_id,
            type: "auto-suggestion",
            trigger: (payload.moment_type ?? "general") as TriggerType,
            text: payload.primary,
            secondary: payload.secondary,
            reasoning: payload.reasoning,
            timestamp: Date.now(),
          };

      let nextThreads = state.chatThreads;
      let nextActiveId = state.activeThreadId;
      let nextAutoStream = state.autoSuggestionStream;

      if (isAutoMoment) {
        // Auto-fired moment + ask-hotkey-without-typing both land
        // here. They go to the auto-suggestion stream, NOT a thread.
        nextAutoStream = appendChatMessage(state.autoSuggestionStream, chatMessage);
      } else {
        // User-clicked quick-action result. Land in the active
        // thread or create one if none exists.
        let threadId = state.activeThreadId;
        if (threadId === null) {
          const created = createNewThread(state.chatThreads.length);
          nextThreads = [...state.chatThreads, created];
          threadId = created.id;
          nextActiveId = threadId;
        }
        nextThreads = nextThreads.map((t) =>
          t.id === threadId
            ? { ...t, messages: appendChatMessage(t.messages, chatMessage) }
            : t,
        );
      }

      return {
        ...state,
        uiPhase: "Showing",
        active: {
          ...state.active,
          suggestionId: payload.suggestion_id,
          finalPrimary: payload.primary,
          finalSecondary: payload.secondary,
          reasoning: payload.reasoning,
          confidence: payload.confidence,
          ttlSeconds: payload.ttl_seconds,
          // Sync streamingPrimary in case finalPrimary differs from accumulated
          streamingPrimary: payload.primary,
          expanded: false,
        },
        chatThreads: nextThreads,
        activeThreadId: nextActiveId,
        autoSuggestionStream: nextAutoStream,
        chatTabPulseAt:
          state.activeTab === "chat" ? state.chatTabPulseAt : Date.now(),
        reasoningStartedAtMs: null,
        showingStartedAtMs: Date.now(),
      };
    }

    case "TOGGLE_EXPANDED": {
      if (state.active === null || state.uiPhase !== "Showing") return state;
      const expanded = !state.active.expanded;
      return {
        ...state,
        active: { ...state.active, expanded },
        // Reset the showing-started clock when collapsing so TTL
        // restarts from "now" rather than penalizing the user for
        // having read the expanded view.
        showingStartedAtMs: expanded ? state.showingStartedAtMs : Date.now(),
      };
    }

    case "SUGGESTION_FAILED": {
      return {
        ...state,
        uiPhase: "Idle",
        active: null,
        reasoningStartedAtMs: null,
        showingStartedAtMs: null,
        failureToast: "Couldn't generate suggestion",
      };
    }

    case "DISMISS_SUGGESTION": {
      // Caller is responsible for emitting `wolfee-action:
      // copilot-suggestion-dismissed` to release the Rust
      // ActiveSuggestionMutex (V1 — string payload per Decision N5).
      if (state.uiPhase === "Idle" && state.active === null) return state;
      return {
        ...state,
        uiPhase: "Idle",
        active: null,
        reasoningStartedAtMs: null,
        showingStartedAtMs: null,
      };
    }

    case "COPY_FLASH":
      return { ...state, copiedFlashAt: Date.now() };

    case "CLEAR_FAILURE_TOAST":
      return { ...state, failureToast: null };

    // ── Sub-prompt 4.6 (Cluely 1:1) ────────────────────────────

    case "SET_MODE":
      return { ...state, mode: action.mode };

    case "SET_ACTIVE_TAB":
      // Sub-prompt 4.7 — switching to Chat tab clears its pulse hint.
      return {
        ...state,
        activeTab: action.tab,
        chatTabPulseAt: action.tab === "chat" ? null : state.chatTabPulseAt,
      };

    case "UPDATE_INPUT_DRAFT":
      return { ...state, inputDraft: action.value };

    case "SUBMIT_USER_QUESTION": {
      const { question, questionId, aiResponseId } = action;
      const userMsg: ChatMessage = {
        id: questionId,
        type: "user-question",
        question,
        timestamp: Date.now(),
      };
      const aiSkeleton: ChatMessage = {
        id: aiResponseId,
        questionId,
        type: "ai-response",
        text: "",
        timestamp: Date.now(),
        streaming: true,
      };

      // Sub-prompt 4.7 — route to active thread; auto-create if none.
      let nextThreads = state.chatThreads;
      let activeId = state.activeThreadId;
      if (activeId === null) {
        const created = createNewThread(state.chatThreads.length);
        nextThreads = [...state.chatThreads, created];
        activeId = created.id;
      }
      nextThreads = nextThreads.map((t) =>
        t.id === activeId
          ? {
              ...t,
              messages: appendChatMessage(
                appendChatMessage(t.messages, userMsg),
                aiSkeleton,
              ),
            }
          : t,
      );

      return {
        ...state,
        chatThreads: nextThreads,
        activeThreadId: activeId,
        inputDraft: "",
        streamingAiResponseId: aiResponseId,
        activeTab: "chat",
      };
    }

    case "AI_RESPONSE_DELTA": {
      const { aiResponseId, text } = action;
      return {
        ...state,
        chatThreads: mapAcrossAllThreads(state.chatThreads, (m) =>
          m.id === aiResponseId && m.type === "ai-response"
            ? { ...m, text: m.text + text }
            : m,
        ),
      };
    }

    case "AI_RESPONSE_COMPLETE": {
      const { aiResponseId, text } = action;
      return {
        ...state,
        streamingAiResponseId:
          state.streamingAiResponseId === aiResponseId
            ? null
            : state.streamingAiResponseId,
        chatThreads: mapAcrossAllThreads(state.chatThreads, (m) =>
          m.id === aiResponseId && m.type === "ai-response"
            ? { ...m, text, streaming: false }
            : m,
        ),
        chatTabPulseAt:
          state.activeTab === "chat" ? state.chatTabPulseAt : Date.now(),
      };
    }

    case "AI_RESPONSE_FAILED": {
      const { aiResponseId, reason } = action;
      return {
        ...state,
        streamingAiResponseId:
          state.streamingAiResponseId === aiResponseId
            ? null
            : state.streamingAiResponseId,
        chatThreads: mapAcrossAllThreads(state.chatThreads, (m) =>
          m.id === aiResponseId && m.type === "ai-response"
            ? { ...m, text: `(error: ${reason})`, streaming: false }
            : m,
        ),
      };
    }

    case "CLEAR_CHAT_THREAD":
      // Sub-prompt 4.7 — clears the active thread's messages (NOT
      // the thread itself). Use DELETE_THREAD if you want to remove
      // a whole thread.
      return {
        ...state,
        chatThreads: state.chatThreads.map((t) =>
          t.id === state.activeThreadId ? { ...t, messages: [] } : t,
        ),
        streamingAiResponseId: null,
      };

    // Sub-prompt 4.7 — multi-thread management.
    case "NEW_THREAD": {
      const created: ChatThread = {
        id: action.threadId,
        name: defaultThreadName(state.chatThreads.length),
        createdAt: Date.now(),
        transcriptSnapshotAt: Date.now(),
        messages: [],
      };
      return {
        ...state,
        chatThreads: [...state.chatThreads, created],
        activeThreadId: created.id,
        activeTab: "chat",
      };
    }

    case "SWITCH_THREAD": {
      if (!state.chatThreads.some((t) => t.id === action.threadId)) {
        return state;
      }
      return {
        ...state,
        activeThreadId: action.threadId,
        activeTab: "chat",
      };
    }

    case "RENAME_THREAD": {
      return {
        ...state,
        chatThreads: state.chatThreads.map((t) =>
          t.id === action.threadId ? { ...t, name: action.name } : t,
        ),
      };
    }

    case "DELETE_THREAD": {
      const remaining = state.chatThreads.filter(
        (t) => t.id !== action.threadId,
      );
      const nextActive =
        state.activeThreadId === action.threadId
          ? remaining[remaining.length - 1]?.id ?? null
          : state.activeThreadId;
      return {
        ...state,
        chatThreads: remaining,
        activeThreadId: nextActive,
      };
    }

    // ── Sub-prompt 5.0 — onboarding + post-session takeover ───────

    case "LOAD_WELCOME_FLAG": {
      // Rust replied with the persisted flag. If the user has never
      // seen welcome before, surface it on the next expand cycle —
      // CopilotOverlay's effect drives that side, this just records.
      return { ...state, welcomeShown: action.shown };
    }

    case "SHOW_WELCOME":
      return { ...state, welcomeOpen: true };

    case "DISMISS_WELCOME":
      // Marking shown=true here is optimistic; Rust persistence is
      // fire-and-forget alongside the dispatch (CopilotOverlay emits
      // mark-welcome-shown on the same click).
      return { ...state, welcomeOpen: false, welcomeShown: true };

    case "SESSION_FINALIZED":
      return {
        ...state,
        lastFinalizedSession: {
          sessionId: action.sessionId,
          shareSlug: action.shareSlug,
          durationMs: action.durationMs,
          modeName: action.modeName,
          finalizedAtMs: Date.now(),
        },
        sessionCompleteOpenedAtMs: Date.now(),
      };

    case "DISMISS_SESSION_COMPLETE":
      return {
        ...state,
        lastFinalizedSession: null,
        sessionCompleteOpenedAtMs: null,
      };

    // ── Sub-prompt 6.0 — onboarding wizard ─────────────────────────

    case "LOAD_ONBOARDING_FLAG":
      // Boot read of persisted flag. lastStep is clamped to 1..6 so a
      // corrupted store value can't deadlock the wizard. If completed,
      // the wizard stays closed until the user opens it from the tray.
      return {
        ...state,
        onboardingCompleted: action.completed,
        onboardingStep: Math.min(Math.max(action.lastStep || 1, 1), 6),
      };

    case "SHOW_ONBOARDING":
      // Tray-driven re-open or first-launch open. Always start at the
      // user's last step (or 1 if they never started). Does NOT mutate
      // onboardingCompleted — re-opening from tray after completion
      // is intentional (recovery path).
      return {
        ...state,
        onboardingOpen: true,
      };

    case "ADVANCE_STEP":
      return {
        ...state,
        onboardingStep: Math.min(state.onboardingStep + 1, 6),
      };

    case "PREV_STEP":
      return {
        ...state,
        onboardingStep: Math.max(state.onboardingStep - 1, 1),
      };

    case "JUMP_TO_STEP":
      return {
        ...state,
        onboardingStep: Math.min(Math.max(action.step, 1), 6),
      };

    case "SKIP_TOUR":
      return {
        ...state,
        onboardingOpen: false,
        onboardingCompleted: true,
        pairingPolling: false,
      };

    case "COMPLETE_ONBOARDING":
      return {
        ...state,
        onboardingOpen: false,
        onboardingCompleted: true,
        pairingPolling: false,
      };

    case "SET_PAIRING_POLLING":
      return { ...state, pairingPolling: action.polling };

    case "PAIRING_COMPLETE":
      // Idempotent: if already past Step 3, no-op (prevents re-jumping
      // backward when the user pairs after manually advancing).
      if (state.onboardingStep > 3) return state;
      return {
        ...state,
        onboardingStep: 4,
        pairingPolling: false,
      };

    case "SET_PERMISSION_STATUS":
      return {
        ...state,
        onboardingPermissionStatus: action.payload,
      };

    case "TICK": {
      // Driven by a 250ms interval in CopilotOverlay. Handles
      // time-based transitions: 2s reasoning fallback, 30s TTL,
      // failure-toast clear, copy-flash clear.
      let next = state;

      if (
        next.uiPhase === "Reasoning" &&
        next.reasoningStartedAtMs !== null &&
        action.nowMs - next.reasoningStartedAtMs >= REASONING_FALLBACK_MS
      ) {
        // 2s no-delta fallback — silently drop back to Idle.
        // No visible error per plan §9 (error UX would be more
        // disruptive than the brief ghost card).
        next = {
          ...next,
          uiPhase: "Idle",
          active: null,
          reasoningStartedAtMs: null,
        };
      }

      // Auto-dismiss after TTL — but ONLY if the user hasn't
      // expanded the suggestion. Expanded means "keep this until I
      // X out" per the PO 2026-05-04 UX feedback.
      if (
        next.uiPhase === "Showing" &&
        next.showingStartedAtMs !== null &&
        next.active !== null &&
        !next.active.expanded &&
        action.nowMs - next.showingStartedAtMs >= SHOWING_TTL_MS
      ) {
        next = {
          ...next,
          uiPhase: "Idle",
          active: null,
          showingStartedAtMs: null,
        };
      }

      if (
        next.copiedFlashAt !== null &&
        action.nowMs - next.copiedFlashAt >= COPY_FLASH_MS
      ) {
        next = { ...next, copiedFlashAt: null };
      }

      // Sub-prompt 4.7 — auto-clear the Chat tab pulse so the
      // animation only runs once per new content event.
      if (
        next.chatTabPulseAt !== null &&
        action.nowMs - next.chatTabPulseAt >= PULSE_DURATION_MS
      ) {
        next = { ...next, chatTabPulseAt: null };
      }

      // Sub-prompt 5.0 — SessionCompleteCard auto-dismiss after 8s.
      // Driven by TICK so the timer survives panel collapse/re-expand
      // cleanly and there's no setTimeout to leak across remounts.
      if (
        next.sessionCompleteOpenedAtMs !== null &&
        action.nowMs - next.sessionCompleteOpenedAtMs >=
          SESSION_COMPLETE_AUTO_DISMISS_MS
      ) {
        next = {
          ...next,
          lastFinalizedSession: null,
          sessionCompleteOpenedAtMs: null,
        };
      }

      // Failure toast uses its own action because the duration
      // (1.2s) doesn't align cleanly with TICK granularity. The
      // CLEAR_FAILURE_TOAST action handles that.
      void FAILURE_TOAST_MS;

      return next;
    }

    default:
      return state;
  }
}

// ── helpers ──────────────────────────────────────────────────────

function enterReasoning(
  state: OverlayState,
  triggerSource: "moment" | "hotkey",
  trigger: TriggerType,
  triggerPhrase: string | null,
): OverlayState {
  const active: ActiveSuggestion = {
    suggestionId: null,
    trigger,
    triggerSource,
    triggerPhrase,
    streamingPrimary: "",
    finalPrimary: null,
    finalSecondary: null,
    reasoning: null,
    confidence: 0,
    ttlSeconds: 30,
    expanded: false,
  };
  return {
    ...state,
    uiPhase: "Reasoning",
    active,
    reasoningStartedAtMs: Date.now(),
    showingStartedAtMs: null,
    failureToast: null,
  };
}

function applyStreaming(
  state: OverlayState,
  kind: "start" | "delta" | "complete",
  text: string | null,
  suggestionId: string,
): OverlayState {
  if (state.active === null) return state;

  if (kind === "start") {
    // First chunk after suggestion-pending — transition to Streaming
    // and clear any accumulated text.
    return {
      ...state,
      uiPhase: "Streaming",
      active: {
        ...state.active,
        suggestionId,
        streamingPrimary: "",
      },
      reasoningStartedAtMs: null,
    };
  }

  if (kind === "delta" && text) {
    return {
      ...state,
      uiPhase: state.uiPhase === "Reasoning" ? "Streaming" : state.uiPhase,
      active: {
        ...state.active,
        suggestionId,
        streamingPrimary: state.active.streamingPrimary + text,
      },
      reasoningStartedAtMs: null,
    };
  }

  // kind === "complete" — handled by SUGGESTION_COMPLETE action.
  return state;
}

/**
 * Append a chat message + drop the oldest if we'd exceed MAX_CHAT_THREAD.
 * Last-N-wins so a long call doesn't unbounded-grow the React list.
 */
function appendChatMessage(
  thread: ChatMessage[],
  msg: ChatMessage,
): ChatMessage[] {
  return [...thread, msg].slice(-MAX_CHAT_THREAD);
}

// Sub-prompt 4.7 helpers —————————————————————————————————————————

function defaultThreadName(existingCount: number): string {
  return `Chat ${existingCount + 1}`;
}

function createNewThread(existingCount: number): ChatThread {
  const now = Date.now();
  return {
    id: `thread-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: defaultThreadName(existingCount),
    createdAt: now,
    transcriptSnapshotAt: now,
    messages: [],
  };
}

/** Apply a per-message map across every thread. Useful for AI
 * response delta routing where we don't track which thread a
 * given ai_response_id lives in. */
function mapAcrossAllThreads(
  threads: ChatThread[],
  fn: (m: ChatMessage) => ChatMessage,
): ChatThread[] {
  return threads.map((t) => ({ ...t, messages: t.messages.map(fn) }));
}

/** Selector — messages from the active thread (or [] if no active). */
export function activeThreadMessages(state: OverlayState): ChatMessage[] {
  if (state.activeThreadId === null) return [];
  const t = state.chatThreads.find((x) => x.id === state.activeThreadId);
  return t?.messages ?? [];
}

/**
 * Selector: should the suggestion card show the last-5-seconds opacity
 * fade warning? Used by SuggestionCard to drive the Tailwind class.
 */
export function isInTtlFadeWindow(
  state: OverlayState,
  nowMs: number,
): boolean {
  if (
    state.uiPhase !== "Showing" ||
    state.showingStartedAtMs === null ||
    state.active === null
  ) {
    return false;
  }
  const elapsed = nowMs - state.showingStartedAtMs;
  const ttlMs = state.active.ttlSeconds * 1000;
  return elapsed >= ttlMs - 5_000 && elapsed < ttlMs;
}
