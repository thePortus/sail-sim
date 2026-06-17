import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { SquadronState, SquadronInvite } from '../models';

/**
 * Client-side squadron state (Phase B). Holds the two signals the UI reads — the current roster and any
 * pending invite — fed by MultiplayerService from the server's `squadron_state` / `squadron_invited` messages.
 * Session-only, matching the server: nothing is persisted. Sending (invite / accept / decline / leave) lives
 * on MultiplayerService where the websocket is; this service is pure UI state to avoid a circular dependency.
 */
@Injectable({ providedIn: 'root' })
export class SquadronService {
  private zone = inject(NgZone);

  /** The player's current squadron, or null when not in one. */
  readonly roster = signal<SquadronState | null>(null);
  /** A pending invite awaiting the player's accept/decline, or null. */
  readonly invite = signal<SquadronInvite | null>(null);

  /** True while the player belongs to a squadron (drives the chat tab + roster panel). */
  readonly inSquadron = computed(() => this.roster() !== null);

  /** Apply a server `squadron_state` (null clears the roster on leave/disband). Re-enters the zone so the UI updates. */
  setRoster(state: SquadronState | null): void {
    this.zone.run(() => this.roster.set(state));
  }

  /** Show (or clear) a pending invite prompt. */
  setInvite(invite: SquadronInvite | null): void {
    this.zone.run(() => this.invite.set(invite));
  }

  /** Dismiss the invite prompt (after the player accepts/declines, or it's superseded). */
  clearInvite(): void { this.setInvite(null); }
}
