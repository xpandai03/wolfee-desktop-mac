import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { detectAudioDevices, AudioDeviceInfo } from '../audioDevices';

function getFfmpegPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg');
  }
  try {
    return require('ffmpeg-static') as string;
  } catch {
    return 'ffmpeg';
  }
}

export class AudioRecorder {
  private ffmpegProcess: ChildProcess | null = null;
  private outputPath: string = '';
  private startTime: number = 0;
  private recordingsDir: string;
  private deviceInfo: AudioDeviceInfo | null = null;
  private stopTimeouts: NodeJS.Timeout[] = [];

  constructor(recordingsDir: string) {
    this.recordingsDir = recordingsDir;
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
  }

  get isRecording(): boolean {
    return this.ffmpegProcess !== null;
  }

  get currentOutputPath(): string {
    return this.outputPath;
  }

  get duration(): number {
    if (this.startTime === 0) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  get hasSystemAudio(): boolean {
    return this.deviceInfo?.hasLoopback ?? false;
  }

  detectDevices(): AudioDeviceInfo {
    this.deviceInfo = detectAudioDevices();
    return this.deviceInfo;
  }

  /** Immediately kill ffmpeg and clear all pending timeouts. Used during app quit. */
  forceKill(): void {
    for (const t of this.stopTimeouts) clearTimeout(t);
    this.stopTimeouts = [];
    if (this.ffmpegProcess) {
      console.log('[Recorder] Force-killing ffmpeg for app quit');
      try { this.ffmpegProcess.kill('SIGKILL'); } catch { /* already dead */ }
      this.ffmpegProcess = null;
    }
    this.startTime = 0;
  }

  start(): string {
    if (this.ffmpegProcess) {
      throw new Error('Already recording');
    }

    if (!this.deviceInfo) {
      this.detectDevices();
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.outputPath = path.join(this.recordingsDir, `recording_${timestamp}.mp4`);
    this.startTime = Date.now();

    const ffmpeg = getFfmpegPath();
    const args = this.buildCaptureArgs();

    console.log(`[Recorder] Starting ffmpeg: ${ffmpeg} ${args.join(' ')}`);

    this.ffmpegProcess = spawn(ffmpeg, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error(`[ffmpeg] ${msg}`);
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('[Recorder] ffmpeg process error:', err.message);
      this.ffmpegProcess = null;
    });

    this.ffmpegProcess.on('exit', (code) => {
      console.log(`[Recorder] ffmpeg exited with code ${code}`);
      this.ffmpegProcess = null;
    });

    return this.outputPath;
  }

  stop(): Promise<{ filePath: string; duration: number }> {
    return new Promise((resolve, reject) => {
      if (!this.ffmpegProcess) {
        reject(new Error('Not recording'));
        return;
      }

      const filePath = this.outputPath;
      const wallClockDuration = this.duration;

      console.log(`[Recorder] Stopping — wall-clock duration: ${wallClockDuration.toFixed(1)}s`);

      // Send 'q' to gracefully stop ffmpeg.
      // FFmpeg needs time to finalize the container, especially with +faststart
      // which rewrites the moov atom. Give it up to 30 seconds for long recordings.
      this.ffmpegProcess.stdin?.write('q');

      const FINALIZE_TIMEOUT = 30000; // 30 seconds for faststart rewrite
      let resolved = false;
      this.stopTimeouts = [];

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        console.warn(`[Recorder] ffmpeg did not exit within ${FINALIZE_TIMEOUT / 1000}s — sending SIGTERM`);
        if (this.ffmpegProcess) {
          this.ffmpegProcess.kill('SIGTERM');
          // Give SIGTERM 5 more seconds before SIGKILL
          const killTimeout = setTimeout(() => {
            if (this.ffmpegProcess) {
              console.warn('[Recorder] ffmpeg still alive after SIGTERM — SIGKILL');
              this.ffmpegProcess.kill('SIGKILL');
              this.ffmpegProcess = null;
            }
          }, 5000);
          this.stopTimeouts.push(killTimeout);
        }
        resolve({ filePath, duration: wallClockDuration });
      }, FINALIZE_TIMEOUT);
      this.stopTimeouts.push(timeout);

      this.ffmpegProcess.on('exit', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        console.log(`[Recorder] ffmpeg exited (code ${code}) — verifying file...`);
        this.ffmpegProcess = null;
        this.startTime = 0;

        // Verify the output file exists and has content
        try {
          const stat = fs.statSync(filePath);
          const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
          console.log(`[Recorder] Output file: ${filePath} (${sizeMB} MB)`);

          if (stat.size === 0) {
            console.error('[Recorder] Output file is empty — recording may have failed');
          }
        } catch {
          console.error(`[Recorder] Output file not found: ${filePath}`);
        }

        resolve({ filePath, duration: wallClockDuration });
      });
    });
  }

  private buildCaptureArgs(): string[] {
    const micIdx = this.deviceInfo?.micIndex ?? '0';

    if (this.deviceInfo?.hasLoopback && this.deviceInfo.loopbackIndex) {
      console.log(`[Recorder] Using dual capture: mic :${micIdx} + "${this.deviceInfo.loopbackName}" :${this.deviceInfo.loopbackIndex}`);
      return [
        '-f', 'avfoundation',
        '-i', `:${micIdx}`,
        '-f', 'avfoundation',
        '-i', `:${this.deviceInfo.loopbackIndex}`,
        '-filter_complex', 'amix=inputs=2:duration=longest',
        '-ac', '2',
        '-ar', '44100',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-y',
        this.outputPath,
      ];
    }

    console.log(`[Recorder] Using mic-only capture :${micIdx} (no loopback device detected)`);
    return [
      '-f', 'avfoundation',
      '-i', `:${micIdx}`,
      '-ac', '1',
      '-ar', '44100',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      this.outputPath,
    ];
  }
}
