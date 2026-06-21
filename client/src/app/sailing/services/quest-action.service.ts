import { Injectable, inject } from '@angular/core';
import { MultiplayerService } from './multiplayer.service';
import { VesselService } from './vessel.service';
import { SailState } from '../models';

/**
 * Client-side detection for the intro tutorial's ACTION acknowledgements. The trivial `client_ack` objectives
 * that represent a real thing the player must DO — look around (rotate the camera), try the helm (steer to port
 * AND starboard), set the canvas (change sail state) — are completed here by watching the game state, so they
 * can't be skipped by clicking a button. (Pure-narrative acks like "take command" / "read the wind" keep their
 * manual button — see the `manual` flag.) Server-verified objectives (sail/dock/trade/sink) and the tavern
 * rumour are handled elsewhere. Runs on a light interval while the sailing scene is up.
 */
@Injectable({ providedIn: 'root' })
export class QuestActionService {
  private mp     = inject(MultiplayerService);
  private vessel = inject(VesselService);

  private timer: ReturnType<typeof setInterval> | null = null;
  private camBase: { x: number; y: number } | null = null;
  private sailBase: SailState | null = null;
  private turnedL = false;
  private turnedR = false;
  private acked = new Set<string>();

  start(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => this.tick(), 120);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.camBase = null; this.sailBase = null; this.turnedL = this.turnedR = false; this.acked.clear();
  }

  private ack(id: string): void { this.acked.add(id); this.mp.questAck(id); }

  private tick(): void {
    const q = this.mp.quest();
    if (!q) { return; }
    const live = (id: string) => q.objectives.find((o) => o.id === id && !o.done && !this.acked.has(id));

    // Look about the ship — the player has swung the view (camera orbit) past a small threshold (degrees).
    if (live('rotate_cam')) {
      const o = this.vessel.cameraOrbit();
      if (!this.camBase) { this.camBase = { x: o.azimuth, y: o.elevation }; }
      else if (Math.abs(o.azimuth - this.camBase.x) + Math.abs(o.elevation - this.camBase.y) > 12) {
        this.ack('rotate_cam');
      }
    } else { this.camBase = null; }

    // Try the helm — they've turned BOTH to port and to starboard (turn rate crossed in both directions).
    if (live('turn_helm')) {
      const tr = this.vessel.state().turnRate ?? 0;
      if (tr > 1.2) { this.turnedR = true; }
      if (tr < -1.2) { this.turnedL = true; }
      if (this.turnedL && this.turnedR) { this.ack('turn_helm'); }
    } else { this.turnedL = this.turnedR = false; }

    // Set and trim your canvas — the sail state has changed from what it was when the step opened.
    if (live('trim_sails')) {
      const s = this.vessel.state().sailState;
      if (this.sailBase === null) { this.sailBase = s; }
      else if (s !== this.sailBase) { this.ack('trim_sails'); }
    } else { this.sailBase = null; }
  }
}
