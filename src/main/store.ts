import Store from 'electron-store';
import { app } from 'electron';

const PROD_BACKEND = 'https://wolfee.io';
const DEV_BACKEND = 'http://localhost:3000';

interface StoreSchema {
  userId: string;
  deviceId: string;
  backendUrl: string;
  authToken: string;
  uploadQueue: QueueItem[];
  recordingsDir: string;
  hasShownBlackHoleNotice: boolean;
}

export interface QueueItem {
  id: string;
  filePath: string;
  metadata: RecordingMetadata;
  retries: number;
  addedAt: number;
}

export interface RecordingMetadata {
  userId: string;
  deviceId: string;
  timestamp: string;
  duration: number;
  platformGuess: string;
  source: string;
}

const store = new Store<StoreSchema>({
  defaults: {
    userId: '',
    deviceId: '',
    backendUrl: '',
    authToken: '',
    uploadQueue: [],
    recordingsDir: '',
    hasShownBlackHoleNotice: false,
  },
});

/**
 * Resolve backend URL with priority:
 *   1. WOLFEE_BACKEND_URL env var
 *   2. Production default (app.isPackaged) or dev default
 *
 * We intentionally do NOT read backendUrl from the store.
 * Previous builds persisted 'http://localhost:3000' as the default,
 * which poisons packaged production builds with ECONNREFUSED.
 */
export function getBackendUrl(): string {
  const fromEnv = process.env.WOLFEE_BACKEND_URL;
  if (fromEnv) return fromEnv;

  return app.isPackaged ? PROD_BACKEND : DEV_BACKEND;
}

export default store;
