//! Heuristic moment-candidate detection (plan §5.1).
//!
//! Pure logic, unit-testable. The moment worker calls this on every
//! tick; if it returns ≥ 1 candidate AND the per-trigger + global
//! cooldowns are clear, the worker fires the LLM verifier.
//!
//! All heuristics are intentionally *over-eager* — the LLM verifier
//! is the precision gate. Heuristics' job is to keep LLM cost down
//! by skipping the call entirely when nothing plausibly happened.

use std::collections::HashMap;
use std::time::Instant;

use crate::copilot::transcribe::buffer::{ChannelLabel, Utterance};

use super::state::TriggerType;

/// Default competitor name list (configurable in V1.x). Lowercase
/// for case-insensitive matching.
const DEFAULT_COMPETITORS: &[&str] = &[
    "salesforce",
    "hubspot",
    "gong",
    "chorus",
    "outreach",
    "apollo",
    "drift",
    "intercom",
];

const OBJECTION_KEYWORDS: &[&str] = &[
    "expensive",
    "concern",
    "not sure",
    "but ",
    "worried",
    "pushback",
    "problem",
    "tough",
    "struggle",
    "skeptic",
];

const DECISION_KEYWORDS: &[&str] = &[
    "let me think",
    "talk to my team",
    "talk to my",
    "get back to you",
    "send me",
    "circle back",
    "loop in",
    "run it by",
    "noodle on",
];

const BUYING_KEYWORDS: &[&str] = &[
    "that's great",
    "love that",
    "exactly what",
    "let's do it",
    "sign me up",
    "this is what we need",
    "looks great",
    "kickoff",
    "next step",
];

const PRICING_KEYWORDS: &[&str] = &[
    "cost",
    "price",
    "how much",
    "roi",
    "discount",
    "contract",
    "billing",
    "annual",
];

const CONFUSION_KEYWORDS: &[&str] = &[
    "confused",
    "i'm a bit lost",
    "not following",
    "wait so",
    "can you clarify",
    "explain that",
];

/// One candidate detected by the heuristics. The moment worker
/// dedupes against cooldowns and forwards passing candidates as
/// `candidate_triggers` to the LLM verifier.
#[derive(Debug, Clone)]
pub struct CandidateTrigger {
    pub trigger: TriggerType,
    /// Verbatim text fragment that matched — for debug logging only.
    /// Production verifier reads the full window and picks its own
    /// `trigger_phrase`.
    pub matched_fragment: String,
}

/// Read the most recent finals from the transcript, run all
/// heuristics, and return candidates that haven't tripped their
/// cooldown. Spam guard caps the result at 2 (highest priority).
pub fn detect_candidates(
    transcript: &[Utterance],
    cooldowns: &HashMap<TriggerType, Instant>,
    now: Instant,
) -> Vec<CandidateTrigger> {
    let mut out = Vec::new();

    let last_speaker = last_from(transcript, ChannelLabel::Speakers);
    let last_user = last_from(transcript, ChannelLabel::User);

    if let Some(speaker) = last_speaker {
        let lower = speaker.text.to_lowercase();

        // Question heuristic — split into pricing-question vs generic
        // by scanning for pricing keywords.
        if speaker.text.trim_end().ends_with('?') {
            let trigger = if PRICING_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
                TriggerType::PricingQuestion
            } else {
                TriggerType::QuestionAsked
            };
            push_if_cooldown_clear(&mut out, trigger, &speaker.text, cooldowns, now);
        }

        // Objection cues
        if OBJECTION_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
            push_if_cooldown_clear(
                &mut out,
                TriggerType::Objection,
                &speaker.text,
                cooldowns,
                now,
            );
        }

        // Decision-punt cues
        if DECISION_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
            push_if_cooldown_clear(
                &mut out,
                TriggerType::DecisionMoment,
                &speaker.text,
                cooldowns,
                now,
            );
        }

        // Buying signals
        if BUYING_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
            push_if_cooldown_clear(
                &mut out,
                TriggerType::BuyingSignal,
                &speaker.text,
                cooldowns,
                now,
            );
        }

        // Competitor mentions
        if DEFAULT_COMPETITORS.iter().any(|c| lower.contains(c)) {
            push_if_cooldown_clear(
                &mut out,
                TriggerType::CompetitorMentioned,
                &speaker.text,
                cooldowns,
                now,
            );
        }

        // Confusion cues
        if CONFUSION_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
            push_if_cooldown_clear(
                &mut out,
                TriggerType::Confusion,
                &speaker.text,
                cooldowns,
                now,
            );
        }
    }

    // Silence-after-rep-question heuristic. Looks for "user
    // ended on a question mark, then no speaker finals for ≥ 5s".
    if let Some(user) = last_user {
        if user.text.trim_end().ends_with('?') {
            let user_q_age = now.saturating_duration_since(user.recorded_at);
            let speaker_silence = match last_speaker {
                None => user_q_age, // no speaker activity at all in window
                Some(s) => {
                    if s.recorded_at < user.recorded_at {
                        // Speaker hasn't said anything since the rep's question.
                        now.saturating_duration_since(user.recorded_at)
                    } else {
                        // Speaker has said something — silence broken.
                        std::time::Duration::ZERO
                    }
                }
            };
            if speaker_silence.as_secs() >= 5 {
                push_if_cooldown_clear(
                    &mut out,
                    TriggerType::SilenceAfterQuestion,
                    &user.text,
                    cooldowns,
                    now,
                );
            }
        }
    }

    // Spam guard: cap at 2 candidates per detection cycle, keep
    // highest priority (per plan §5.1).
    out.sort_by_key(|c| std::cmp::Reverse(c.trigger.priority()));
    out.dedup_by(|a, b| a.trigger == b.trigger);
    out.truncate(2);
    out
}

