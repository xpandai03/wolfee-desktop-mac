//! Per-channel transcript buffer with merged-time-ordered read view.
//!
//! Locks per the Sub-prompt 2 plan §6 (Option C):
//! - Per-channel `VecDeque<Utterance>` so the moment detector (Sub-prompt 3)
//!   can ask "did the user finish a question and the speakers go silent?"
//!   without re-grouping on every read.
//! - 90-s sliding window. Older utterances are pruned on every `append`.
//! - **Finals only.** Deepgram emits both partials and finals; only finals
//!   enter this buffer to prevent moment detection firing on noise that
//!   gets revised. Partials are emitted as Tauri events for live transcript
//!   display in Sub-prompt 4 — they don't pass through this struct.
//!
//! Speaker label naming convention is locked at `User` (mic, channel 0)
//! and `Speakers` (system audio, channel 1) per the Sub-prompt 2 batch
//! decisions (PO chose generic over rep/prospect).

use std::collections::VecDeque;
use std::time::Instant;

/// Default buffer window matching design doc §3 + plan §6.
pub const DEFAULT_WINDOW_MS: u64 = 90_000;

/// Channel label, propagated from Deepgram's `channel_index` field
/// (`multichannel=true` query param).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelLabel {
    /// Microphone — the call's user. Deepgram channel_index = 0.
    User,
    /// System audio — the other parties on the call. Deepgram channel_index = 1.
    Speakers,
}

impl ChannelLabel {
    pub fn from_deepgram_channel_index(idx: u32) -> Option<Self> {
        match idx {
            0 => Some(Self::User),
            1 => Some(Self::Speakers),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Speakers => "speakers",
        }
    }
}

/// One final transcript chunk from Deepgram. Partials never construct
/// `Utterance` — they're discarded at the boundary of the WS client.
#[derive(Debug, Clone)]
pub struct Utterance {
    pub channel: ChannelLabel,
    /// Deepgram's start-of-utterance timestamp, ms since session start.
    pub started_at_ms: u64,
    /// Deepgram's end timestamp (also session-relative).
    pub ended_at_ms: u64,
    pub text: String,
    /// Deepgram's per-utterance confidence in [0.0, 1.0]. Used by
    /// Sub-prompt 3 to filter noise from the moment-detector input.
    pub confidence: f32,
    /// Wall-clock time the utterance was recorded into the buffer.
    /// Used for window pruning so the buffer doesn't drift if Deepgram
    /// ever resets its session-time reference mid-call.
    pub recorded_at: Instant,
}

impl Utterance {
    /// Detect whether this utterance ended on a question mark — used by
    /// Sub-prompt 3's moment detector for the silence-after-question
    /// trigger.
    pub fn ends_with_question(&self) -> bool {
        self.text.trim_end().ends_with('?')
    }
}

/// 90-s sliding-window buffer, per-channel.
pub struct TranscriptBuffer {
    user: VecDeque<Utterance>,
    speakers: VecDeque<Utterance>,
    window_ms: u64,
}

impl TranscriptBuffer {
    pub fn new(window_ms: u64) -> Self {
        Self {
            user: VecDeque::new(),
            speakers: VecDeque::new(),
            window_ms,
        }
    }

    pub fn with_default_window() -> Self {
        Self::new(DEFAULT_WINDOW_MS)
    }

    /// Append a final utterance and prune anything older than `window_ms`
    /// from the same channel. Pruning is per-channel because each is its
    /// own `VecDeque` — `merged_view()` does the merge on read.
    pub fn append(&mut self, u: Utterance) {
        let queue = match u.channel {
            ChannelLabel::User => &mut self.user,
            ChannelLabel::Speakers => &mut self.speakers,
        };
        queue.push_back(u);
        Self::prune(queue, self.window_ms);
    }

    fn prune(queue: &mut VecDeque<Utterance>, window_ms: u64) {
        let now = Instant::now();
        while let Some(front) = queue.front() {
            if now.duration_since(front.recorded_at).as_millis() as u64 > window_ms {
                queue.pop_front();
            } else {
                break;
            }
        }
    }

    /// Merged chronological view of both channels, oldest first. Used by
    /// Sub-prompt 3 for the moment detector + suggestion generator
    /// inputs. Returns owned clones so callers can drop the lock fast.
    pub fn merged_view(&self) -> Vec<Utterance> {
        let mut combined: Vec<Utterance> = self
            .user
            .iter()
            .chain(self.speakers.iter())
            .cloned()
            .collect();
        combined.sort_by_key(|u| u.started_at_ms);
        combined
    }

    /// Last `n` seconds (by recorded_at), merged across both channels.
    pub fn last_n_seconds(&self, n: u64) -> Vec<Utterance> {
        let cutoff = match Instant::now().checked_sub(std::time::Duration::from_secs(n)) {
            Some(t) => t,
            None => return self.merged_view(), // n exceeds clock; return everything
        };
        let mut combined: Vec<Utterance> = self
            .user
            .iter()
            .chain(self.speakers.iter())
            .filter(|u| u.recorded_at >= cutoff)
            .cloned()
            .collect();
        combined.sort_by_key(|u| u.started_at_ms);
        combined
    }

