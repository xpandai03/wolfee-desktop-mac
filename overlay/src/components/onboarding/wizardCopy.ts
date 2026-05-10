/**
 * Sub-prompt 6.0 — onboarding wizard copy. Centralised so iteration
 * doesn't require touching layout components.
 */

export const WIZARD_TOTAL_STEPS = 6;

export const WIZARD_COPY = {
  step1: {
    headline: "Your invisible AI partner for any conversation",
    body: "Wolfee Copilot listens during your calls, transcribes silently, and surfaces real-time suggestions only you can see. It's invisible during screen-share — your prospect never knows it's there.",
  },
  step2: {
    headline: "From conversation to clarity",
    body: "Three things happen on every call:",
    phases: [
      {
        icon: "🎙️",
        label: "Listen",
        desc: "Live transcription of you and the other side",
      },
      {
        icon: "💬",
        label: "Suggest",
        desc: "Tactical responses, fact-checks, and follow-ups",
      },
      {
        icon: "📋",
        label: "Recap",
        desc: "Summary + chat history saved to wolfee.io",
      },
    ],
  },
  step3: {
    headline: "First, link this app to your account",
    body: "Wolfee Copilot needs to connect to your account on the web. Click below — sign in if needed, then come back here. The app will detect the link automatically.",
    primaryCta: "Open Wolfee to link",
    secondaryCta: "I'll do this later",
    waitingText: "Waiting for link…",
    timeoutText: "Took too long?",
    timeoutCta: "Try again",
    alreadyLinkedText: (userId: string) =>
      `Already linked${userId ? ` (user ${userId.slice(0, 8)})` : ""}. Continuing…`,
  },
  step4: {
    headline: "Copilot needs to hear you and your call",
    body: "Two macOS permissions are required: Microphone (your voice) and Screen Recording (the audio of whoever you're talking to). We'll open System Settings — flip both on, then come back.",
    primaryCta: "Open System Settings",
    secondaryCta: "Continue without granting",
    recheckCta: "Recheck",
    micLabel: "Microphone",
    screenLabel: "Screen Recording",
    statusGranted: "✅ granted",
    statusDenied: "⚠️ denied",
    statusUndetermined: "⚠️ needs permission",
    statusLoading: "checking…",
    micDeeplinkAction: "open-system-settings-microphone",
    screenDeeplinkAction: "open-system-settings-screen-recording",
  },
  // Modes RAG (0.7.3) — Step 5 reframed around the playbook concept.
  // Wolfee.io now hosts a Knowledge editor (free-text + document upload)
  // that the copilot retrieves from live during calls. Step 5 is the
  // first mention to a new user that this exists, so the copy leads
  // with "Mode = your reusable playbook" rather than the older
  // "session setup" framing.
  step5: {
    headline: "Set up your first Mode",
    body: "On Wolfee.io you'll create a Mode, your reusable playbook. Paste talking points, upload PDFs of your scripts or product docs. Wolfee retrieves from this content during every call you tag with the Mode.",
    primaryCta: "Open Modes editor",
    secondaryCta: "I'll do it later",
  },
  step6: {
    headline: "You're ready",
    body: "Three quick reminders:",
    items: [
      "⌘⌥W toggles the overlay anytime",
      "Click the tray icon to start, pause, or end a session",
      "Re-open this tour anytime from the tray menu",
    ],
    primaryCta: "Get started",
  },
} as const;

/**
 * Sub-prompt 6.0 — Step 5 hands users off to the modes page on the
 * web app. Step 3's pairing CTA does NOT use a hardcoded URL — it
 * fires the existing `link-account` wolfee-action which builds the
 * correct deviceId-bearing URL Rust-side.
 */
export const WOLFEE_MODES_URL = "https://wolfee.io/copilot/modes";
