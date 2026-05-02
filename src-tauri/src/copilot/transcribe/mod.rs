//! Copilot transcription pipeline (Sub-prompt 2 — Listening).
//!
//! Sub-prompt 2 ships:
//! - `buffer` — the 90-s sliding-window transcript buffer Sub-prompt 3
//!   reads from for moment detection + suggestion generation.
//!
//! Sub-prompt 2 (later commits) adds:
//! - `deepgram` — the WebSocket client that feeds finals into `buffer`.

pub mod buffer;
