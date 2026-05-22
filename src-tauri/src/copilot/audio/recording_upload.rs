//! Phase 3 of Copilot session recordings — upload the local M4A to
//! the web app.
//!
//! Three steps, mirroring the `/api/videos` model:
//!   1. POST {backend}/api/copilot/sessions/{id}/recording
//!      → returns `{ uploadUrl, key }`; backend stores the key + size +
//!      duration on the session row.
//!   2. PUT  {uploadUrl}                          (Content-Type: audio/mp4)
//!      → uploads the file directly to R2.
//!   3. POST {backend}/api/copilot/sessions/{id}/recording/uploaded
//!      → backend marks `recording_uploaded_at = NOW()`.
//!
//! All requests carry the desktop's device-auth Bearer token so the
//! `requireDeviceAuth` middleware accepts them.
//!
//! Errors keep the local file. The end-session caller decides whether
//! to delete-on-success.

#![cfg(target_os = "macos")]

use super::CopilotRecordingResult;

/// POST → PUT → POST. On Ok the M4A is uploaded and the row is marked
/// uploaded; on Err the caller should leave the local file in place.
pub async fn upload_recording(
    backend_url: &str,
    token: &str,
    session_id: &str,
    result: &CopilotRecordingResult,
) -> Result<(), String> {
    let backend = backend_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("reqwest client: {e}"))?;

    // 1. Presign.
    let presign_url =
        format!("{backend}/api/copilot/sessions/{session_id}/recording");
    log::info!(
        "[Copilot/rec] POST {presign_url} ({} bytes, {} ms)",
        result.size_bytes,
        result.duration_ms
    );
    let presign_resp = client
        .post(&presign_url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "contentType": "audio/mp4",
            "sizeBytes": result.size_bytes,
            "durationMs": result.duration_ms,
        }))
        .send()
        .await
        .map_err(|e| format!("presign request: {e}"))?;
    if !presign_resp.status().is_success() {
        let status = presign_resp.status();
        let body = presign_resp.text().await.unwrap_or_default();
        return Err(format!("presign HTTP {status}: {body}"));
    }
    let PresignResp { upload_url, key } = presign_resp
        .json()
        .await
        .map_err(|e| format!("presign body: {e}"))?;
    log::info!("[Copilot/rec] presigned → key={key}");

    // 2. PUT direct to R2.
    //
    // Read the file into memory; M4A for a typical session is a few
    // MB, occasionally tens of MB for long calls. reqwest's `body()`
    // takes a Vec<u8> via Into<Body>, which is the simplest path. If
    // we ever hit memory pressure here (multi-GB recordings) we
    // switch to ReaderStream like the Loom uploader does.
    let body = tokio::fs::read(&result.path)
        .await
        .map_err(|e| format!("read M4A: {e}"))?;
    log::info!(
        "[Copilot/rec] PUT R2 ({:.2} MB)",
        (body.len() as f64) / 1_048_576.0
    );
    let put_resp = client
        .put(&upload_url)
        .header("Content-Type", "audio/mp4")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("PUT R2 request: {e}"))?;
    if !put_resp.status().is_success() {
        let status = put_resp.status();
        let body = put_resp.text().await.unwrap_or_default();
        return Err(format!("PUT R2 HTTP {status}: {body}"));
    }

    // 3. Notify.
    let notify_url = format!(
        "{backend}/api/copilot/sessions/{session_id}/recording/uploaded"
    );
    log::info!("[Copilot/rec] POST {notify_url}");
    let notify_resp = client
        .post(&notify_url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "sizeBytes": result.size_bytes,
            "durationMs": result.duration_ms,
        }))
        .send()
        .await
        .map_err(|e| format!("notify request: {e}"))?;
    if !notify_resp.status().is_success() {
        let status = notify_resp.status();
        let body = notify_resp.text().await.unwrap_or_default();
        return Err(format!("notify HTTP {status}: {body}"));
    }

    log::info!("[Copilot/rec] upload complete for session={session_id}");
    Ok(())
}

#[derive(serde::Deserialize)]
struct PresignResp {
    #[serde(rename = "uploadUrl")]
    upload_url: String,
    key: String,
}
