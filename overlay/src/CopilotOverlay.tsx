import { useEffect, useReducer, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { Strip } from "@/components/Strip";
import { ExpandedPanel } from "@/components/ExpandedPanel";
import { WelcomeCard } from "@/components/WelcomeCard";
import { SessionCompleteCard } from "@/components/SessionCompleteCard";
import {
  activeThreadMessages,
  initialOverlayState,
  overlayReducer,
} from "@/state/overlayReducer";
import type {
  ChatMessage,
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
 * Sub-prompt 4.7 — flatten a ChatMessage into the wire shape the
 * backend expects in `chat_history` (a list of {role, content}
 * pairs). User-question → role:user; ai-response / quick-action-
 * result / auto-suggestion → role:assistant. Auto-suggestions don't
 * normally end up in user threads but the type guard is cheap.
 */
function toChatHistoryWire(
  msg: ChatMessage,
): { role: "user" | "assistant"; content: string } | null {
  switch (msg.type) {
    case "user-question":
      return { role: "user", content: msg.question };
    case "ai-response":
      return msg.text ? { role: "assistant", content: msg.text } : null;
    case "quick-action-result":
    case "auto-suggestion":
      return { role: "assistant", content: msg.text };
  }
}

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

// Sub-prompt 4.8 — wolfee.io web base. Hardcoded here for V1 since
// the desktop ships against a single backend. Sub-prompt 6 settings
// can override per-deploy if needed.
const WOLFEE_WEB_BASE = "https://wolfee.io";

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
  const [hasFinalizedSession, setHasFinalizedSession] = useState(false);
  // Sub-prompt 4.9 — surface finalize failures to the user so a missing
  // recap on wolfee.io isn't silently swallowed. Auto-clears 6s after set.
  const [finalizeFailureReason, setFinalizeFailureReason] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Sub-prompt 4.8 — most recently finalized session id (drives the
  // View on Web link target). Ref so the click handler stays stable.
  const lastFinalizedSessionId = useRef<string | null>(null);

  // Refs mirroring state for stable global listeners.
  const permissionNeededRef = useRef(permissionNeeded);
  useEffect(() => {
    permissionNeededRef.current = permissionNeeded;
  }, [permissionNeeded]);

  const modeRef = useRef(overlayState.mode);
  useEffect(() => {
    modeRef.current = overlayState.mode;
  }, [overlayState.mode]);

  // Sub-prompt 5.0 — refs for welcome flag + welcomeOpen so the apps-
  // grid handler stays stable across the lifetime of this component
  // and doesn't need to be recreated whenever the flag flips.
  const welcomeShownRef = useRef(overlayState.welcomeShown);
  useEffect(() => {
    welcomeShownRef.current = overlayState.welcomeShown;
  }, [overlayState.welcomeShown]);
  const welcomeOpenRef = useRef(overlayState.welcomeOpen);
  useEffect(() => {
    welcomeOpenRef.current = overlayState.welcomeOpen;
  }, [overlayState.welcomeOpen]);

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
      // Sub-prompt 5.0 — Esc dismisses welcome / session-complete
      // cards in preference to collapsing the panel, so the rep
      // can quickly clear the takeover without losing the strip.
      if (welcomeOpenRef.current) {
        dispatch({ type: "DISMISS_WELCOME" });
        void emit("wolfee-action", { type: "mark-welcome-shown" });
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
    let newThreadUnlisten: UnlistenFn | undefined;
    let finalizedUnlisten: UnlistenFn | undefined;
    let sessionFailedUnlisten: UnlistenFn | undefined;
    let welcomeFlagUnlisten: UnlistenFn | undefined;

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

      // Sub-prompt 4.8 — Rust signals after a session was successfully
      // finalized + pushed. Track the id so the "View on Web" link
      // can deep-link to the recap. Auto-open browser is handled
      // Rust-side based on user preferences.
      // Sub-prompt 5.0 — payload now also carries duration_ms +
      // mode_used_name for the post-session takeover card. We
      // dispatch SESSION_FINALIZED to open the card; the reducer
      // owns the 8s auto-dismiss.
      finalizedUnlisten = await listen<{
        session_id: string;
        share_slug: string | null;
        duration_ms?: number | null;
        mode_used_name?: string | null;
      }>("copilot-session-finalized", (event) => {
        lastFinalizedSessionId.current = event.payload.session_id;
        setHasFinalizedSession(true);
        dispatch({
          type: "SESSION_FINALIZED",
          sessionId: event.payload.session_id,
          shareSlug: event.payload.share_slug ?? null,
          durationMs: event.payload.duration_ms ?? null,
          modeName: event.payload.mode_used_name ?? null,
        });
        // Auto-expand so the takeover is visible. If user happens to
        // be in strip mode we promote them; otherwise no-op.
        if (modeRef.current !== "expanded") {
          void emit("wolfee-action", "expand-overlay");
        }
      });

      // Sub-prompt 5.0 — Rust replies with the persisted welcome flag
      // on boot (we ask via `request-welcome-flag` immediately after
      // the listener is wired). The reducer flips welcomeShown +
      // shows the card if it has never been seen.
      welcomeFlagUnlisten = await listen<{ shown: boolean }>(
        "welcome-flag-loaded",
        (event) => {
          dispatch({ type: "LOAD_WELCOME_FLAG", shown: event.payload.shown });
          if (!event.payload.shown) {
            // First launch — show the card and expand the panel so
            // it's actually visible. Without this the user would be
            // stuck staring at the strip with no idea what to do.
            dispatch({ type: "SHOW_WELCOME" });
            if (modeRef.current !== "expanded") {
              void emit("wolfee-action", "expand-overlay");
            }
          }
        },
      );

      // Kick off the welcome-flag round-trip now that the listener
      // is in place. Rust replies on `welcome-flag-loaded` above.
      void emit("wolfee-action", { type: "request-welcome-flag" });

      // Sub-prompt 4.9 — finalize failure surfacing. Rust emits this
      // when the /finalize POST returns non-2xx or networks out. Show
      // the user a brief banner so a missing recap on wolfee.io
      // isn't silently swallowed.
      sessionFailedUnlisten = await listen<{
        session_id: string;
        reason: string;
      }>("copilot-session-failed", (event) => {
        console.warn("[Copilot] session finalize failed:", event.payload);
        setFinalizeFailureReason(event.payload.reason || "unknown error");
      });

      // Sub-prompt 4.7 — ⌘⇧N hotkey from Rust dispatches NEW_THREAD
      // and expands the panel so the user lands on the fresh chat.
      newThreadUnlisten = await listen("copilot-new-thread", () => {
        const threadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        dispatch({ type: "NEW_THREAD", threadId });
        if (modeRef.current !== "expanded") {
          void emit("wolfee-action", "expand-overlay");
        }
        window.setTimeout(() => {
          inputRef.current?.focus();
        }, 80);
      });
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
      newThreadUnlisten?.();
      finalizedUnlisten?.();
      sessionFailedUnlisten?.();
      welcomeFlagUnlisten?.();
    };
  }, []);

  // Sub-prompt 4.9 — auto-clear the finalize failure banner after 6s.
  useEffect(() => {
    if (finalizeFailureReason === null) return;
    const t = window.setTimeout(() => {
      setFinalizeFailureReason(null);
    }, 6000);
    return () => window.clearTimeout(t);
  }, [finalizeFailureReason]);

  // ── Strip control handlers ─────────────────────────────────────
  const handlePauseToggle = () => {
    void emit("wolfee-action", "toggle-copilot-pause");
  };
  const handleStop = () => {
    // Sub-prompt 4.8 — push transcript + chat threads + auto-suggestions
    // to backend BEFORE the session-end teardown so the post-session
    // web view has all the artifacts. mode_used_id is tracked Rust-side
    // (set on context-window submit). Auto-open browser flow is also
    // handled inside the Rust handler based on user preferences.
    const flatChatThreads = overlayState.chatThreads.map((t) => ({
      id: t.id,
      name: t.name,
      messages: t.messages,
      createdAt: t.createdAt,
    }));
    const flatAutoSuggestions = overlayState.autoSuggestionStream.map((m) => {
      if (m.type === "auto-suggestion") {
        return {
          id: m.id,
          trigger: m.trigger,
          text: m.text,
          secondary: m.secondary,
          reasoning: m.reasoning,
          timestamp: m.timestamp,
        };
      }
      return null;
    }).filter((x) => x !== null);
    const flatTranscript = overlayState.fullTranscript.map((u) => ({
      speaker: u.channel,
      text: u.text,
      timestamp: u.startedAtMs,
      isFinal: u.isFinal,
    }));
    void emit("wolfee-action", {
      type: "finalize-and-push-session",
      transcript: flatTranscript,
      chat_threads: flatChatThreads,
      auto_suggestions: flatAutoSuggestions,
    });
    // Then the existing teardown — keeps the session-end path intact.
    void emit("wolfee-action", "end-copilot-session");
  };
  const handleToggleExpand = () => {
    void emit(
      "wolfee-action",
      overlayState.mode === "expanded" ? "collapse-overlay" : "expand-overlay",
    );
  };
  const handleAppsClick = () => {
    // Sub-prompt 5.0 — dual behavior:
    //   - First-launch (welcome never shown) → replay welcome card.
    //     This catches the case where the user dismissed welcome
    //     accidentally before reading; the icon is the recovery path.
    //   - Otherwise → open wolfee.io/copilot/modes (Sub-prompt 4.8
    //     behavior), the canonical CRUD surface for modes.
    if (welcomeShownRef.current === false) {
      dispatch({ type: "SHOW_WELCOME" });
      if (modeRef.current !== "expanded") {
        void emit("wolfee-action", "expand-overlay");
      }
      return;
    }
    void emit("wolfee-action", {
      type: "open-external-url",
      url: WOLFEE_WEB_BASE + "/copilot/modes",
    });
  };

  // Sub-prompt 5.0 — welcome dismiss: optimistically flip the reducer
  // flag (so the card disappears immediately) and fire-and-forget
  // persist via Rust. Worst case (Rust write fails), the card replays
  // on next boot — strictly worse UX, but never lost data.
  const handleDismissWelcome = () => {
    dispatch({ type: "DISMISS_WELCOME" });
    void emit("wolfee-action", { type: "mark-welcome-shown" });
  };

  // Sub-prompt 5.0 — SessionCompleteCard CTAs.
  const handleViewRecap = () => {
    const sid =
      overlayState.lastFinalizedSession?.sessionId ??
      lastFinalizedSessionId.current;
    if (sid) {
      void emit("wolfee-action", {
        type: "open-external-url",
        url: `${WOLFEE_WEB_BASE}/copilot/sessions/${sid}`,
      });
    }
    dispatch({ type: "DISMISS_SESSION_COMPLETE" });
  };
  const handleStartNewSession = () => {
    dispatch({ type: "DISMISS_SESSION_COMPLETE" });
    void emit("wolfee-action", "start-copilot-session");
  };
  const handleDismissSessionComplete = () => {
    dispatch({ type: "DISMISS_SESSION_COMPLETE" });
  };
  const handleViewOnWeb = () => {
    // Sub-prompt 4.8 — opens the user's session list. If we just
    // finalized a session, point straight at it; otherwise the list.
    const target = lastFinalizedSessionId.current
      ? `${WOLFEE_WEB_BASE}/copilot/sessions/${lastFinalizedSessionId.current}`
      : `${WOLFEE_WEB_BASE}/copilot/sessions`;
    void emit("wolfee-action", {
      type: "open-external-url",
      url: target,
    });
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
    // Sub-prompt 4.7 — auto-switch to Chat tab so the response is
    // visible without an extra click. Also expand the panel if the
    // user fired a quick-action while in strip mode (e.g. via a
    // future hotkey path).
    dispatch({ type: "SET_ACTIVE_TAB", tab: "chat" });
    if (overlayState.mode !== "expanded") {
      void emit("wolfee-action", "expand-overlay");
    }
    void emit("wolfee-action", {
      type: "trigger-copilot-quick-action",
      action,
    });
  };
  const handleSubmitQuestion = (question: string) => {
    const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const aiResponseId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Sub-prompt 4.7 — snapshot the active thread's prior messages
    // BEFORE the dispatch so the chat_history we send to the backend
    // doesn't include the just-pushed user question + AI skeleton.
    const priorMessages = activeThreadMessages(overlayState);
    dispatch({
      type: "SUBMIT_USER_QUESTION",
      question,
      questionId,
      aiResponseId,
    });
    const chatHistory = priorMessages
      .map(toChatHistoryWire)
      .filter((m): m is { role: "user" | "assistant"; content: string } => m !== null);
    void emit("wolfee-action", {
      type: "submit-chat-question",
      question,
      ai_response_id: aiResponseId,
      chat_history: chatHistory,
    });
  };

  // Sub-prompt 4.7 — multi-thread management.
  const handleNewThread = () => {
    const threadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dispatch({ type: "NEW_THREAD", threadId });
  };
  const handleSwitchThread = (threadId: string) => {
    dispatch({ type: "SWITCH_THREAD", threadId });
  };
  const handleDeleteThread = (threadId: string) => {
    dispatch({ type: "DELETE_THREAD", threadId });
  };

  const hasActiveSession = overlayState.fullTranscript.length > 0;
  const isAiStreaming = overlayState.streamingAiResponseId !== null;
  const showPermissionModal = permissionNeeded !== null;
  // Sub-prompt 5.0 — bodyOverride precedence: Permission (Phase 6
  // sacred) → SessionComplete → Welcome. Permission is highest because
  // a missing-mic mid-session blocker must override even the recap.
  const showSessionComplete = overlayState.lastFinalizedSession !== null;
  const showWelcome = overlayState.welcomeOpen;
  const expandedPanelBodyOverride = showPermissionModal ? (
    <PermissionModal
      payload={permissionNeeded!}
      onDismiss={() => setPermissionNeeded(null)}
    />
  ) : showSessionComplete ? (
    <SessionCompleteCard
      durationMs={overlayState.lastFinalizedSession?.durationMs ?? null}
      modeName={overlayState.lastFinalizedSession?.modeName ?? null}
      onViewRecap={handleViewRecap}
      onStartNew={handleStartNewSession}
      onDismiss={handleDismissSessionComplete}
    />
  ) : showWelcome ? (
    <WelcomeCard onDismiss={handleDismissWelcome} />
  ) : undefined;

  return (
    // Sub-prompt 4.7 — the outer wrapper is now transparent so the
    // glassmorphic strip + panel show their rounded edges over the
    // desktop. Each component owns its own backdrop (Strip, Panel,
    // and the ContextWindow page draw their own bg-zinc-950/70 +
    // backdrop-blur). Wrapper just sizes the layout.
    <div className="w-screen h-screen flex flex-col text-zinc-100 select-none overflow-hidden">
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

      {/* Sub-prompt 4.9 — finalize-failure banner. Pinned just below
          the Strip so it's visible regardless of mode (strip vs
          expanded). 6s auto-dismiss. Surfacing this fixes the silent
          swallow that Issue 4 surfaced. */}
      {finalizeFailureReason && (
        <div className="px-3 py-1.5 bg-red-500/15 border-y border-red-500/30 backdrop-blur-md text-[11px] text-red-200 flex items-center gap-2 shrink-0">
          <span className="font-semibold uppercase tracking-wider text-red-300">Recap upload failed —</span>
          <span className="truncate">{finalizeFailureReason}</span>
        </div>
      )}

      <AnimatePresence initial={false}>
        {overlayState.mode === "expanded" && (
          <ExpandedPanel
            key="panel"
            activeTab={overlayState.activeTab}
            chatThread={activeThreadMessages(overlayState)}
            chatThreads={overlayState.chatThreads}
            activeThreadId={overlayState.activeThreadId}
            autoSuggestionStream={overlayState.autoSuggestionStream}
            fullTranscript={overlayState.fullTranscript}
            inputDraft={overlayState.inputDraft}
            isAiStreaming={isAiStreaming}
            chatTabPulseAt={overlayState.chatTabPulseAt}
            onTabChange={handleTabChange}
            onDraftChange={handleDraftChange}
            onQuickAction={handleQuickAction}
            onSubmitQuestion={handleSubmitQuestion}
            onNewThread={handleNewThread}
            onSwitchThread={handleSwitchThread}
            onDeleteThread={handleDeleteThread}
            showViewOnWeb={hasFinalizedSession}
            onViewOnWeb={handleViewOnWeb}
            inputRef={inputRef}
            bodyOverride={expandedPanelBodyOverride}
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
