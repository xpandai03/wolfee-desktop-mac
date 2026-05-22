//! Loom-style screen recorder — upload (Phase 1).
//!
//! Three steps against the already-deployed web backend:
//!   1. `POST /api/videos` — register the recording, get back a
//!      presigned R2 `uploadUrl`.
//!   2. `PUT <uploadUrl>` — stream the MP4 straight from disk to R2.
//!      The file is never read fully into memory: a `ReaderStream`
//!      feeds `reqwest::Body::wrap_stream`, wrapped once more by
//!      `ProgressBody` so the tray can show a percentage.
//!   3. `POST /api/videos/:id/uploaded` — tell the backend the bytes
//!      landed; this kicks off server-side transcription + thumbnail.
//!
//! The presigned `PUT` carries no `Authorization` header — the signed
//! URL *is* the authorization. Only steps 1 and 3 send the device
//! token / `wf_` API key.

use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures_core::Stream;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use tokio_util::io::ReaderStream;

/// Generous ceiling for the R2 upload itself — a 1 GB recording on a
/// slow uplink can legitimately take a long time. Steps 1 and 3 use a
/// short timeout (plain JSON calls).
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const API_TIMEOUT: Duration = Duration::from_secs(30);
const MIME: &str = "video/mp4";

/// Outcome of a successful upload — the shareable link to surface.
pub struct ShareResult {
    pub share_url: String,
}

/// Run the full create → upload → mark-uploaded sequence.
///
/// `on_progress` is called with the upload percentage (0..=100) as
/// bytes land; it fires at most ~100 times. It must be cheap — the
/// caller is expected to throttle any heavy work (e.g. tray redraws).
pub async fn upload_video<F>(
    file_path: &Path,
    duration_secs: f64,
    size_bytes: u64,
    backend_url: &str,
    auth_token: &str,
    on_progress: F,
) -> Result<ShareResult, String>
where
    F: Fn(u8) + Send + Sync + 'static,
{
    let title = format!(
        "Screen Recording {}",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    );

    log::info!(
        "[Loom/upload] begin — {} ({:.1} MB, {duration_secs:.1}s)",
        file_path.display(),
        size_bytes as f64 / 1_048_576.0
    );

    // 1. Register the recording, get the presigned URL.
    let created = create_video(backend_url, auth_token, &title, size_bytes).await?;
    log::info!(
        "[Loom/upload] video registered — id={} shortId={}",
        created.id,
        created.short_id
    );

    // 2. Stream the file to R2.
    upload_to_r2(file_path, &created.upload_url, size_bytes, Arc::new(on_progress)).await?;
    log::info!("[Loom/upload] bytes uploaded to R2");

    // 3. Tell the backend the upload landed → triggers processing.
    mark_uploaded(
        backend_url,
        auth_token,
        &created.id,
        duration_secs,
        size_bytes,
    )
    .await?;

    let share_url = format!(
        "{}/v/{}",
        backend_url.trim_end_matches('/'),
        created.short_id
    );
    log::info!("[Loom/upload] complete — {share_url}");

    Ok(ShareResult { share_url })
}

struct CreatedVideo {
    id: String,
    short_id: String,
    upload_url: String,
}

/// `POST /api/videos` → `{ id, shortId, uploadUrl }`.
async fn create_video(
    backend_url: &str,
    auth_token: &str,
    title: &str,
    size_bytes: u64,
) -> Result<CreatedVideo, String> {
    let url = format!("{}/api/videos", backend_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "title": title,
        "contentType": MIME,
        "fileSize": size_bytes,
        "ext": "mp4",
    });

    let res = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {auth_token}"))
        .json(&body)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|e| friendly_net_error("create video", &e))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Auth rejected (401) — re-link your Wolfee account.".to_string());
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Create video failed: HTTP {} — {body}", status.as_u16()));
    }

    let v: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Create video: bad JSON response: {e}"))?;
    // Tolerate a flat body or a `{ "video": { ... } }` envelope.
    let obj = v.get("video").unwrap_or(&v);

    let id = json_id_to_string(obj.get("id"))
        .ok_or_else(|| "Create video response missing `id`.".to_string())?;
    let short_id = obj
        .get("shortId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Create video response missing `shortId`.".to_string())?
        .to_string();
    let upload_url = obj
        .get("uploadUrl")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Create video response missing `uploadUrl`.".to_string())?
        .to_string();

    Ok(CreatedVideo {
        id,
        short_id,
        upload_url,
    })
}

/// `PUT <presigned R2 url>` — stream the file from disk with progress.
async fn upload_to_r2(
    file_path: &Path,
    upload_url: &str,
    total: u64,
    on_progress: Arc<dyn Fn(u8) + Send + Sync>,
) -> Result<(), String> {
    let file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Cannot open recording for upload: {e}"))?;

    let body_stream = ProgressBody {
        inner: ReaderStream::new(file),
        sent: 0,
        total: total.max(1),
        last_pct: u8::MAX, // force the first real report
        cb: on_progress,
    };

    let res = reqwest::Client::new()
        .put(upload_url)
        .header(CONTENT_TYPE, MIME)
        .header(CONTENT_LENGTH, total)
        .body(reqwest::Body::wrap_stream(body_stream))
        .timeout(UPLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| friendly_net_error("upload to storage", &e))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Storage upload failed: HTTP {} — {body}",
            status.as_u16()
        ));
    }
    Ok(())
}

/// `POST /api/videos/:id/uploaded` — finalize; backend starts processing.
async fn mark_uploaded(
    backend_url: &str,
    auth_token: &str,
    id: &str,
    duration_secs: f64,
    size_bytes: u64,
) -> Result<(), String> {
    let url = format!(
        "{}/api/videos/{}/uploaded",
        backend_url.trim_end_matches('/'),
        id
    );
    let body = serde_json::json!({
        "durationSeconds": duration_secs.round() as i64,
        "sizeBytes": size_bytes,
    });

    let res = reqwest::Client::new()
        .post(&url)
        .header("Authorization", format!("Bearer {auth_token}"))
        .json(&body)
        .timeout(API_TIMEOUT)
        .send()
        .await
        .map_err(|e| friendly_net_error("finalize upload", &e))?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Finalize upload failed: HTTP {} — {body}",
            status.as_u16()
        ));
    }
    Ok(())
}

/// Stream adapter: passes chunks straight through while tallying bytes
/// and reporting the upload percentage. Reports only when the integer
/// percent changes, so the callback fires ~100 times for any file size.
struct ProgressBody {
    inner: ReaderStream<tokio::fs::File>,
    sent: u64,
    total: u64,
    last_pct: u8,
    cb: Arc<dyn Fn(u8) + Send + Sync>,
}

impl Stream for ProgressBody {
    type Item = std::io::Result<Bytes>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // ProgressBody is Unpin (all fields are), so get_mut() is sound.
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                this.sent = this.sent.saturating_add(chunk.len() as u64);
                let pct = ((this.sent.min(this.total) * 100) / this.total) as u8;
                if pct != this.last_pct {
                    this.last_pct = pct;
                    (this.cb)(pct);
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            other => other,
        }
    }
}

/// Accept either a string or a numeric JSON `id`.
fn json_id_to_string(v: Option<&serde_json::Value>) -> Option<String> {
    match v? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn friendly_net_error(stage: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("Timed out trying to {stage}.")
    } else if e.is_connect() {
        format!("Cannot reach the Wolfee server to {stage}.")
    } else {
        format!("Failed to {stage}: {e}")
    }
}
