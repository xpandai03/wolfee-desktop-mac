import { useEffect, useReducer, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { TopBar } from "@/components/TopBar";
import { TranscriptZone } from "@/components/TranscriptZone";
import { SuggestionCard } from "@/components/SuggestionCard";
import { FooterHint } from "@/components/FooterHint";
import { cn } from "@/lib/utils";
import {
  initialOverlayState,
  isInTtlFadeWindow,
  overlayReducer,
} from "@/state/overlayReducer";
import { copyToClipboard } from "@/lib/copyToClipboard";
import type {
  TranscriptChunkPayload,
  SummaryUpdatedPayload,
  MomentDetectedPayload,
  SuggestionPendingPayload,
  SuggestionStreamingPayload,
  SuggestionCompletePayload,
  SuggestionFailedPayload,
} from "@/state/types";

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

  // Mirror the latest value into a ref so the focus/key listeners — which
  // are registered once at mount — can read the current state without
  // re-registering.
  const permissionNeededRef = useRef(permissionNeeded);
  useEffect(() => {
    permissionNeededRef.current = permissionNeeded;
  }, [permissionNeeded]);

  // Same pattern for the active-suggestion uiPhase: the Esc handler
  // is registered once at mount, so it reads via ref.
  const uiPhaseRef = useRef(overlayState.uiPhase);
  useEffect(() => {
    uiPhaseRef.current = overlayState.uiPhase;
  }, [overlayState.uiPhase]);

  // ── Tick interval — drives 2s reasoning fallback + 30s TTL ─────
  useEffect(() => {
    const id = window.setInterval(() => {
      dispatch({ type: "TICK", nowMs: Date.now() });
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // ── Dev-mode mock event generator (Ctrl+Shift+M) ───────────────
  // Only registered when import.meta.env.DEV is true. Tree-shaken
  // out of production builds.
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

  // ── Failure toast auto-clear (1.2s) ────────────────────────────
  useEffect(() => {
    if (!overlayState.failureToast) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "CLEAR_FAILURE_TOAST" });
    }, FAILURE_TOAST_MS);
    return () => window.clearTimeout(t);
  }, [overlayState.failureToast]);

  // ── Window-level keydown + focus + Tauri event listeners ───────
  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Phase 6 Esc precedence (sacred): if the modal is up, dismiss it.
      if (permissionNeededRef.current) {
        setPermissionNeeded(null);
        return;
      }
      // Sub-prompt 4: Esc dismisses an active suggestion before
      // hiding the window. Pressing Esc with no suggestion still
      // hides (Sub-prompt 1 behavior preserved).
      const phase = uiPhaseRef.current;
      if (phase === "Reasoning" || phase === "Streaming" || phase === "Showing") {
        dispatch({ type: "DISMISS_SUGGESTION", via: "esc" });
        // Tell Rust to release ActiveSuggestionMutex (V1 string payload).
        void emit("wolfee-action", "copilot-suggestion-dismissed");
        return;
      }
      void win.hide();
    };
    window.addEventListener("keydown", handleKey);

    // 2026-05-04: removed the auto-hide-on-focus-loss handler. With
    // Accessory activation policy, the overlay rarely takes focus
    // anyway — and the prior listener was firing the moment Chrome
    // (or any other fullscreen app) reclaimed focus, which made the
    // overlay flicker visible-then-gone the instant a suggestion
    // appeared. Surfaced by PO 2026-05-04 as "blacked out."
    //
    // New dismiss model:
    //   - ⌘⌥W toggles the overlay window
    //   - X button in TopBar hides it
    //   - Esc dismisses an active suggestion (if any) or hides the
    //     window otherwise (only effective when overlay has focus)
    //
    // Keep the focusUnlistenPromise variable (typed) because the
    // permission-modal Esc path was the last legitimate consumer.
    // We still register a listener — but it's a no-op for window
    // hiding now, retained as a hook for Sub-prompt 6 if PO wants
    // a different behavior (e.g., "auto-hide if user goes idle").
    const focusUnlistenPromise = win.onFocusChanged(({ payload: _focused }) => {
      // intentional no-op
    });

    let permUnlisten: UnlistenFn | undefined;
    let transcriptUnlisten: UnlistenFn | undefined;
    let summaryUnlisten: UnlistenFn | undefined;
    let momentUnlisten: UnlistenFn | undefined;
    let pendingUnlisten: UnlistenFn | undefined;
    let suggestionUnlisten: UnlistenFn | undefined;
    let suggestionStreamingUnlisten: UnlistenFn | undefined;
    let suggestionFailedUnlisten: UnlistenFn | undefined;

    void (async () => {
      permUnlisten = await listen<PermissionNeededPayload>(
        "copilot-permission-needed",
        (event) => {
          console.log("[Copilot] permission needed:", event.payload);
          setPermissionNeeded(event.payload);
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

      // Sub-prompt 4 N3 — emitted instantly on ⌘⌥G or moment fire.
      // Eliminates 200-800ms dead air before the first streaming delta.
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
        },
      );

      suggestionFailedUnlisten = await listen<SuggestionFailedPayload>(
        "copilot-suggestion-failed",
        (event) => {
          dispatch({ type: "SUGGESTION_FAILED", payload: event.payload });
        },
      );
    })();

    return () => {
      window.removeEventListener("keydown", handleKey);
      void focusUnlistenPromise.then((fn) => fn());
      permUnlisten?.();
      transcriptUnlisten?.();
      summaryUnlisten?.();
      momentUnlisten?.();
      pendingUnlisten?.();
      suggestionUnlisten?.();
      suggestionStreamingUnlisten?.();
      suggestionFailedUnlisten?.();
    };
  }, []);

  // ── Phase 6 sacred path — modal short-circuits everything else ─
  if (permissionNeeded) {
    return (
      <PermissionModal
        payload={permissionNeeded}
        onDismiss={() => setPermissionNeeded(null)}
      />
    );
  }

  // ── Sub-prompt 4 — main overlay layout ─────────────────────────
  const { uiPhase, transcript, active, copiedFlashAt, failureToast } =
    overlayState;
  const hasActiveSession = transcript.length > 0;
  const isFading = isInTtlFadeWindow(overlayState, Date.now());
  const isExpanded = active?.expanded === true;

  const handleDismiss = () => {
    dispatch({ type: "DISMISS_SUGGESTION", via: "click" });
    void emit("wolfee-action", "copilot-suggestion-dismissed");
  };

  const handleToggleExpanded = () => {
    dispatch({ type: "TOGGLE_EXPANDED" });
  };

  const handleCopy = async () => {
    if (!active?.finalPrimary) return;
    const ok = await copyToClipboard(active.finalPrimary);
    if (ok) dispatch({ type: "COPY_FLASH" });
  };

  return (
    <div className="w-full h-full flex flex-col bg-zinc-950 text-zinc-100 select-none">
      <TopBar uiPhase={uiPhase} hasActiveSession={hasActiveSession} />

      {/*
        When a suggestion is expanded, hide the transcript zone so the
        suggestion card has the whole content area to breathe (per PO
        2026-05-04 — "make it bigger" / "side view"). When collapsed,
        the original two-zone layout is restored: transcript top,
        suggestion bottom.
      */}
      {!isExpanded && <TranscriptZone utterances={transcript} />}

      <div
        className={cn(
          "flex items-center justify-center",
          isExpanded ? "flex-1" : "h-[130px]",
        )}
      >
        <AnimatePresence mode="wait">
          {active ? (
            <div key="card" className="w-full">
              <SuggestionCard
                uiPhase={uiPhase}
                active={active}
                isFading={isFading && !isExpanded}
                copiedFlashAt={copiedFlashAt}
                onDismiss={handleDismiss}
                onToggleExpanded={handleToggleExpanded}
                onCopy={handleCopy}
              />
            </div>
          ) : (
            <div
              key="idle"
              className="text-zinc-500 text-[13px] opacity-60 text-center px-3"
            >
              Listening… <kbd className="font-mono text-[12px]">⌘⌥G</kbd> to ask
            </div>
          )}
        </AnimatePresence>
      </div>

      {!isExpanded && <FooterHint failureToast={failureToast} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Phase 6 PermissionModal — SACRED, preserved verbatim from
// Sub-prompt 2 commit b8a19fb. Do not modify in Sub-prompt 4.
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
