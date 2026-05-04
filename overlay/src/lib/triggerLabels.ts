/**
 * User-facing trigger labels (plan §4 table).
 *
 * Backend `trigger` slug → uppercase label shown on the suggestion
 * card badge. Sub-prompt 6 can localize without touching component
 * code.
 */

import type { TriggerType } from "@/state/types";

export const triggerLabels: Record<TriggerType, string> = {
  objection: "OBJECTION",
  pricing_question: "PRICING",
  silence_after_question: "THEY WENT QUIET",
  decision_moment: "DECISION TIME",
  buying_signal: "BUYING SIGNAL",
  confusion: "CONFUSED",
  competitor_mentioned: "COMPETITOR",
  question_asked: "QUESTION",
  general: "GENERAL",
  // Sub-prompt 4.5 quick-action labels.
  follow_up: "FOLLOW-UP",
  fact_check: "FACT CHECK",
  recap: "RECAP",
};

export function labelFor(trigger: TriggerType | null | undefined): string {
  if (!trigger) return "GENERAL";
  return triggerLabels[trigger] ?? "GENERAL";
}
