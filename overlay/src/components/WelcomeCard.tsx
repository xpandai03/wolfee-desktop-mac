import { motion } from "framer-motion";

/**
 * Sub-prompt 5.0 — first-launch welcome card.
 *
 * Renders inside ExpandedPanel via `bodyOverride` (same pattern as
 * Phase 6 PermissionModal). One screen, six bullets, single CTA.
 * Persistence is owned by the reducer + Rust store — this component
 * only renders + calls back when "Got it" is clicked.
 */

interface Props {
  onDismiss: () => void;
}

const BULLETS: { id: number; icon: string; text: string }[] = [
  {
    id: 1,
    icon: "🎯",
    text: "Wolfee listens to your calls and gives real-time AI suggestions during the conversation",
  },
  {
    id: 2,
    icon: "💬",
    text: "Click Assist, Follow-up, Fact-check, or Recap for instant tactical help",
  },
  {
    id: 3,
    icon: "✍️",
    text: "Type questions in the chat input to ask anything about your conversation",
  },
  {
    id: 4,
    icon: "👻",
    text: "Invisible during screen-share — only you see suggestions, never your prospect",
  },
  {
    id: 5,
    icon: "⌨️",
    text: "⌘⌥W to toggle · ⌘+Enter for chat · ⌘⇧N for new thread · drag the strip anywhere",
  },
  {
    id: 6,
    icon: "🌐",
    text: "Sessions auto-sync to wolfee.io for review and sharing after each call",
  },
];

export function WelcomeCard({ onDismiss }: Props) {
  return (
    <div className="w-full h-full flex items-center justify-center p-4 bg-zinc-950 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="w-full max-w-[520px] px-6 py-5 rounded-2xl border border-copilot-accent/40 shadow-2xl shadow-copilot-glow bg-zinc-900 text-white"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Wolfee"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-copilot-accent shadow-[0_0_8px_rgba(34,211,238,0.7)]" />
          <h1 className="text-base font-semibold tracking-tight">
            Welcome to Wolfee Copilot
          </h1>
        </div>

        <p className="text-xs text-zinc-400 mt-2">
          Six things to know before your first call:
        </p>

        <ul className="mt-3 space-y-2.5">
          {BULLETS.map((b) => (
            <li key={b.id} className="flex items-start gap-2.5">
              <span className="text-base leading-5 shrink-0" aria-hidden>
                {b.icon}
              </span>
              <span className="text-[13px] text-zinc-200 leading-snug">
                {b.text}
              </span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onDismiss}
          className="mt-5 w-full rounded-lg bg-white/95 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-copilot-accent/60 cursor-pointer transition-colors"
        >
          Got it
        </button>
      </motion.div>
    </div>
  );
}
