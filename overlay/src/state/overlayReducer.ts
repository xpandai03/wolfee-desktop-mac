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
  TriggerType,
} from "./types";
import { initialOverlayState } from "./types";

const MAX_VISIBLE_UTTERANCES = 2;
const REASONING_FALLBACK_MS = 2_000;
const SHOWING_TTL_MS = 30_000;
const COPY_FLASH_MS = 1_200;
const FAILURE_TOAST_MS = 1_200;

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
      return { ...state, transcript: next };
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
      const { payload } = action.payload;
      if (state.active === null) return state;
      // If a previous suggestion is currently expanded, the user has
      // explicitly "kept" it — don't blow it away with a new auto-fire.
      // The new suggestion is dropped silently (Sub-prompt 6 could
      // queue these into a history view; V1 keeps it simple).
      if (state.active.expanded && state.uiPhase === "Showing") {
        return state;
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
