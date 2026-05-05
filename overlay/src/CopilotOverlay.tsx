import { useEffect, useReducer, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { Strip } from "@/components/Strip";
import { ExpandedPanel } from "@/components/ExpandedPanel";
import {
  initialOverlayState,
  overlayReducer,
} from "@/state/overlayReducer";
import type {
  TranscriptChunkPayload,
  SummaryUpdatedPayload,
  MomentDetectedPayload,
  SuggestionPendingPayload,
  SuggestionStreamingPayload,
  SuggestionCompletePayload,
  SuggestionFailedPayload,
  QuickActionType,
  ExpandedTab,
} from "@/state/types";

/**
 * Sub-prompt 4.6 (Cluely 1:1) — root overlay component. Two visual
 * modes managed by the reducer's `mode` field:
 *
 *   "strip"    → 600×44 thin bar with status + 5 controls
 *   "expanded" → 600×520 with tabs + chat thread + input bar
 *
 * Window resize is driven by Rust (wolfee-action: expand-overlay /
 * collapse-overlay). The reducer's mode mirrors the Rust window state
 * so React renders match.
 *
 * Phase 6 permission modal (sacred) renders inside ExpandedPanel via
 * bodyOverride when permissionNeeded is non-null. Auto-expands the
 * panel so the user actually sees the modal even if they were in
 * strip mode.
 */

type PermissionKind = "Microphone" | "ScreenRecording";

interface PermissionNeededPayload {
  kind: PermissionKind;
  session_id: string;
}

const TICK_INTERVAL_MS = 250;
const FAILURE_TOAST_MS = 1_200;

export default function CopilotOverlay() {
  const [permissionNeeded, setPermissionNeeded] =
    useState<PermissionNeededPayload | null>(null);
  const [overlayState, dispatch] = useReducer(
    overlayReducer,
    initialOverlayState,
  );
  const [isPaused, setIsPaused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Refs mirroring state for stable global listeners.
  const permissionNeededRef = useRef(permissionNeeded);
  useEffect(() => {
    permissionNeededRef.current = permissionNeeded;
  }, [permissionNeeded]);

  const modeRef = useRef(overlayState.mode);
  useEffect(() => {
    modeRef.current = overlayState.mode;
  }, [overlayState.mode]);

  // Tick — drives existing 2s reasoning fallback + 30s TTL.
  useEffect(() => {
    const id = window.setInterval(() => {
      dispatch({ type: "TICK", nowMs: Date.now() });
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // Dev mock generator (Ctrl+Shift+M / 2-5).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cleanup: (() => void) | undefined;
    void import("@/dev/mockEvents").then(({ registerMockHotkey }) => {
      cleanup = registerMockHotkey();
    });
    return () => {
      cleanup?.();
    };
  }, []);

  // Failure toast auto-clear.
  useEffect(() => {
    if (!overlayState.failureToast) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "CLEAR_FAILURE_TOAST" });
    }, FAILURE_TOAST_MS);
    return () => window.clearTimeout(t);
  }, [overlayState.failureToast]);

  // Window-level keydown + Tauri event listeners.
  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Phase 6 Esc precedence: dismiss the modal first.
      if (permissionNeededRef.current) {
        setPermissionNeeded(null);
        return;
      }
      // Esc collapses the panel if expanded; otherwise hides the strip.
      if (modeRef.current === "expanded") {
        void emit("wolfee-action", "collapse-overlay");
        return;
      }
      void win.hide();
    };
    window.addEventListener("keydown", handleKey);

    let permUnlisten: UnlistenFn | undefined;
    let transcriptUnlisten: UnlistenFn | undefined;
    let summaryUnlisten: UnlistenFn | undefined;
    let momentUnlisten: UnlistenFn | undefined;
    let pendingUnlisten: UnlistenFn | undefined;
    let suggestionUnlisten: UnlistenFn | undefined;
    let suggestionStreamingUnlisten: UnlistenFn | undefined;
    let suggestionFailedUnlisten: UnlistenFn | undefined;
    let panelStateUnlisten: UnlistenFn | undefined;
    let focusInputUnlisten: UnlistenFn | undefined;
    let chatStreamingUnlisten: UnlistenFn | undefined;
    let chatCompleteUnlisten: UnlistenFn | undefined;
    let chatFailedUnlisten: UnlistenFn | undefined;
    let pauseStateUnlisten: UnlistenFn | undefined;

    void (async () => {
      permUnlisten = await listen<PermissionNeededPayload>(
        "copilot-permission-needed",
        (event) => {
          console.log("[Copilot] permission needed:", event.payload);
          setPermissionNeeded(event.payload);
          // Auto-expand so the user actually sees the modal.
          void emit("wolfee-action", "expand-overlay");
        },
      );

      transcriptUnlisten = await listen<TranscriptChunkPayload>(
        "transcript-chunk",
        (event) => {
          dispatch({ type: "TRANSCRIPT_CHUNK", payload: event.payload });
        },
      );

      summaryUnlisten = await listen<SummaryUpdatedPayload>(
        "copilot-summary-updated",
        (event) => {
          dispatch({ type: "SUMMARY_UPDATED", payload: event.payload });
        },
      );

      momentUnlisten = await listen<MomentDetectedPayload>(
        "copilot-moment-detected",
        (event) => {
          dispatch({ type: "MOMENT_DETECTED", payload: event.payload });
        },
      );

      pendingUnlisten = await listen<SuggestionPendingPayload>(
        "copilot-suggestion-pending",
        (event) => {
          dispatch({ type: "SUGGESTION_PENDING", payload: event.payload });
        },
      );

      suggestionStreamingUnlisten = await listen<SuggestionStreamingPayload>(
        "copilot-suggestion-streaming",
        (event) => {
          dispatch({ type: "SUGGESTION_STREAMING", payload: event.payload });
        },
      );

      suggestionUnlisten = await listen<SuggestionCompletePayload>(
        "copilot-suggestion",
        (event) => {
          dispatch({ type: "SUGGESTION_COMPLETE", payload: event.payload });
          // Auto-expand on completion so the rep sees Wolfee's
          // suggestion in the chat thread without having to click.
          if (modeRef.current !== "expanded") {
            void emit("wolfee-action", "expand-overlay");
          }
        },
      );

      suggestionFailedUnlisten = await listen<SuggestionFailedPayload>(
        "copilot-suggestion-failed",
        (event) => {
          dispatch({ type: "SUGGESTION_FAILED", payload: event.payload });
        },
      );

      // Sub-prompt 4.6 — Rust mirror of mode change so the React side
      // stays in sync with the actual window size.
      panelStateUnlisten = await listen<{ mode: "strip" | "expanded" }>(
        "copilot-panel-state",
        (event) => {
          dispatch({ type: "SET_MODE", mode: event.payload.mode });
        },
      );

      // Sub-prompt 4.6 — Cmd+Enter from anywhere focuses the input.
      focusInputUnlisten = await listen("copilot-focus-input", () => {
        // If we're in strip mode, the panel needs to expand first.
        if (modeRef.current !== "expanded") {
          void emit("wolfee-action", "expand-overlay");
        }
        // Defer focus until after re-render flushes (panel may be
        // mid-resize / mid-mount).
        window.setTimeout(() => {
          inputRef.current?.focus();
        }, 80);
      });

      // Sub-prompt 4.6 — chat streaming events (separate from the
      // suggestion streaming events so the chat thread doesn't fight
      // with the auto-suggestion state machine).
      chatStreamingUnlisten = await listen<{
        ai_response_id: string;
        text: string;
      }>("copilot-chat-streaming", (event) => {
        dispatch({
          type: "AI_RESPONSE_DELTA",
          aiResponseId: event.payload.ai_response_id,
          text: event.payload.text,
        });
      });

      chatCompleteUnlisten = await listen<{
        ai_response_id: string;
        text: string;
      }>("copilot-chat-complete", (event) => {
        dispatch({
          type: "AI_RESPONSE_COMPLETE",
          aiResponseId: event.payload.ai_response_id,
          text: event.payload.text,
        });
      });

      chatFailedUnlisten = await listen<{
        ai_response_id: string;
        reason: string;
      }>("copilot-chat-failed", (event) => {
        dispatch({
          type: "AI_RESPONSE_FAILED",
          aiResponseId: event.payload.ai_response_id,
          reason: event.payload.reason,
        });
      });

      pauseStateUnlisten = await listen<{ paused: boolean }>(
        "copilot-pause-state",
        (event) => {
          setIsPaused(event.payload.paused);
        },
      );
    })();

    return () => {
      window.removeEventListener("keydown", handleKey);
      permUnlisten?.();
      transcriptUnlisten?.();
      summaryUnlisten?.();
      momentUnlisten?.();
      pendingUnlisten?.();
      suggestionUnlisten?.();
      suggestionStreamingUnlisten?.();
      suggestionFailedUnlisten?.();
      panelStateUnlisten?.();
      focusInputUnlisten?.();
      chatStreamingUnlisten?.();
      chatCompleteUnlisten?.();
      chatFailedUnlisten?.();
      pauseStateUnlisten?.();
    };
  }, []);

  // ── Strip control handlers ─────────────────────────────────────
  const handlePauseToggle = () => {
    void emit("wolfee-action", "toggle-copilot-pause");
  };
  const handleStop = () => {
    void emit("wolfee-action", "end-copilot-session");
  };
  const handleToggleExpand = () => {
    void emit(
      "wolfee-action",
      overlayState.mode === "expanded" ? "collapse-overlay" : "expand-overlay",
    );
  };
  const handleAppsClick = () => {
    // Sub-prompt 4.7 (Modes) will wire this. Stub for now so users
    // get a console hint instead of a silent click.
    console.log("[Copilot] Modes (Sub-prompt 4.7) — coming soon");
  };
  const handleClose = () => {
    void getCurrentWebviewWindow().hide();
  };

  // ── ExpandedPanel handlers ─────────────────────────────────────
  const handleTabChange = (tab: ExpandedTab) => {
    dispatch({ type: "SET_ACTIVE_TAB", tab });
  };
  const handleDraftChange = (value: string) => {
    dispatch({ type: "UPDATE_INPUT_DRAFT", value });
  };
  const handleQuickAction = (action: QuickActionType) => {
    void emit("wolfee-action", {
      type: "trigger-copilot-quick-action",
      action,
    });
  };
  const handleSubmitQuestion = (question: string) => {
    const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const aiResponseId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dispatch({
      type: "SUBMIT_USER_QUESTION",
      question,
      questionId,
      aiResponseId,
    });
    void emit("wolfee-action", {
      type: "submit-chat-question",
      question,
      ai_response_id: aiResponseId,
    });
  };

  const hasActiveSession = overlayState.fullTranscript.length > 0;
  const isAiStreaming = overlayState.streamingAiResponseId !== null;
  const showPermissionModal = permissionNeeded !== null;

  return (
    <div className="w-screen h-screen flex flex-col bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      <Strip
        mode={overlayState.mode}
        uiPhase={overlayState.uiPhase}
        hasActiveSession={hasActiveSession}
        isPaused={isPaused}
        onPauseToggle={handlePauseToggle}
        onStop={handleStop}
        onToggleExpand={handleToggleExpand}
        onAppsClick={handleAppsClick}
        onClose={handleClose}
      />

      <AnimatePresence initial={false}>
        {overlayState.mode === "expanded" && (
          <ExpandedPanel
            key="panel"
            activeTab={overlayState.activeTab}
            chatThread={overlayState.chatThread}
            fullTranscript={overlayState.fullTranscript}
            inputDraft={overlayState.inputDraft}
            isAiStreaming={isAiStreaming}
            onTabChange={handleTabChange}
            onDraftChange={handleDraftChange}
            onQuickAction={handleQuickAction}
            onSubmitQuestion={handleSubmitQuestion}
            inputRef={inputRef}
            bodyOverride={
              showPermissionModal ? (
                <PermissionModal
                  payload={permissionNeeded!}
                  onDismiss={() => setPermissionNeeded(null)}
                />
              ) : undefined
            }
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Phase 6 PermissionModal — SACRED, preserved verbatim from
// Sub-prompt 2 commit b8a19fb. Only the wrapper (inline-in-overlay
// vs panel-bodyOverride) is allowed to change in Sub-prompt 4.6.
// ──────────────────────────────────────────────────────────────────

function PermissionModal({
  payload,
  onDismiss,
}: {
  payload: PermissionNeededPayload;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const isMic = payload.kind === "Microphone";
  const kindLabel = isMic ? "microphone access" : "screen recording access";
  const settingsAction = isMic
    ? "open-system-settings-microphone"
    : "open-system-settings-screen-recording";

  const handleOpenSettings = async () => {
    setBusy(true);
    try {
      await emit("wolfee-action", settingsAction);
    } finally {
      setBusy(false);
    }
  };

  const handleTryAgain = async () => {
    setBusy(true);
    try {
      onDismiss();
      await emit("wolfee-action", "start-copilot-session");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center p-3 bg-zinc-950">
      <div
        className="w-full px-6 py-5 rounded-2xl border border-copilot-accent/40 shadow-2xl shadow-copilot-glow bg-zinc-900 text-white"
        role="dialog"
        aria-modal="true"
        aria-label="Wolfee Copilot permission needed"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_var(--tw-shadow-color)] shadow-amber-400" />
          <h1 className="text-base font-semibold tracking-tight">Permission needed</h1>
        </div>
        <p className="text-sm text-zinc-300 mt-3 leading-snug">
          Wolfee Copilot needs <span className="font-medium text-white">{kindLabel}</span> to
          listen to your call.
        </p>
        <p className="text-xs text-zinc-400 mt-2">
          Open System Settings → Privacy &amp; Security → {isMic ? "Microphone" : "Screen Recording"},
          enable Wolfee Desktop, then come back and click Try again.
        </p>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={handleOpenSettings}
            disabled={busy}
            className="flex-1 rounded-lg bg-white/95 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-60"
          >
            Open System Settings
          </button>
          <button
            type="button"
            onClick={handleTryAgain}
            disabled={busy}
            className="flex-1 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800 disabled:opacity-60"
          >
            Try again
          </button>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 w-full text-xs text-zinc-500 hover:text-zinc-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
