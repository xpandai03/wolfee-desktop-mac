import { EventEmitter } from 'events';
import store, { QueueItem, RecordingMetadata } from '../store';
import { uploadRecording } from './client';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 5000; // 5 seconds

export class UploadQueue extends EventEmitter {
  private processing = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private retryTimers: NodeJS.Timeout[] = [];

  enqueue(filePath: string, metadata: RecordingMetadata): string {
    const queue = store.get('uploadQueue') || [];
    const item: QueueItem = {
      id: uuidv4(),
      filePath,
      metadata,
      retries: 0,
      addedAt: Date.now(),
    };
    queue.push(item);
    store.set('uploadQueue', queue);
    console.log(`[UploadQueue] Enqueued: ${item.id} (${filePath})`);
    this.processNext();
    return item.id;
  }

  start(): void {
    // Process any pending items from previous session
    this.processNext();
    // Check queue periodically
    this.timer = setInterval(() => this.processNext(), 30000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers = [];
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.stopped) return;

    const queue = store.get('uploadQueue') || [];
    if (queue.length === 0) return;

    this.processing = true;
    const item = queue[0];

    // Check if file still exists
    if (!fs.existsSync(item.filePath)) {
      console.log(`[UploadQueue] File missing, removing: ${item.filePath}`);
      this.removeItem(item.id);
      this.processing = false;
      this.processNext();
      return;
    }

    console.log(`[UploadQueue] Uploading: ${item.id} (attempt ${item.retries + 1})`);
    const result = await uploadRecording(item.filePath, item.metadata);

    if (result.success) {
      // Delete local file after successful upload
      try {
        fs.unlinkSync(item.filePath);
      } catch (e) {
        // File may already be deleted
      }
      this.removeItem(item.id);
      console.log(`[UploadQueue] Upload complete: ${item.id}, meetingId=${result.meetingId}`);
      this.emit('uploaded', item.id, item.metadata, result.meetingUrl);
    } else {
      item.retries++;
      if (item.retries >= MAX_RETRIES) {
        console.error(`[UploadQueue] Max retries reached, removing: ${item.id}`);
        this.removeItem(item.id);
      } else {
        this.updateItem(item);
        // Exponential backoff
        const delay = BASE_DELAY_MS * Math.pow(2, item.retries - 1);
        console.log(`[UploadQueue] Retry in ${delay}ms`);
        const retryTimer = setTimeout(() => this.processNext(), delay);
        this.retryTimers.push(retryTimer);
      }
    }

    this.processing = false;
  }

  private removeItem(id: string): void {
    const queue = store.get('uploadQueue') || [];
    store.set('uploadQueue', queue.filter((item) => item.id !== id));
  }

  private updateItem(updated: QueueItem): void {
    const queue = store.get('uploadQueue') || [];
    store.set(
      'uploadQueue',
      queue.map((item) => (item.id === updated.id ? updated : item))
    );
  }
}
