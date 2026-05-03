import { useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

type PermissionKind = "Microphone" | "ScreenRecording";

interface PermissionNeededPayload {
  kind: PermissionKind;
  session_id: string;
}

interface TranscriptChunkPayload {
  session_id: string;
  channel: "user" | "speakers";
  is_final: boolean;
  transcript: string;
  confidence: number;
  started_at_ms: number;
  ended_at_ms: number;
}

// ── Sub-prompt 3 (Intelligence) Tauri event payloads ──────────────
interface CopilotSummaryUpdatedPayload {
  session_id: string;
  summary: string;
  generated_at_ms: number;
  generation_count: number;
}

interface CopilotMomentDetectedPayload {
  session_id: string;
  trigger: string;
  trigger_phrase: string | null;
  urgency: number;
  rationale: string;
}

interface CopilotSuggestionPayload {
  session_id: string;
  suggestion_id: string;
  moment_type: string;
  primary: string;
  secondary: string | null;
  confidence: number;
  reasoning: string;
  ttl_seconds: number;
}

interface CopilotSuggestionStreamingPayload {
  session_id: string;
  suggestion_id: string;
  kind: "start" | "delta" | "complete";
  text: string | null;
  moment_type: string | null;
}

interface CopilotSuggestionFailedPayload {
  session_id: string;
  reason: string;
}

export default function CopilotOverlay() {
  const [permissionNeeded, setPermissionNeeded] =
    useState<PermissionNeededPayload | null>(null);

  // Mirror the latest value into a ref so the focus/key listeners — which
  // are registered once at mount — can read the current state without
  // re-registering.
  const permissionNeededRef = useRef(permissionNeeded);
  useEffect(() => {
    permissionNeededRef.current = permissionNeeded;
  }, [permissionNeeded]);

  useEffect(() => {
    const win = getCurrentWebviewWindow();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (permissionNeededRef.current) {
        // Modal is up — Esc dismisses the modal, not the window. The
        // user can re-trigger from the tray once they've granted
        // permission.
        setPermissionNeeded(null);
      } else {
        void win.hide();
      }
    };
    window.addEventListener("keydown", handleKey);

    // Hide on focus loss, but ONLY when no modal is showing. Otherwise
    // clicking "Open System Settings" would steal focus and yank the
    // modal away before the user can come back to click "Try again".
    const focusUnlistenPromise = win.onFocusChanged(({ payload: focused }) => {
      if (!focused && !permissionNeededRef.current) {
        void win.hide();
      }
    });

    let permUnlisten: UnlistenFn | undefined;
    let transcriptUnlisten: UnlistenFn | undefined;
    // Sub-prompt 3 — Intelligence event listeners (stub: log only).
    let summaryUnlisten: UnlistenFn | undefined;
    let momentUnlisten: UnlistenFn | undefined;
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

      // Sub-prompt 4 will render the live transcript UI from these
      // events. Phase 6 just confirms they're flowing — the WS client
      // emits one per partial + final.
      transcriptUnlisten = await listen<TranscriptChunkPayload>(
        "transcript-chunk",
        (event) => {
          const p = event.payload;
          console.log(
            `[Copilot] transcript-chunk ${p.is_final ? "FINAL" : "partial"} ` +
              `${p.channel} (${p.confidence.toFixed(2)}): ${p.transcript}`,
          );
        },
      );

      // Sub-prompt 3 (Intelligence) — six new events. Sub-prompt 4
      // will render summary panel + suggestion cards from these.
      // For now we just console.log so the verification flow can
      // confirm events flow over the IPC bridge.
      summaryUnlisten = await listen<CopilotSummaryUpdatedPayload>(
        "copilot-summary-updated",
        (event) => {
          const p = event.payload;
          console.log(
            `[Copilot] summary-updated count=${p.generation_count} ` +
              `(${p.summary.length} chars)`,
          );
        },
      );

      momentUnlisten = await listen<CopilotMomentDetectedPayload>(
        "copilot-moment-detected",
        (event) => {
          const p = event.payload;
          console.log(
            `[Copilot] moment-detected trigger=${p.trigger} urgency=${p.urgency}: ` +
              `${p.rationale}`,
          );
        },
      );

      suggestionUnlisten = await listen<CopilotSuggestionPayload>(
        "copilot-suggestion",
        (event) => {
          const p = event.payload;
          console.log(
            `[Copilot] suggestion id=${p.suggestion_id} ` +
              `confidence=${p.confidence.toFixed(2)}: ${p.primary}`,
          );
        },
      );

      suggestionStreamingUnlisten = await listen<CopilotSuggestionStreamingPayload>(
        "copilot-suggestion-streaming",
        (event) => {
          const p = event.payload;
          if (p.kind === "delta" && p.text) {
            // Per-token deltas — too noisy for production console.log,
            // but useful during verification. Sub-prompt 4 will
            // render these inline.
            console.log(`[Copilot] suggestion-delta: ${p.text}`);
          } else if (p.kind === "start") {
            console.log(
              `[Copilot] suggestion-start id=${p.suggestion_id} ` +
                `moment=${p.moment_type ?? "(unknown)"}`,
            );
          }
        },
      );

      suggestionFailedUnlisten = await listen<CopilotSuggestionFailedPayload>(
        "copilot-suggestion-failed",
        (event) => {
          const p = event.payload;
          console.warn(`[Copilot] suggestion-failed: ${p.reason}`);
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
      suggestionUnlisten?.();
      suggestionStreamingUnlisten?.();
      suggestionFailedUnlisten?.();
    };
  }, []);

  if (permissionNeeded) {
    return (
      <PermissionModal
        payload={permissionNeeded}
        onDismiss={() => setPermissionNeeded(null)}
      />
    );
  }

  return (
    <div className="w-full h-full flex items-start justify-center p-3 bg-zinc-950">
      <div
        className="w-full px-6 py-5 rounded-2xl border border-copilot-accent/40 shadow-2xl shadow-copilot-glow bg-zinc-900 text-white"
        role="dialog"
        aria-label="Wolfee Copilot suggestion overlay"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-copilot-accent shadow-[0_0_8px_var(--tw-shadow-color)] shadow-copilot-accent" />
          <h1 className="text-base font-semibold tracking-tight">Wolfee Copilot</h1>
        </div>
        <p className="text-2xl font-semibold mt-3 leading-tight">Hello Copilot</p>
        <p className="text-xs text-zinc-400 mt-2">
          Press <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono">Esc</kbd> or click
          outside to dismiss.
        </p>
      </div>
    </div>
  );
}

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
