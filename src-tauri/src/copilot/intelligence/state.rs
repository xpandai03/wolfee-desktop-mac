//! Tauri-managed state for the Intelligence layer (plan §11.1).
//!
//! Three independent mutexes — all `std::sync::Mutex` (NOT tokio),
//! since the protected data is small and we never hold the guard
//! across `.await` (lesson from Phase 6 commit `5cc2425`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Trigger types Sub-prompt 3 V1 surfaces. Mirrors the backend
/// allowlist exactly — keep in sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TriggerType {
    Objection,
    PricingQuestion,
    SilenceAfterQuestion,
    DecisionMoment,
    BuyingSignal,
    Confusion,
    CompetitorMentioned,
    QuestionAsked,
}

impl TriggerType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Objection => "objection",
            Self::PricingQuestion => "pricing_question",
            Self::SilenceAfterQuestion => "silence_after_question",
            Self::DecisionMoment => "decision_moment",
            Self::BuyingSignal => "buying_signal",
            Self::Confusion => "confusion",
            Self::CompetitorMentioned => "competitor_mentioned",
            Self::QuestionAsked => "question_asked",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "objection" => Some(Self::Objection),
            "pricing_question" => Some(Self::PricingQuestion),
            "silence_after_question" => Some(Self::SilenceAfterQuestion),
            "decision_moment" => Some(Self::DecisionMoment),
            "buying_signal" => Some(Self::BuyingSignal),
            "confusion" => Some(Self::Confusion),
            "competitor_mentioned" => Some(Self::CompetitorMentioned),
            "question_asked" => Some(Self::QuestionAsked),
            _ => None,
        }
    }

    /// Default cooldown per trigger type (plan §5.1). Lower =
    /// more eager surfacing. Sensitivity preset can override these
    /// (Sub-prompt 6 ships the toggle UI; V1 launches at "Low" per
    /// Decision N8 which scales these up).
    pub fn default_cooldown_seconds(&self) -> u64 {
        match self {
            Self::Objection => 60,
            Self::PricingQuestion => 45,
            Self::SilenceAfterQuestion => 90,
            Self::DecisionMoment => 120,
            Self::BuyingSignal => 90,
            Self::CompetitorMentioned => 180,
            Self::Confusion => 60,
            Self::QuestionAsked => 45,
        }
    }

    /// Priority order for the spam guard — higher number = surfaced
    /// first when multiple candidates fire in the same window.
    pub fn priority(&self) -> u8 {
        match self {
            Self::DecisionMoment => 6,
            Self::BuyingSignal => 5,
            Self::Objection => 4,
            Self::PricingQuestion => 3,
            Self::CompetitorMentioned => 3,
            Self::Confusion => 2,
            Self::SilenceAfterQuestion => 2,
            Self::QuestionAsked => 1,
        }
    }
}

/// Source of a suggestion event — drives UI distinction (Sub-prompt 4)
/// and telemetry attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerSource {
    Moment,
    Hotkey,
}

impl TriggerSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Moment => "moment",
            Self::Hotkey => "hotkey",
        }
    }
}

/// Latest rolling summary returned by the backend /summary endpoint.
/// Sub-prompt 4's overlay will read this when rendering — for now
/// only the worker writes to it.
#[derive(Debug, Clone)]
pub struct RollingSummary {
    pub session_id: String,
    pub text: String,
    pub generated_at: Instant,
    pub generation_count: u32,
}

pub struct RollingSummaryMutex(pub Mutex<Option<RollingSummary>>);

impl Default for RollingSummaryMutex {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Per-trigger cooldown timestamps. Updated on the moment-detector
/// LLM verifier path (after `should_suggest=true`).
#[derive(Debug, Clone, Default)]
pub struct MomentCooldownState {
    pub session_id: String,
    pub last_fired: HashMap<TriggerType, Instant>,
    /// Generic spacing across ALL trigger types — defends against
    /// bursty heuristic-fire windows that spam the LLM verifier
    /// even though no single trigger has hit its cooldown yet.
    pub last_llm_verify: Option<Instant>,
}

pub struct MomentCooldownMutex(pub Mutex<MomentCooldownState>);

impl Default for MomentCooldownMutex {
    fn default() -> Self {
        Self(Mutex::new(MomentCooldownState::default()))
    }
}

/// Track whether a suggest stream is in flight (concurrency gate
/// per plan §6.3). New trigger while an active suggestion is
/// streaming → drop the new request.
#[derive(Debug, Clone)]
pub struct ActiveSuggestion {
    pub session_id: String,
    pub suggestion_id: String,
    pub started_at: Instant,
    pub trigger_source: TriggerSource,
}

pub struct ActiveSuggestionMutex(pub Mutex<Option<ActiveSuggestion>>);

impl Default for ActiveSuggestionMutex {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}
