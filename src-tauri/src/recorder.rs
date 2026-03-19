use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::{Child, Command};
use tokio::io::AsyncWriteExt;

pub struct Recorder {
    process: Option<Child>,
    output_path: Option<PathBuf>,
    recordings_dir: PathBuf,
    start_time: Option<std::time::Instant>,
}

impl Recorder {
    pub fn new() -> Self {
        let recordings_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("io.wolfee.desktop")
            .join("recordings");
        std::fs::create_dir_all(&recordings_dir).ok();

        Self {
            process: None,
            output_path: None,
            recordings_dir,
            start_time: None,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.process.is_some()
    }

    pub fn ffmpeg_path() -> String {
        // In production: sidecar binary resolved by Tauri
        // In dev: use system ffmpeg
        if let Ok(path) = std::env::var("FFMPEG_PATH") {
            return path;
        }

        // Check for Tauri sidecar path
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));

        if let Some(dir) = exe_dir {
            // macOS: inside .app/Contents/MacOS/
            let sidecar = dir.join("ffmpeg");
            if sidecar.exists() {
                return sidecar.to_string_lossy().to_string();
            }
        }

        "ffmpeg".to_string()
    }

    pub async fn start(&mut self) -> Result<PathBuf, String> {
        if self.process.is_some() {
            return Err("Already recording".to_string());
        }

        let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
        let output_path = self.recordings_dir.join(format!("recording_{}.wav", timestamp));
        let ffmpeg = Self::ffmpeg_path();

        // Detect audio devices and build args
        let args = self.build_capture_args(&output_path).await?;

        log::info!("[Recorder] FORMAT: Stereo WAV pcm_s16le 16kHz (L=mic, R=system)");
        log::info!("[Recorder] Starting: {} {}", ffmpeg, args.join(" "));

        let child = Command::new(&ffmpeg)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

        self.process = Some(child);
        self.output_path = Some(output_path.clone());
        self.start_time = Some(std::time::Instant::now());

        log::info!("[Recorder] Recording to: {}", output_path.display());
        Ok(output_path)
    }

    pub async fn stop(&mut self) -> Result<RecordingResult, String> {
        let mut child = self.process.take()
            .ok_or_else(|| "Not recording".to_string())?;
        let output_path = self.output_path.take()
            .ok_or_else(|| "No output path".to_string())?;
        let duration = self.start_time.take()
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);

        log::info!("[Recorder] Stopping — wall-clock: {:.1}s", duration);

        // Send 'q' to gracefully stop ffmpeg
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(b"q").await;
            let _ = stdin.flush().await;
        }

        // WAV doesn't need finalization — 5s is plenty for ffmpeg to flush and exit
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            child.wait(),
        ).await;

        match result {
            Ok(Ok(status)) => {
                log::info!("[Recorder] ffmpeg exited cleanly: {}", status);
            }
            Ok(Err(e)) => {
                log::error!("[Recorder] ffmpeg wait error: {}", e);
            }
            Err(_) => {
                log::warn!("[Recorder] ffmpeg did not exit in 5s — killing");
                let _ = child.kill().await;
            }
        }

        // Verify output file
        match std::fs::metadata(&output_path) {
            Ok(meta) => {
                let size_mb = meta.len() as f64 / 1024.0 / 1024.0;
                log::info!("[Recorder] Output: {} ({:.2} MB)", output_path.display(), size_mb);
                if meta.len() == 0 {
                    return Err("Recording file is empty".to_string());
                }
            }
            Err(_) => {
                return Err(format!("Recording file not found: {}", output_path.display()));
            }
        }

        Ok(RecordingResult {
            file_path: output_path,
            duration,
        })
    }

    pub fn force_kill(&mut self) {
        if let Some(ref mut child) = self.process {
            log::info!("[Recorder] Force-killing ffmpeg");
            let _ = child.start_kill();
            self.process = None;
        }
        self.start_time = None;
    }

    async fn build_capture_args(&self, output_path: &PathBuf) -> Result<Vec<String>, String> {
        let output = output_path.to_string_lossy().to_string();

        #[cfg(target_os = "macos")]
        {
            // Detect loopback device
            let devices = detect_macos_devices().await;

            if let Some((loopback_idx, mic_idx)) = devices {
                log::info!("[Recorder] Dual capture: mic :{} (L) + loopback :{} (R) → stereo WAV", mic_idx, loopback_idx);
                Ok(vec![
                    "-f".into(), "avfoundation".into(),
                    "-i".into(), format!(":{}", mic_idx),
                    "-f".into(), "avfoundation".into(),
                    "-i".into(), format!(":{}", loopback_idx),
                    "-filter_complex".into(), "[0:a][1:a]amerge=inputs=2".into(),
                    "-ac".into(), "2".into(),
                    "-ar".into(), "16000".into(),
                    "-c:a".into(), "pcm_s16le".into(),
                    "-f".into(), "wav".into(),
                    "-y".into(),
                    output,
                ])
            } else {
                log::info!("[Recorder] Mic-only capture (no loopback device)");
                Ok(vec![
                    "-f".into(), "avfoundation".into(),
                    "-i".into(), ":0".into(),
                    "-ac".into(), "1".into(),
                    "-ar".into(), "16000".into(),
                    "-c:a".into(), "pcm_s16le".into(),
                    "-f".into(), "wav".into(),
                    "-y".into(),
                    output,
                ])
            }
        }

        #[cfg(target_os = "windows")]
        {
            log::info!("[Recorder] Windows: dshow mic capture");
            Ok(vec![
                "-f".into(), "dshow".into(),
                "-i".into(), "audio=Microphone".into(),
                "-ac".into(), "1".into(),
                "-ar".into(), "16000".into(),
                "-c:a".into(), "pcm_s16le".into(),
                "-f".into(), "wav".into(),
                "-y".into(),
                output,
            ])
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err("Unsupported platform".to_string())
        }
    }
}

