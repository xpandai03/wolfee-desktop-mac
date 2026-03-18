import { execSync } from 'child_process';
import { app } from 'electron';
import path from 'path';

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

// Virtual audio loopback device names to detect
const LOOPBACK_KEYWORDS = [
  'blackhole',
  'loomaudiodevice',
  'soundflower',
  'loopback',
  'virtual',
  'multi-output',
];

export interface AudioDeviceInfo {
  hasLoopback: boolean;
  loopbackIndex: string | null;
  loopbackName: string | null;
  micIndex: string;
  micName: string | null;
  devices: string[];
}

export function detectAudioDevices(): AudioDeviceInfo {
  const ffmpeg = getFfmpegPath();
  const result: AudioDeviceInfo = {
    hasLoopback: false,
    loopbackIndex: null,
    loopbackName: null,
    micIndex: '0',
    micName: null,
    devices: [],
  };

  try {
    execSync(`"${ffmpeg}" -f avfoundation -list_devices true -i "" 2>&1`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch (err: any) {
    const output: string = err.stdout || err.stderr || err.message || '';
    const lines = output.split('\n');

    let inAudioSection = false;

    for (const line of lines) {
      if (line.includes('AVFoundation audio devices:')) {
        inAudioSection = true;
        continue;
      }

      if (!inAudioSection) continue;

      const deviceMatch = line.match(/\[(\d+)\]\s+(.+)/);
      if (deviceMatch) {
        const index = deviceMatch[1];
        const name = deviceMatch[2].trim();
        result.devices.push(`[${index}] ${name}`);

        // Detect any loopback/virtual audio device
        const nameLower = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
        let isLoopback = false;
        for (const keyword of LOOPBACK_KEYWORDS) {
          if (nameLower.includes(keyword)) {
            // Prefer BlackHole specifically over generic virtual devices
            if (!result.hasLoopback || keyword === 'blackhole') {
              result.hasLoopback = true;
              result.loopbackIndex = index;
              result.loopbackName = name;
            }
            isLoopback = true;
            console.log(`[AudioDevices] Found loopback device: "${name}" at index ${index}`);
            break;
          }
        }

        // Track mic — prefer device with "microphone" in name
        if (!isLoopback && nameLower.includes('microphone')) {
          result.micIndex = index;
          result.micName = name;
        }
      }
    }
  }

  console.log('[AudioDevices] ── Detection Results ──');
  console.log(`[AudioDevices]   Devices: ${result.devices.join(', ') || '(none)'}`);
  console.log(`[AudioDevices]   Mic: "${result.micName || 'default'}" (index ${result.micIndex})`);
  console.log(`[AudioDevices]   Loopback: ${result.hasLoopback ? `"${result.loopbackName}" (index ${result.loopbackIndex})` : 'NOT FOUND'}`);

  return result;
}

/**
 * Validate that a recording file has audio content.
 * Returns stream info for diagnostics.
 */
export function analyzeRecording(filePath: string): { duration: number; hasAudio: boolean; channels: number } {
  const ffmpeg = getFfmpegPath();
  // Use ffprobe-like approach via ffmpeg
  try {
    // Get duration and audio info
    const output = execSync(
      `"${ffmpeg}" -i "${filePath}" -hide_banner 2>&1 || true`,
      { encoding: 'utf-8', timeout: 10000 }
    );

    const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    const audioMatch = output.match(/Audio:\s*(\w+).*?(\d+)\s*Hz.*?(\w+)/);

    const duration = durationMatch
      ? parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3])
      : 0;

    const hasAudio = !!audioMatch;
    const channelStr = audioMatch?.[3] || '';
    const channels = channelStr === 'stereo' ? 2 : channelStr === 'mono' ? 1 : 0;

    console.log(`[AudioDevices] Recording analysis: duration=${duration.toFixed(1)}s, hasAudio=${hasAudio}, channels=${channels}`);
    return { duration, hasAudio, channels };
  } catch (err: any) {
    console.error(`[AudioDevices] Failed to analyze recording: ${err.message}`);
    return { duration: 0, hasAudio: false, channels: 0 };
  }
}