    /// Age in ms of the most recent user utterance that ended on a
    /// question mark. `None` if no such utterance exists in the buffer.
    /// Sub-prompt 3 reads this to detect "user asked a question and the
    /// speakers haven't answered yet."
    pub fn last_user_question_age_ms(&self) -> Option<u64> {
        self.user
            .iter()
            .rev()
            .find(|u| u.ends_with_question())
            .map(|u| Instant::now().duration_since(u.recorded_at).as_millis() as u64)
    }

    pub fn user_len(&self) -> usize {
        self.user.len()
    }

    pub fn speakers_len(&self) -> usize {
        self.speakers.len()
    }

    pub fn total_len(&self) -> usize {
        self.user.len() + self.speakers.len()
    }

    pub fn clear(&mut self) {
        self.user.clear();
        self.speakers.clear();
    }
}

impl Default for TranscriptBuffer {
    fn default() -> Self {
        Self::with_default_window()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    fn utt(channel: ChannelLabel, started_at_ms: u64, text: &str, recorded_at: Instant) -> Utterance {
        Utterance {
            channel,
            started_at_ms,
            ended_at_ms: started_at_ms + 1_000,
            text: text.to_string(),
            confidence: 0.95,
            recorded_at,
        }
    }

    #[test]
    fn append_increases_per_channel_lengths() {
        let mut buf = TranscriptBuffer::with_default_window();
        buf.append(utt(ChannelLabel::User, 1_000, "hello", Instant::now()));
        buf.append(utt(ChannelLabel::Speakers, 1_500, "hi back", Instant::now()));
        assert_eq!(buf.user_len(), 1);
        assert_eq!(buf.speakers_len(), 1);
        assert_eq!(buf.total_len(), 2);
    }

    #[test]
    fn merged_view_is_chronological() {
        let mut buf = TranscriptBuffer::with_default_window();
        let now = Instant::now();
        buf.append(utt(ChannelLabel::User, 3_000, "user-third", now));
        buf.append(utt(ChannelLabel::Speakers, 1_000, "speakers-first", now));
        buf.append(utt(ChannelLabel::User, 2_000, "user-second", now));
        let view = buf.merged_view();
        assert_eq!(view.len(), 3);
        assert_eq!(view[0].text, "speakers-first");
        assert_eq!(view[1].text, "user-second");
        assert_eq!(view[2].text, "user-third");
    }

    #[test]
    fn prune_drops_utterances_older_than_window() {
        let mut buf = TranscriptBuffer::new(100); // 100 ms window for fast test
        let old = Instant::now() - Duration::from_millis(500);
        buf.append(utt(ChannelLabel::User, 1_000, "stale", old));
        // Force the prune by appending fresh — old should be dropped.
        sleep(Duration::from_millis(10));
        buf.append(utt(ChannelLabel::User, 2_000, "fresh", Instant::now()));
        assert_eq!(buf.user_len(), 1);
        assert_eq!(buf.merged_view()[0].text, "fresh");
    }

    #[test]
    fn last_user_question_age_returns_none_without_questions() {
        let mut buf = TranscriptBuffer::with_default_window();
        buf.append(utt(ChannelLabel::User, 1_000, "no question here", Instant::now()));
        assert!(buf.last_user_question_age_ms().is_none());
    }

    #[test]
    fn last_user_question_age_finds_most_recent_question() {
        let mut buf = TranscriptBuffer::with_default_window();
        let earlier = Instant::now() - Duration::from_millis(3_000);
        let later = Instant::now() - Duration::from_millis(1_000);
        buf.append(utt(ChannelLabel::User, 1_000, "first question?", earlier));
        buf.append(utt(ChannelLabel::User, 2_000, "second question?", later));
        let age = buf.last_user_question_age_ms().expect("expected a question");
        // Should be ~1000 ms ± timing noise.
        assert!(age >= 900 && age <= 1_500, "age was {age}");
    }

    #[test]
    fn channel_label_from_deepgram_channel_index() {
        assert_eq!(
            ChannelLabel::from_deepgram_channel_index(0),
            Some(ChannelLabel::User)
        );
        assert_eq!(
            ChannelLabel::from_deepgram_channel_index(1),
            Some(ChannelLabel::Speakers)
        );
        assert_eq!(ChannelLabel::from_deepgram_channel_index(2), None);
    }

    #[test]
    fn channel_label_str_matches_locked_naming() {
        assert_eq!(ChannelLabel::User.as_str(), "user");
        assert_eq!(ChannelLabel::Speakers.as_str(), "speakers");
    }

    #[test]
    fn ends_with_question_handles_trailing_whitespace() {
        let u = utt(ChannelLabel::User, 0, "what now?  \n", Instant::now());
        assert!(u.ends_with_question());
        let u = utt(ChannelLabel::User, 0, "no question.", Instant::now());
        assert!(!u.ends_with_question());
    }

    #[test]
    fn clear_empties_both_channels() {
        let mut buf = TranscriptBuffer::with_default_window();
        buf.append(utt(ChannelLabel::User, 1_000, "a", Instant::now()));
        buf.append(utt(ChannelLabel::Speakers, 2_000, "b", Instant::now()));
        buf.clear();
        assert_eq!(buf.total_len(), 0);
    }
}
