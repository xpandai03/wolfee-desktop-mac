/**
 * Synthetic data for the dev-mode mock event generator (plan §11).
 *
 * Bundled only when `import.meta.env.DEV` is true (vite tree-shakes
 * this out of production builds via the dev/ directory naming + the
 * conditional `if (import.meta.env.DEV)` gate around the mock loop).
 */

export const MOCK_TRANSCRIPT_LINES: Array<{
  channel: "user" | "speakers";
  text: string;
}> = [
  { channel: "user", text: "Hey, thanks for hopping on the call today." },
  { channel: "speakers", text: "Yeah no problem. What did you want to walk through?" },
  { channel: "user", text: "I wanted to show you our new pipeline orchestration platform." },
  { channel: "speakers", text: "Cool. We've been looking at a few options actually." },
  { channel: "user", text: "Got it. Who else have you been evaluating?" },
  { channel: "speakers", text: "We've been talking to Salesforce too. They're offering a steep discount." },
  { channel: "user", text: "Understood. Let me walk you through what makes our approach different." },
  { channel: "speakers", text: "Sure, but quickly — what's the cost for a team of fifty?" },
  { channel: "user", text: "We typically come in around twelve thousand annually for a team your size." },
  { channel: "speakers", text: "Yeah honestly that's a lot more than we were budgeting." },
  { channel: "user", text: "I hear that. What were you thinking budget-wise?" },
  { channel: "speakers", text: "We were thinking maybe seven or eight thousand tops." },
  { channel: "user", text: "Got it. Let me show you the ROI math we've seen with similar teams." },
  { channel: "speakers", text: "This sounds like exactly what we need. Can we do a kickoff next week?" },
];

export interface MockSuggestion {
  trigger: string;
  trigger_phrase: string;
  primary: string;
  secondary: string | null;
  confidence: number;
  reasoning: string;
}

export const MOCK_SUGGESTIONS: MockSuggestion[] = [
  {
    trigger: "competitor_mentioned",
    trigger_phrase: "We've been talking to Salesforce too. They're offering a steep discount.",
    primary:
      "Don't match the discount. Differentiate on the one capability they care about most from earlier in the call.",
    secondary: "Ask 'What would have to be true for you to choose us anyway?'",
    confidence: 0.78,
    reasoning: "Competitor + discount — re-anchor on differentiation, not price",
  },
  {
    trigger: "pricing_question",
    trigger_phrase: "what's the cost for a team of fifty?",
    primary:
      "Give the team-of-50 number, then immediately frame against ROI: 'For a team that size, customers typically see X.'",
    secondary: "Ask how they're evaluating cost vs value — opens consultative path.",
    confidence: 0.84,
    reasoning: "Direct pricing q — answer + anchor on value",
  },
  {
    trigger: "objection",
    trigger_phrase: "that's a lot more than we were budgeting",
    primary:
      "Acknowledge the budget concern, then ask what ROI would justify it for their team.",
    secondary: "Anchor on annual savings, not monthly price.",
    confidence: 0.85,
    reasoning: "Vague price objection — value-anchor before discount",
  },
  {
    trigger: "buying_signal",
    trigger_phrase: "This sounds like exactly what we need. Can we do a kickoff next week?",
    primary:
      "Confirm timeline, then propose a 30-min kickoff with their stakeholders. Suggest two specific times.",
    secondary: "Send a one-page recap email immediately to lock momentum.",
    confidence: 0.92,
    reasoning: "Strong buying signal — convert to scheduled next step now",
  },
];

export const MOCK_SUMMARY_TEXTS = [
  "Discovery call with VP Sales at a 50-person team. They're evaluating pipeline orchestration tools. Budget concerns surfacing — they were thinking $7-8K, our list is $12K.",
  "Mid-discovery. Prospect mentioned Salesforce as an alternative offering a steep discount. Pain point: scattered notes across reps. Budget gap of ~30% surfaced.",
];

// Sub-prompt 4.5 — fixtures for the 4 quick-action button mocks.
// Mirror the SuggestPayload shape so the existing reducer +
// SuggestionCard render them without branching.
export const MOCK_QUICK_ACTIONS: Record<
  "ask" | "follow_up" | "fact_check" | "recap",
  MockSuggestion
> = {
  ask: {
    trigger: "general",
    trigger_phrase: "",
    primary:
      "Re-anchor on what matters: 'Of everything we've covered, what's the one thing that would make this a no-brainer for you?'",
    secondary: "Listen for hesitations — they map to your real objections.",
    confidence: 0.75,
    reasoning: "User pressed Ask — reframe on priority",
  },
  follow_up: {
    trigger: "follow_up",
    trigger_phrase: "",
    primary:
      "1. What would have to be true to lock this in by end of quarter?\n2. Who else needs to weigh in before you can sign?\n3. If pricing wasn't the issue, are we the right fit otherwise?",
    secondary: null,
    confidence: 0.80,
    reasoning: "3 tactical follow-ups — qualifying, decision-maker, fit",
  },
  fact_check: {
    trigger: "fact_check",
    trigger_phrase: "",
    primary:
      "Their claim: 'Salesforce is offering a steep discount.' Verdict: questionable. Counter-evidence: their list price hasn't changed publicly; 'steep discount' is often quoted but rarely the final number.",
    secondary: "Ask: 'What does that discount get you in writing?'",
    confidence: 0.65,
    reasoning: "Vague competitor-discount claim — surface the spec",
  },
  recap: {
    trigger: "recap",
    trigger_phrase: "",
    primary:
      "Recap: They flagged Salesforce as an alternative + a 30% budget gap ($8K vs $12K). You countered with ROI math. They asked about kickoff timing. Open: who else needs to approve?",
    secondary: null,
    confidence: 0.72,
    reasoning: "Last 2 min — competitor + budget + buying signal",
  },
};
