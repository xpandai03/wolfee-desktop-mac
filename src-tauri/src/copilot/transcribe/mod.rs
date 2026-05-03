//! Copilot transcription pipeline (Sub-prompt 2 — Listening).
//!
//! Sub-prompt 2 ships:
//! - `buffer` — the 90-s sliding-window transcript buffer Sub-prompt 3
//!   reads from for moment detection + suggestion generation.
//! - `deepgram` (Phase 3) — the WebSocket client that feeds finals
//!   into `buffer` and emits `transcript-chunk` Tauri events for the
//!   overlay UI in Sub-prompt 4.

pub mod buffer;
pub mod deepgram;
