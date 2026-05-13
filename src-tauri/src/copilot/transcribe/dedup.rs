//! Cross-channel echo deduplication for multichannel Deepgram transcripts.
//!
//! ScreenCaptureKit feeds the far end on channel 1 (Speakers); the mic
//! (channel 0) often **acoustically picks up** the same playback (ChatGPT
//! voice, Zoom far-end, etc.). Deepgram then emits near-identical finals
//! on alternating channels — the UI "ping-pongs" between YOU and
//! SPEAKERS for one party's speech.
//!
//! Policy (V1, conservative):
//! - If a **User** final is a near-duplicate of a recent **Speakers**
//!   final (same wall of text, close in time), **drop** the User line —
//!   treat it as mic bleed, not a second speaker.
//! - If a **Speakers** final supersedes a recent **User** fragment that
//!   is clearly the same echo (near-duplicate + user is shorter / mostly
//!   contained in speakers text), **remove** that User utterance from the
//!   buffer and let Speakers stand as the canonical line. The overlay is
//!   told via `transcript-retract` so live UI matches the buffer.

use std::collections::HashSet;

use serde::Serialize;

use super::buffer::{ChannelLabel, TranscriptBuffer, Utterance};

/// Keys the overlay uses (`channel:started_at_ms` — see overlayReducer).
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptRetractPayload {
    pub session_id: String,
    pub keys: Vec<String>,
}

#[derive(Debug)]
pub enum FinalDedupOutcome {
    /// Do not append; emit retracts so any partial for these keys vanishes.
    Suppress { retract_keys: Vec<String> },
    /// Normal append + emit final chunk.
    Append { utterance: Utterance },
    /// User echo row removed from buffer; retract then append + emit.
    AppendAfterRetracting {
        retract_keys: Vec<String>,
        utterance: Utterance,
    },
}

/// How far apart Deepgram `start` timestamps can be for echo pairing.
const TIME_WINDOW_MS: u64 = 7_500;
/// How many merged utterances we scan backward.
const MERGED_LOOKBACK: usize = 24;

pub fn overlay_key(channel: ChannelLabel, started_at_ms: u64) -> String {
    format!("{}:{}", channel.as_str(), started_at_ms)
}

