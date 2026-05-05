import { motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";

/**
 * Sub-prompt 5.0 — post-session takeover card.
 *
 * Renders inside ExpandedPanel via `bodyOverride` after the user
 * stops a session AND the backend finalize completes successfully.
 * Replaces the prior toast pattern: this is a full-panel takeover
 * so the rep doesn't miss the recap link.
 *
 * Auto-dismisses after 8s (managed reducer-side via TICK so timing
 * survives panel-collapse/re-expand without stale-timer leaks).
 */

interface Props {
  durationMs: number | null;
  modeName: string | null;
  onViewRecap: () => void;
  onStartNew: () => void;
  onDismiss: () => void;
}

export function SessionCompleteCard({
  durationMs,
  modeName,
  onViewRecap,
  onStartNew,
  onDismiss,
}: Props) {
  const durationLabel = formatDuration(durationMs);

  return (
    <div className="w-full h-full flex items-center justify-center p-4 bg-zinc-950">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="w-full max-w-[460px] px-6 py-6 rounded-2xl border border-emerald-500/30 shadow-2xl shadow-emerald-500/10 bg-zinc-900 text-white"
        role="dialog"
        aria-modal="true"
        aria-label="Session saved"
      >
        <div className="flex flex-col items-center text-center">
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.05, duration: 0.28, ease: "backOut" }}
          >
            <CheckCircle2
              className="w-12 h-12 text-emerald-400"
              strokeWidth={1.75}
              aria-hidden
            />
          </motion.div>

          <h1 className="mt-3 text-lg font-semibold tracking-tight">
            Session Saved
          </h1>

          <p className="mt-1.5 text-[13px] text-zinc-400 leading-snug">
            {durationLabel}
            {modeName ? <> · {modeName} mode</> : null}
          </p>

          <button
            type="button"
            onClick={onViewRecap}
            className="mt-5 w-full rounded-lg bg-copilot-accent px-3 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-copilot-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-copilot-accent/60 cursor-pointer transition-colors inline-flex items-center justify-center gap-1.5"
          >
            View recap on web
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.25"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M14 5l7 7m0 0l-7 7m7-7H3"
              />
            </svg>
          </button>

          <button
            type="button"
            onClick={onStartNew}
            className="mt-2 w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-copilot-accent/60 cursor-pointer transition-colors"
          >
            Start new session
          </button>

          <button
            type="button"
            onClick={onDismiss}
            className="mt-3 text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
          >
            Dismiss
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return "Recording complete";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}