fn last_from(transcript: &[Utterance], channel: ChannelLabel) -> Option<&Utterance> {
    transcript
        .iter()
        .rev()
        .find(|u| u.channel == channel)
}

fn push_if_cooldown_clear(
    out: &mut Vec<CandidateTrigger>,
    trigger: TriggerType,
    fragment: &str,
    cooldowns: &HashMap<TriggerType, Instant>,
    now: Instant,
) {
    let cooldown_secs = trigger.default_cooldown_seconds();
    if let Some(last_at) = cooldowns.get(&trigger) {
        if now.saturating_duration_since(*last_at).as_secs() < cooldown_secs {
            return;
        }
    }
    out.push(CandidateTrigger {
        trigger,
        matched_fragment: fragment.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utt(channel: ChannelLabel, text: &str, recorded_at: Instant) -> Utterance {
        Utterance {
            channel,
            started_at_ms: 0,
            ended_at_ms: 1_000,
            text: text.to_string(),
            confidence: 0.95,
            recorded_at,
        }
    }

    #[test]
    fn detects_pricing_question() {
        let now = Instant::now();
        let t = vec![utt(
            ChannelLabel::Speakers,
            "How much does this cost for a team of 50?",
            now,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.iter().any(|x| x.trigger == TriggerType::PricingQuestion));
    }

    #[test]
    fn detects_objection_keyword() {
        let now = Instant::now();
        let t = vec![utt(
            ChannelLabel::Speakers,
            "It's a little expensive for our team right now.",
            now,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.iter().any(|x| x.trigger == TriggerType::Objection));
    }

    #[test]
    fn detects_decision_punt() {
        let now = Instant::now();
        let t = vec![utt(
            ChannelLabel::Speakers,
            "Let me talk to my team and get back to you.",
            now,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.iter().any(|x| x.trigger == TriggerType::DecisionMoment));
    }

    #[test]
    fn detects_competitor() {
        let now = Instant::now();
        let t = vec![utt(
            ChannelLabel::Speakers,
            "We've been talking to Salesforce too.",
            now,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.iter().any(|x| x.trigger == TriggerType::CompetitorMentioned));
    }

    #[test]
    fn detects_buying_signal() {
        let now = Instant::now();
        let t = vec![utt(
            ChannelLabel::Speakers,
            "This is exactly what we need! Let's do it.",
            now,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.iter().any(|x| x.trigger == TriggerType::BuyingSignal));
    }

    #[test]
    fn cooldown_suppresses_repeat_trigger() {
        let now = Instant::now();
        let t = vec![utt(ChannelLabel::Speakers, "It's expensive.", now)];
        let mut cooldowns = HashMap::new();
        // Last fired 30s ago — well under the 60s objection cooldown.
        cooldowns.insert(
            TriggerType::Objection,
            now - std::time::Duration::from_secs(30),
        );
        let c = detect_candidates(&t, &cooldowns, now);
        assert!(c.iter().all(|x| x.trigger != TriggerType::Objection));
    }

    #[test]
    fn cooldown_clears_after_window() {
        let now = Instant::now();
        let t = vec![utt(ChannelLabel::Speakers, "It's expensive.", now)];
        let mut cooldowns = HashMap::new();
        // Last fired 90s ago — beyond the 60s cooldown.
        cooldowns.insert(
            TriggerType::Objection,
            now - std::time::Duration::from_secs(90),
        );
        let c = detect_candidates(&t, &cooldowns, now);
        assert!(c.iter().any(|x| x.trigger == TriggerType::Objection));
    }

    #[test]
    fn silence_after_question_fires() {
        let now = Instant::now();
        let earlier = now - std::time::Duration::from_secs(7);
        let t = vec![utt(
            ChannelLabel::User,
            "What's most important to get right here?",
            earlier,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.iter().any(|x| x.trigger == TriggerType::SilenceAfterQuestion));
    }

    #[test]
    fn silence_does_not_fire_when_speaker_responded() {
        let now = Instant::now();
        let earlier = now - std::time::Duration::from_secs(7);
        let recent = now - std::time::Duration::from_secs(2);
        let t = vec![
            utt(ChannelLabel::User, "What's most important?", earlier),
            utt(ChannelLabel::Speakers, "Reliability, mainly.", recent),
        ];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.iter().all(|x| x.trigger != TriggerType::SilenceAfterQuestion));
    }

    #[test]
    fn spam_guard_caps_at_two_highest_priority() {
        let now = Instant::now();
        // Speakers utterance with multiple keyword matches.
        let t = vec![utt(
            ChannelLabel::Speakers,
            "Salesforce is expensive and let me think — how much is the discount?",
            now,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        assert!(c.len() <= 2);
        // DecisionMoment (priority 6) and BuyingSignal absent here →
        // the top should be DecisionMoment + Objection (priority 4).
        let triggers: Vec<_> = c.iter().map(|x| x.trigger).collect();
        assert!(triggers.contains(&TriggerType::DecisionMoment));
    }

    #[test]
    fn no_question_no_pricing_no_fire() {
        let now = Instant::now();
        let t = vec![utt(
            ChannelLabel::Speakers,
            "Yeah, that sounds reasonable.",
            now,
        )];
        let c = detect_candidates(&t, &HashMap::new(), now);
        // None of the keyword sets match.
        assert!(c.is_empty());
    }
}
