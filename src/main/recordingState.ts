import { EventEmitter } from 'events';

export type RecordingState = 'idle' | 'recording' | 'stopping' | 'uploading' | 'complete';

export interface RecordingStateData {
  state: RecordingState;
  startedAt: number | null;
  duration: number | null;
  error: string | null;
  uploadItemId: string | null;
}

/**
 * Central recording state machine.
 *
 * States: idle → recording → stopping → uploading → complete → idle
 *
 * Emits 'change' with RecordingStateData on every transition.
 */
export class RecordingStateMachine extends EventEmitter {
  private _state: RecordingState = 'idle';
  private _startedAt: number | null = null;
  private _duration: number | null = null;
  private _error: string | null = null;
  private _uploadItemId: string | null = null;
  private _completeTimer: NodeJS.Timeout | null = null;

  get state(): RecordingState {
    return this._state;
  }

  get isRecording(): boolean {
    return this._state === 'recording';
  }

  getData(): RecordingStateData {
    return {
      state: this._state,
      startedAt: this._startedAt,
      duration: this._duration,
      error: this._error,
      uploadItemId: this._uploadItemId,
    };
  }

  transitionTo(state: RecordingState, extra?: Partial<Pick<RecordingStateData, 'duration' | 'error' | 'uploadItemId'>>): void {
    const prev = this._state;

    // Validate transitions
    const valid: Record<RecordingState, RecordingState[]> = {
      idle: ['recording'],
      recording: ['stopping'],
      stopping: ['uploading', 'idle'], // idle if stop fails
      uploading: ['complete', 'idle'], // idle if upload fails
      complete: ['idle'],
    };

    if (!valid[prev].includes(state)) {
      console.warn(`[RecordingState] Invalid transition: ${prev} → ${state}`);
      return;
    }

    this._state = state;
    this._error = extra?.error ?? null;

    switch (state) {
      case 'recording':
        this._startedAt = Date.now();
        this._duration = null;
        this._uploadItemId = null;
        break;
      case 'stopping':
        this._duration = this._startedAt ? (Date.now() - this._startedAt) / 1000 : null;
        break;
      case 'uploading':
        this._uploadItemId = extra?.uploadItemId ?? null;
        break;
      case 'complete':
        this._duration = extra?.duration ?? this._duration;
        // Auto-return to idle after showing completion
        this._completeTimer = setTimeout(() => {
          this.transitionTo('idle');
        }, 4000);
        break;
      case 'idle':
        if (this._completeTimer) {
          clearTimeout(this._completeTimer);
          this._completeTimer = null;
        }
        this._startedAt = null;
        this._duration = null;
        this._uploadItemId = null;
        break;
    }

    console.log(`[RecordingState] ${prev} → ${state}`);
    this.emit('change', this.getData());
  }

  /** Force reset to idle (e.g. on error) */
  reset(): void {
    if (this._completeTimer) {
      clearTimeout(this._completeTimer);
      this._completeTimer = null;
    }
    this._state = 'idle';
    this._startedAt = null;
    this._duration = null;
    this._error = null;
    this._uploadItemId = null;
    this.emit('change', this.getData());
  }
}
