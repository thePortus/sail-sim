import { Injectable, signal } from '@angular/core';

/**
 * Tiny leaf service for debug telemetry shared across the app without creating
 * dependency cycles. MultiplayerService writes the WS round-trip ping; the
 * SceneService FPS overlay (backtick) reads it.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryService {
  /** Last measured WS round-trip time in ms (−1 = unknown / offline). */
  readonly ping = signal(-1);
}
