import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import store, { RecordingMetadata, getBackendUrl } from '../store';

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

export interface UploadResult {
  success: boolean;
  meetingId?: number;
  meetingUrl?: string;
}

export async function uploadRecording(
  filePath: string,
  metadata: RecordingMetadata
): Promise<UploadResult> {
  const backendUrl = getBackendUrl();
  const authToken = store.get('authToken');

  if (!authToken) {
    console.error('[Uploader] Missing auth token — skipping upload');
    return { success: false };
  }

  if (!fs.existsSync(filePath)) {
    console.error(`[Uploader] File not found: ${filePath}`);
    return { success: false };
  }

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    console.error(`[Uploader] File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`);
    return { success: false };
  }

  if (stat.size === 0) {
    console.error(`[Uploader] Empty recording file: ${filePath}`);
    return { success: false };
  }

  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  console.log(`[Uploader] Uploading: ${filePath} (${sizeMB} MB, duration=${metadata.duration.toFixed(1)}s)`);

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('metadata', JSON.stringify(metadata));

  try {
    const response = await axios.post(
      `${backendUrl}/api/meetings/import/desktop`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${authToken}`,
        },
        maxContentLength: MAX_FILE_SIZE,
        maxBodyLength: MAX_FILE_SIZE,
        timeout: 120000,
      }
    );

    const meetingId = response.data?.id;
    const meetingUrl = meetingId ? `${backendUrl}/meetings/${meetingId}` : undefined;

    console.log(`[Uploader] Upload successful: status=${response.status}, meetingId=${meetingId}, url=${meetingUrl}`);
    return { success: true, meetingId, meetingUrl };
  } catch (error: any) {
    const status = error.response?.status;
    if (status === 401) {
      console.error('[Uploader] Auth token expired or invalid');
    }
    console.error(`[Uploader] Upload failed: ${error.message}`);
    return { success: false };
  }
}
