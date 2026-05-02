//! Copilot session lifecycle (Sub-prompt 2 — Listening, Phase 5).
//!
//! Backend HTTP client for the three endpoints Phase 1 shipped:
//! - `POST /api/copilot/sessions` — create
//! - `POST /api/copilot/sessions/:id/deepgram-token` — mint JWT (Phase 3 will use)
//! - `POST /api/copilot/sessions/:id/end` — end

pub mod api;