pub struct RecordingResult {
    pub file_path: PathBuf,
    pub duration: f64,
}

#[cfg(target_os = "macos")]
async fn detect_macos_devices() -> Option<(String, String)> {
    let ffmpeg = Recorder::ffmpeg_path();
    let output = tokio::process::Command::new(&ffmpeg)
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .ok()?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut in_audio = false;
    let mut mic_idx = "0".to_string();
    let mut loopback_idx: Option<String> = None;

    let loopback_keywords = ["blackhole", "loopback", "soundflower", "virtual", "multi-output", "loomaudiodevice"];

    for line in stderr.lines() {
        if line.contains("AVFoundation audio devices:") {
            in_audio = true;
            continue;
        }
        if !in_audio {
            continue;
        }

        // Parse "[AVFoundation ...] [X] Device Name"
        if let Some(caps) = extract_device_index(line) {
            let (idx, name) = caps;
            let name_lower = name.to_lowercase();

            if loopback_keywords.iter().any(|kw| name_lower.contains(kw)) {
                log::info!("[Devices] Loopback: \"{}\" at index {}", name, idx);
                loopback_idx = Some(idx.clone());
            } else if name_lower.contains("microphone") {
                log::info!("[Devices] Mic: \"{}\" at index {}", name, idx);
                mic_idx = idx;
            }
        }
    }

    loopback_idx.map(|lb| (lb, mic_idx))
}

#[cfg(target_os = "macos")]
fn extract_device_index(line: &str) -> Option<(String, String)> {
    // Match pattern: [X] Device Name
    let re_pattern = line.trim();
    if let Some(bracket_start) = re_pattern.rfind('[') {
        if let Some(bracket_end) = re_pattern[bracket_start..].find(']') {
            let idx = &re_pattern[bracket_start + 1..bracket_start + bracket_end];
            if let Ok(_) = idx.parse::<u32>() {
                let name = re_pattern[bracket_start + bracket_end + 1..].trim();
                return Some((idx.to_string(), name.to_string()));
            }
        }
    }
    None
}
