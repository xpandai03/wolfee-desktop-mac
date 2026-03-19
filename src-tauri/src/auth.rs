use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct AuthConfig {
    pub auth_token: Option<String>,
    pub user_id: Option<String>,
    pub device_id: String,
    pub backend_url: String,
}

impl AuthConfig {
    pub fn config_path() -> PathBuf {
        let dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("io.wolfee.desktop");
        std::fs::create_dir_all(&dir).ok();
        dir.join("auth.json")
    }

    pub fn load() -> Self {
        // Priority 1: WOLFEE_API_KEY env var (fast path for dev/testing)
        if let Ok(api_key) = std::env::var("WOLFEE_API_KEY") {
            if !api_key.is_empty() {
                log::info!("[AUTH] Using WOLFEE_API_KEY from environment");
                return Self {
                    auth_token: Some(api_key),
                    user_id: None,
                    device_id: Self::load_or_create_device_id(),
                    backend_url: Self::resolve_backend_url(),
                };
            }
        }

        // Priority 2: Persisted auth.json
        let path = Self::config_path();
        match std::fs::read_to_string(&path) {
            Ok(data) => {
                let config: Self = serde_json::from_str(&data).unwrap_or_else(|_| Self::new_default());
                if config.is_authenticated() {
                    log::info!("[AUTH] Loaded token from {}", path.display());
                } else {
                    log::warn!("[AUTH] No auth token found — upload disabled");
                }
                config
            }
            Err(_) => {
                log::warn!("[AUTH] Missing API key — upload disabled. Set WOLFEE_API_KEY or link account.");
                Self::new_default()
            }
        }
    }

    pub fn save(&self) {
        let path = Self::config_path();
        if let Ok(data) = serde_json::to_string_pretty(self) {
            match std::fs::write(&path, &data) {
                Ok(_) => log::info!("[AUTH] Saved config to {}", path.display()),
                Err(e) => log::error!("[AUTH] Failed to save config: {}", e),
            }
        }
    }

    fn resolve_backend_url() -> String {
        std::env::var("WOLFEE_BACKEND_URL").unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "http://localhost:3000".to_string()
            } else {
                "https://wolfee.io".to_string()
            }
        })
    }

    /// Load device_id from existing auth.json, or create a new one.
    /// This ensures the device_id is stable across restarts even when
    /// using WOLFEE_API_KEY (which would otherwise generate a new UUID each time).
    fn load_or_create_device_id() -> String {
        let path = Self::config_path();
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<Self>(&data) {
                if !config.device_id.is_empty() {
                    return config.device_id;
                }
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        // Persist the new device_id immediately so it's stable
        let config = Self {
            device_id: id.clone(),
            backend_url: Self::resolve_backend_url(),
            ..Default::default()
        };
        config.save();
        id
    }

    fn new_default() -> Self {
        Self {
            auth_token: None,
            user_id: None,
            device_id: Self::load_or_create_device_id(),
            backend_url: Self::resolve_backend_url(),
        }
    }

    pub fn is_authenticated(&self) -> bool {
        self.auth_token.is_some()
    }
}

/// Response from the device link status endpoint.
#[derive(Debug, Deserialize)]
pub struct LinkStatusResponse {
    pub linked: bool,
    #[serde(rename = "authToken")]
    pub auth_token: Option<String>,
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
}

/// Poll the backend to check if the device has been linked.
/// Called after opening the browser link URL.
/// Returns (auth_token, user_id) on success.
pub async fn poll_link_status(
    backend_url: &str,
    device_id: &str,
) -> Result<(String, Option<String>), String> {
    let url = format!("{}/api/devices/{}/status", backend_url, device_id);
    let client = reqwest::Client::new();

    log::info!("[AUTH] Polling link status: {}", url);

    // Poll every 2 seconds for up to 120 seconds
    for attempt in 1..=60 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let response = match client
            .get(&url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                if attempt % 5 == 0 {
                    log::warn!("[AUTH] Poll attempt {}/60 failed: {}", attempt, e);
                }
                continue;
            }
        };

        if !response.status().is_success() {
            if attempt % 5 == 0 {
                log::warn!("[AUTH] Poll attempt {}/60: HTTP {}", attempt, response.status());
            }
            continue;
        }

        match response.json::<LinkStatusResponse>().await {
            Ok(status) => {
                if status.linked {
                    if let Some(token) = status.auth_token {
                        log::info!("[AUTH] Link confirmed! userId={:?}", status.user_id);
                        return Ok((token, status.user_id));
                    }
                    log::warn!("[AUTH] Linked but no token in response");
                }
            }
            Err(e) => {
                if attempt % 5 == 0 {
                    log::warn!("[AUTH] Poll attempt {}/60: parse error: {}", attempt, e);
                }
            }
        }
    }

    Err("Link timed out after 120 seconds. Please try again.".to_string())
}