fn normalize_words(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn word_count(s: &str) -> usize {
    s.split_whitespace().filter(|w| !w.is_empty()).count()
}

/// True when `a` and `b` are likely the same spoken content (echo / ASR
/// jitter), not two different people coincidentally saying similar things.
pub(crate) fn is_near_duplicate_text(a: &str, b: &str) -> bool {
    let na = normalize_words(a);
    let nb = normalize_words(b);
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    if na == nb {
        return true;
    }
    let (shorter, longer) = if na.len() <= nb.len() {
        (na.as_str(), nb.as_str())
    } else {
        (nb.as_str(), na.as_str())
    };
    // One transcript is a substring of the other (common when mic catches
    // a fragment of a longer system-audio sentence).
    if shorter.len() >= 10 && longer.contains(shorter) {
        return true;
    }
    // Token Jaccard — good for punctuation / ASR word-boundary drift.
    let wa: HashSet<&str> = na.split_whitespace().collect();
    let wb: HashSet<&str> = nb.split_whitespace().collect();
    if wa.len() >= 2 && wb.len() >= 2 {
        let inter = wa.intersection(&wb).count();
        let union = wa.union(&wb).count();
        if union > 0 {
            let j = (inter * 100) / union;
            if j >= 72 {
                return true;
            }
        }
    }
    false
}

fn time_close(a_ms: u64, b_ms: u64) -> bool {
    a_ms.abs_diff(b_ms) <= TIME_WINDOW_MS
}

fn user_is_echo_fragment_of_speakers(user: &Utterance, spk: &Utterance) -> bool {
    if !is_near_duplicate_text(&user.text, &spk.text) {
        return false;
    }
    let nu = normalize_words(&user.text);
    let ns = normalize_words(&spk.text);
    if ns.contains(nu.as_str()) && nu.len() >= 8 {
        return true;
    }
    let wc_u = word_count(&user.text);
    let wc_s = word_count(&spk.text);
    if wc_s >= 4 && wc_u + 2 <= wc_s {
        return true;
    }
    wc_u + 1 <= wc_s && wc_s >= 6
}

/// Apply echo-aware dedup for a **final** utterance. Mutates `buf` when
/// removing a superseded user line; returns what the caller should emit.
pub fn apply_final_dedup(buf: &mut TranscriptBuffer, u: Utterance) -> FinalDedupOutcome {
    let merged = buf.merged_view();
    if merged.is_empty() {
        return FinalDedupOutcome::Append { utterance: u };
    }

    match u.channel {
        ChannelLabel::User => {
            for prev in merged.iter().rev().take(MERGED_LOOKBACK) {
                if prev.channel != ChannelLabel::Speakers {
                    continue;
                }
                if !time_close(prev.started_at_ms, u.started_at_ms) {
                    continue;
                }
                if is_near_duplicate_text(&prev.text, &u.text) {
                    log::info!(
                        "[Copilot/dedup] suppressing mic echo (user final matches speakers): {:?}",
                        u.text.chars().take(80).collect::<String>()
                    );
                    return FinalDedupOutcome::Suppress {
                        retract_keys: vec![overlay_key(ChannelLabel::User, u.started_at_ms)],
                    };
                }
            }
        }
        ChannelLabel::Speakers => {
            for prev in merged.iter().rev().take(MERGED_LOOKBACK) {
                if prev.channel != ChannelLabel::User {
                    continue;
                }
                if !time_close(prev.started_at_ms, u.started_at_ms) {
                    continue;
                }
                if user_is_echo_fragment_of_speakers(prev, &u) {
                    let started = prev.started_at_ms;
                    if buf.remove_user_utterance_at(started) {
                        log::info!(
                            "[Copilot/dedup] removed user echo fragment before speakers final (at {} ms)",
                            started
                        );
                        return FinalDedupOutcome::AppendAfterRetracting {
                            retract_keys: vec![overlay_key(ChannelLabel::User, started)],
                            utterance: u,
                        };
                    }
                }
            }
        }
    }

    FinalDedupOutcome::Append { utterance: u }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_normalized_is_dup() {
        assert!(is_near_duplicate_text(
            "The lead intake automation is almost certainly the real core.",
            "the lead intake automation is almost certainly the real core"
        ));
    }

    #[test]
    fn substring_dup() {
        assert!(is_near_duplicate_text(
            "But the intake system is probably where the business value actually is.",
            "system is probably where the business value actually is."
        ));
    }

    #[test]
    fn unrelated_not_dup() {
        assert!(!is_near_duplicate_text(
            "Can we schedule a follow-up next Tuesday?",
            "What's your pricing for fifty seats?"
        ));
    }

    #[test]
    fn suppress_user_when_speakers_first() {
        let mut buf = TranscriptBuffer::with_default_window();
        let spk = Utterance {
            channel: ChannelLabel::Speakers,
            started_at_ms: 1000,
            ended_at_ms: 2000,
            text: "The lead intake automation is almost certainly the real core of the project."
                .into(),
            confidence: 0.9,
            recorded_at: std::time::Instant::now(),
        };
        buf.append(spk);
        let user_echo = Utterance {
            channel: ChannelLabel::User,
            started_at_ms: 1200,
            ended_at_ms: 2100,
            text: "The lead intake automation is almost certainly the real core of the project."
                .into(),
            confidence: 0.85,
            recorded_at: std::time::Instant::now(),
        };
        let out = apply_final_dedup(&mut buf, user_echo);
        assert!(matches!(out, FinalDedupOutcome::Suppress { .. }));
        assert_eq!(buf.total_len(), 1);
    }

    #[test]
    fn remove_user_fragment_when_speakers_arrives() {
        let mut buf = TranscriptBuffer::with_default_window();
        let user_frag = Utterance {
            channel: ChannelLabel::User,
            started_at_ms: 500,
            ended_at_ms: 800,
            text: "That's where labor costs, processing speed, conversion rates,".into(),
            confidence: 0.8,
            recorded_at: std::time::Instant::now(),
        };
        buf.append(user_frag);
        let spk = Utterance {
            channel: ChannelLabel::Speakers,
            started_at_ms: 520,
            ended_at_ms: 1200,
            text: "That's where labor costs, processing speed, conversion rates, and operational bottlenecks live."
                .into(),
            confidence: 0.92,
            recorded_at: std::time::Instant::now(),
        };
        let out = apply_final_dedup(&mut buf, spk);
        match out {
            FinalDedupOutcome::AppendAfterRetracting { utterance, .. } => {
                buf.append(utterance);
            }
            _ => panic!("expected AppendAfterRetracting, got {out:?}"),
        }
        assert_eq!(buf.user_len(), 0);
        assert_eq!(buf.speakers_len(), 1);
    }
}
