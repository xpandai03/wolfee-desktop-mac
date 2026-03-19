use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::path::Path;

const MAX_FILE_SIZE: u64 = 200 * 1024 * 1024; // 200MB

#[derive(Debug, Serialize)]
pub struct UploadMetadata {
    pub source: String,
    #[serde(rename = "detectedPlatform")]
    pub detected_platform: String,
    #[serde(rename = "startTime")]
    pub start_time: String,
    #[serde(rename = "endTime")]
    pub end_time: String,
    pub duration: f64,
}

#[derive(Debug, Deserialize)]
pub struct UploadResponse {
    pub id: Option<i64>,
}

pub struct UploadResult {
    pub meeting_id: Option<i64>,
    pub meeting_url: Option<String>,
}

pub async fn upload_recording(
    file_path: &Path,
    metadata: &UploadMetadata,
    backend_url: &str,
    auth_token: &str,
) -> Result<UploadResult, String> {
    // Validate file
    let file_meta = std::fs::metadata(file_path)
        .map_err(|e| format!("File not found: {}", e))?;

    if file_meta.len() == 0 {
        return Err("Empty recording file".to_string());
    }
    if file_meta.len() > MAX_FILE_SIZE {
        return Err(format!("File too large: {} bytes (max {})", file_meta.len(), MAX_FILE_SIZE));
    }

    let size_mb = file_meta.len() as f64 / 1024.0 / 1024.0;
    // Log auth token type for debugging
    if auth_token.starts_with("wf_") {
        log::info!("[AUTH] Using API key (wf_...) for upload");
    } else {
        log::info!("[AUTH] Using device auth token for upload");
    }
    log::info!("[UPLOAD] Begin: {} ({:.2} MB, duration={:.1}s)", file_path.display(), size_mb, metadata.duration);
    log::info!("[UPLOAD] mime=audio/wav");

    // Build multipart form
    let file_bytes = tokio::fs::read(file_path).await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let file_name = file_path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let file_part = multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("audio/wav")
        .map_err(|e| format!("Failed to create file part: {}", e))?;

    let metadata_json = serde_json::to_string(metadata)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;

    let form = multipart::Form::new()
        .part("file", file_part)
        .text("metadata", metadata_json);

    let url = format!("{}/api/meetings/import/desktop", backend_url);

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth_token))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Upload timed out (120s)".to_string()
            } else if e.is_connect() {
                format!("Cannot reach server: {}", e)
            } else {
                format!("Upload failed: {}", e)
            }
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        log::error!("[AUTH] 401 — token rejected by server. Check that your API key or device token is valid.");
        return Err("Auth token rejected (401). Re-link your account or check WOLFEE_API_KEY.".to_string());
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        log::error!("[UPLOAD] HTTP {}: {}", status.as_u16(), body);
        return Err(format!("Upload failed: HTTP {} — {}", status.as_u16(), body));
    }

    let body: UploadResponse = response.json().await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let meeting_url = body.id.map(|id| format!("{}/meetings/{}", backend_url, id));

    log::info!("[UPLOAD] Success: meetingId={:?}, url={:?}", body.id, meeting_url);

    Ok(UploadResult {
        meeting_id: body.id,
        meeting_url,
    })
}
