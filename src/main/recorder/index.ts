import { AudioRecorder } from './audioRecorder';
import { RecordingMetadata } from '../store';
import { v4 as uuidv4 } from 'uuid';
import store from '../store';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

export class RecorderEngine {
  private audioRecorder: AudioRecorder;
  private _recordingsDir: string;

  constructor() {
    this._recordingsDir = store.get('recordingsDir') ||
      path.join(app.getPath('userData'), 'recordings');
    store.set('recordingsDir', this._recordingsDir);
    this.audioRecorder = new AudioRecorder(this._recordingsDir);
  }

  get isRecording(): boolean {
    return this.audioRecorder.isRecording;
  }

  get hasSystemAudio(): boolean {
    return this.audioRecorder.hasSystemAudio;
  }

  get recordingsDir(): string {
    return this._recordingsDir;
  }

  detectDevices() {
    return this.audioRecorder.detectDevices();
  }

  start(): string {
    console.log('[RecorderEngine] Starting recording...');
    return this.audioRecorder.start();
  }

  async stop(): Promise<{ filePath: string; metadata: RecordingMetadata }> {
    console.log('[RecorderEngine] Stopping recording...');
    const { filePath, duration } = await this.audioRecorder.stop();

    const metadata: RecordingMetadata = {
      userId: store.get('userId') || 'unknown',
      deviceId: store.get('deviceId') || uuidv4(),
      timestamp: new Date().toISOString(),
      duration,
      platformGuess: this.guessPlatform(),
      source: 'desktop_recorder',
    };

    console.log(`[RecorderEngine] Recording saved: ${filePath} (${duration.toFixed(1)}s)`);
    return { filePath, metadata };
  }

  /** Force-kill ffmpeg immediately. Used during app quit. */
  forceKill(): void {
    this.audioRecorder.forceKill();
  }

  /**
   * Find orphaned recordings (from crashes) and return their paths
   */
  findOrphanedRecordings(): string[] {
    const queue = store.get('uploadQueue') || [];
    const queuedPaths = new Set(queue.map((item) => item.filePath));

    try {
      const files = fs.readdirSync(this._recordingsDir);
      return files
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => path.join(this._recordingsDir, f))
        .filter((fullPath) => !queuedPaths.has(fullPath));
    } catch {
      return [];
    }
  }

  private guessPlatform(): string {
    return 'unknown';
  }
}
