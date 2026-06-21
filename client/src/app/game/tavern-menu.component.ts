import { Component, EventEmitter, Output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { CombatService } from '../sailing/services/combat.service';

/**
 * Tavern panel (Crew C4). Opened from the dock menu's "Tavern" button. Hires sailors one at a time for
 * RECRUIT_COST gold; if you can't afford it you can still take hands on commission (free) up to ~60% of the
 * complement, so a broke captain can always re-crew enough to fight. All authority is server-side — this reads
 * the crew count (CombatService) + purse (MultiplayerService) and sends recruit_crew; the server replies with
 * fresh crew_state + wallet, and any rejection via recruit_result (surfaced as recruitError).
 */
@Component({
  selector: 'app-tavern-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="tv-backdrop" (click)="onClose()"></div>

    <div class="tv-panel" (click)="$event.stopPropagation()">
      <div class="tv-header">
        <div class="tv-title">Tavern</div>
        <span class="tv-gold">⚜ {{ mp.gold() }} gold</span>
      </div>

      <img src="/images/tavern.png" alt="A crowded tavern with sailors and merchants.">

      <div class="tv-flavour">Hands lost to grapeshot can be replaced here — a coin in the right palm finds willing sailors.</div>

      <div class="tv-crew">
        <span class="tv-crew-label">Crew</span>
        <span class="tv-crew-count" [class.tv-low]="crew() < maxCrew()">{{ crew() }} / {{ maxCrew() }}</span>
      </div>

      <div class="tv-actions">
        @if (crew() >= maxCrew()) {
          <button class="tv-hire" disabled>Crew is full</button>
        } @else if (canPay()) {
          <button class="tv-hire" (click)="hire()">Hire a sailor · {{ cost }}g</button>
        } @else if (freeAvailable()) {
          <button class="tv-hire tv-free" (click)="hire()">Take on a hand (free, on commission)</button>
        } @else {
          <button class="tv-hire" disabled>Need {{ cost }}g to hire more</button>
        }
      </div>

      @if (freeAvailable() && !canPay()) {
        <div class="tv-note">Broke — willing hands sign on for free up to {{ freeFloor() }} of {{ maxCrew() }}.</div>
      }
      @if (mp.recruitError(); as err) { <div class="tv-err">{{ prettyError(err) }}</div> }

      <div class="tv-rumour">
        <button class="tv-listen" (click)="listen()">👂 Listen for rumours</button>
        @if (mp.rumorText(); as line) { <div class="tv-rumour-line">“{{ line }}”</div> }
        @if (mp.rumorError(); as err)  { <div class="tv-note tv-rumour-none">{{ prettyRumor(err) }}</div> }
      </div>

      <div class="tv-pirate">
        <button class="tv-pirate-btn" (click)="askPirates()">☠ Ask about pirate activity</button>
        @if (mp.pirateReport(); as rep) {
          <div class="tv-pirate-report">
            <div class="tv-pirate-line">“{{ pirateFlavour(rep) }}”</div>
            <div class="tv-pirate-stats">
              <span>Vessel: <b>{{ vesselName(rep.slug) }}</b></span>
              <span>Sunk: <b>{{ rep.kills }}</b></span>
              <span>Bounty: <b class="tv-bounty">{{ rep.bounty }}g</b></span>
              @if (rep.plunder > 0) { <span>Plunder: <b class="tv-bounty">{{ rep.plunder }}g</b></span> }
            </div>
            <div class="tv-pirate-mark">Marked in red on your map.</div>
          </div>
        }
        @if (mp.pirateReportError(); as err) { <div class="tv-note tv-rumour-none">{{ prettyPirate(err) }}</div> }
      </div>

      <button class="tv-close" (click)="onClose()">Go Back to Town</button>
    </div>
  `,
  styles: [`
    .tv-backdrop { position: fixed; inset: 0; background: rgba(8, 6, 3, 0.55); z-index: 70; }
    .tv-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
      width: min(380px, 92vw); max-height: 86vh; overflow: hidden auto;
      background: linear-gradient(160deg, #2e2013, #15100a);
      border: 1px solid #6e5326; border-radius: 12px; padding: 1.1rem 1.2rem 1.2rem;
      box-shadow: 0 18px 50px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(184,138,62,0.15);
      color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .tv-header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid rgba(184,138,62,0.3); padding-bottom: 0.5rem; }
    .tv-title { font-size: 1.25rem; font-weight: 600; color: #e8d3a0; }
    .tv-gold { color: #f0c869; font-weight: 600; }
    .tv-flavour { margin-top: 0.6rem; font-size: 0.82rem; color: #cdbb95; font-style: italic; }
    .tv-crew { display: flex; align-items: baseline; justify-content: space-between; margin-top: 0.9rem; }
    .tv-crew-label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: #b89a62; }
    .tv-crew-count { font-size: 1.6rem; font-weight: 700; color: #9fe0a0; font-variant-numeric: tabular-nums; }
    .tv-crew-count.tv-low { color: #f0c869; }
    .tv-actions { margin-top: 0.9rem; }
    .tv-hire { width: 100%; padding: 0.5rem 0.7rem; border-radius: 8px; border: 1px solid transparent; font-family: inherit; font-size: 0.92rem; cursor: pointer;
               background: linear-gradient(135deg, #c89a4a, #a3792f); color: #2c1d09; font-weight: 600; }
    .tv-free { background: linear-gradient(135deg, #6f8f5a, #4f6b3c); color: #f3f7e8; }
    .tv-hire:disabled { opacity: 0.32; cursor: not-allowed; }
    .tv-note { margin-top: 0.55rem; font-size: 0.76rem; color: #9fe0a0; }
    .tv-rumour { margin-top: 0.9rem; padding-top: 0.8rem; border-top: 1px solid rgba(184,138,62,0.25); }
    .tv-listen { width: 100%; padding: 0.5rem 0.7rem; border-radius: 8px; border: 1px solid #5a4a6e; cursor: pointer;
                 background: linear-gradient(135deg, #4b3d63, #322a47); color: #e6dcf2; font-family: inherit; font-size: 0.92rem; }
    .tv-listen:hover { background: linear-gradient(135deg, #574773, #3a3052); }
    .tv-rumour-line { margin-top: 0.55rem; font-size: 0.85rem; font-style: italic; line-height: 1.4; color: #e8d9b6; }
    .tv-rumour-none { color: #cdbb95; }
    .tv-pirate { margin-top: 0.9rem; padding-top: 0.8rem; border-top: 1px solid rgba(184,138,62,0.25); }
    .tv-pirate-btn { width: 100%; padding: 0.5rem 0.7rem; border-radius: 8px; border: 1px solid #6e3030; cursor: pointer;
                     background: linear-gradient(135deg, #5a2727, #3a1a1a); color: #f3d9d9; font-family: inherit; font-size: 0.92rem; }
    .tv-pirate-btn:hover { background: linear-gradient(135deg, #6b2f2f, #45201f); }
    .tv-pirate-report { margin-top: 0.55rem; }
    .tv-pirate-line { font-size: 0.85rem; font-style: italic; line-height: 1.4; color: #ecc9b6; }
    .tv-pirate-stats { display: flex; flex-wrap: wrap; gap: 0.3rem 1rem; margin-top: 0.5rem; font-size: 0.82rem; color: #cdbb95; }
    .tv-pirate-stats b { color: #e8d3a0; }
    .tv-pirate-stats .tv-bounty { color: #f0c869; }
    .tv-pirate-mark { margin-top: 0.4rem; font-size: 0.74rem; color: #d98a8a; }
    .tv-err { margin-top: 0.6rem; padding: 0.4rem 0.6rem; border-radius: 6px; background: rgba(150,40,30,0.25); border: 1px solid rgba(190,80,60,0.5); color: #f0c0b0; font-size: 0.84rem; }
    .tv-close { margin-top: 0.9rem; width: 100%; padding: 0.55rem; border-radius: 8px; border: 1px solid #6e5326; background: #3a2817; color: #e8d3a0; font-family: inherit; font-size: 0.95rem; cursor: pointer; }
    .tv-close:hover { background: #4a3420; }
  `],
})
export class TavernMenuComponent {
  @Output() close = new EventEmitter<void>();
  protected mp     = inject(MultiplayerService);
  private   combat = inject(CombatService);

  /** Gold per sailor — mirrors server RECRUIT_COST (server is authoritative). */
  protected readonly cost = 50;

  protected crew    = this.combat.crew;
  protected maxCrew = this.combat.maxCrew;
  /** ≥60% of the complement is hireable free when broke (mirrors the server's ceil(0.6·max) floor). */
  protected freeFloor   = computed(() => Math.ceil(0.6 * this.maxCrew()));
  protected canPay      = computed(() => this.mp.gold() >= this.cost);
  protected freeAvailable = computed(() => this.crew() < this.freeFloor());

  hire(): void { this.mp.recruitCrew(); }
  listen(): void { this.mp.listenRumor(); }
  askPirates(): void { this.mp.askPirateActivity(); }

  /** Pretty vessel name for the pirate report (mirrors the rumour vessel mapping). */
  vesselName(slug: string): string {
    return ({ sloop: 'sloop', pinnace: 'pinnace', brig: 'brigantine' } as Record<string, string>)[slug] ?? (slug || 'ship');
  }

  /** A bit of tavern colour for the pirate report. */
  pirateFlavour(rep: { name: string; slug: string; kills: number; bounty: number }): string {
    const ship = this.vesselName(rep.slug);
    if (rep.kills <= 0) return `${rep.name} has been seen prowling these waters in a ${ship} — no blood spilt yet, but mark my words.`;
    if (rep.kills >= 4) return `${rep.name}! That ${ship} has sent ${rep.kills} good ships to the bottom — the powers want ${rep.name} dead, and will pay for it.`;
    return `Aye, ${rep.name} works a ${ship} hereabouts — ${rep.kills} ${rep.kills === 1 ? 'ship' : 'ships'} taken already.`;
  }

  prettyError(reason: string): string {
    const map: Record<string, string> = {
      not_docked: 'You must be docked at a port.',
      no_gold: 'Not enough gold — and your free berths are full.',
      full: 'Your crew is already at full strength.',
    };
    return map[reason] ?? `Could not hire (${reason}).`;
  }

  prettyRumor(reason: string): string {
    const map: Record<string, string> = {
      not_docked: 'You must be docked at a port.',
      no_rumours: 'No fresh gossip tonight — no treasure ships abroad nearby.',
    };
    return map[reason] ?? `No rumours (${reason}).`;
  }

  prettyPirate(reason: string): string {
    const map: Record<string, string> = {
      not_docked: 'You must be docked at a port.',
      no_pirates: 'No pirates abroad that anyone here knows of — quiet seas, for now.',
    };
    return map[reason] ?? `No pirate news (${reason}).`;
  }

  onClose(): void {
    this.mp.recruitError.set(null);
    this.mp.rumorError.set(null);
    this.mp.rumorText.set(null);   // clear the flavour line; the map mark persists
    this.mp.pirateReportError.set(null);
    this.mp.pirateReport.set(null);   // clear the report text; the red map mark persists
    this.close.emit();
  }
}
