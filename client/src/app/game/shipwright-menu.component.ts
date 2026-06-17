import { Component, EventEmitter, Input, Output, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { CombatService } from '../sailing/services/combat.service';
import { Settings } from '../app.settings';

interface ShipRow {
  slug: string; name: string; description: string;
  price: number; cargo: number; maxSpeed: number; guns: number;
}

/**
 * Shipwright panel (Ships-as-economy — SH2). Opened from the dock menu's "Shipwright" button. Lists the
 * buyable vessels (name, price, hold, speed, guns) with the owned hull flagged. Buying REPLACES your ship
 * with a 50% trade-in credit toward the new one; the server validates docked + gold + that your cargo fits
 * the new hold (else it rejects). Admins get a free "Commission" action on every hull. All authority is
 * server-side: this reads MultiplayerService signals and sends ship_buy.
 */
@Component({
  selector: 'app-shipwright-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="sw-backdrop" (click)="onClose()"></div>

    <div class="sw-panel" (click)="$event.stopPropagation()">
      <div class="sw-header">
        <div class="sw-title">Shipwright</div>
        <span class="sw-gold">⚜ {{ mp.gold() }} gold</span>
      </div>

      <img src="/images/shipwright.png" alt="A shipwright at work, repairing a ship.">

      @if (admin) { <div class="sw-admin-note">Admin — commission any vessel free of charge.</div> }

      <!-- Hull repair (moved here from the dock menu — the shipwright patches your hull). -->
      <div class="sw-repair">
        <div class="sw-repair-info">
          <span class="sw-repair-title">Hull repair</span>
          @if (damaged()) {
            <span class="sw-repair-sub">Your hull has taken damage — patch her up to full.</span>
          } @else {
            <span class="sw-repair-sub sw-repair-ok">Your hull is sound — no repairs needed.</span>
          }
        </div>
        <button class="sw-buy sw-repair-btn" [disabled]="!damaged()" (click)="repair()">
          {{ damaged() ? 'Repair · ' + repairLabel() : 'In good repair' }}
        </button>
      </div>

      <div class="sw-list">
        @for (s of ships(); track s.slug) {
          <div class="sw-card" [class.sw-card--owned]="owned(s.slug)">
            <div class="sw-card-head">
              <span class="sw-name">{{ s.name }}</span>
              @if (owned(s.slug)) { <span class="sw-badge">Your ship</span> }
            </div>
            <div class="sw-desc">{{ s.description }}</div>
            <div class="sw-stats">
              <span>Hold {{ s.cargo }}</span><span>Speed {{ s.maxSpeed }}</span><span>{{ s.guns }}/side</span>
            </div>
            <div class="sw-actions">
              @if (owned(s.slug)) {
                <span class="sw-current">— current —</span>
              } @else {
                @if (admin) {
                  <button class="sw-buy sw-commission" (click)="buy(s.slug)">Commission (free)</button>
                } @else {
                  <button class="sw-buy" [disabled]="!canBuy(s)" (click)="buy(s.slug)">
                    {{ netCost(s) === 0 ? 'Acquire (free)' : 'Buy · ' + netCost(s) + 'g' }}
                  </button>
                  @if (tradeIn() > 0) { <span class="sw-tradein">trade-in −{{ tradeIn() }}g</span> }
                }
                @if (!admin && !fits(s)) { <span class="sw-warn">hold too small — sell cargo</span> }
              }
            </div>
          </div>
        }
      </div>

      @if (mp.shipError(); as err) { <div class="sw-err">{{ prettyError(err) }}</div> }

      <button class="sw-close" (click)="onClose()">Go Back to Town</button>
    </div>
  `,
  styles: [`
    .sw-backdrop { position: fixed; inset: 0; background: rgba(8, 6, 3, 0.55); z-index: 70; }
    .sw-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
      width: min(460px, 92vw); max-height: 86vh; overflow: hidden auto;
      background: linear-gradient(160deg, #2e2013, #15100a);
      border: 1px solid #6e5326; border-radius: 12px; padding: 1.1rem 1.2rem 1.2rem;
      box-shadow: 0 18px 50px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(184,138,62,0.15);
      color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .sw-header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid rgba(184,138,62,0.3); padding-bottom: 0.5rem; }
    .sw-title { font-size: 1.25rem; font-weight: 600; color: #e8d3a0; }
    .sw-gold { color: #f0c869; font-weight: 600; }
    .sw-admin-note { margin-top: 0.5rem; font-size: 0.78rem; color: #c6a85f; font-style: italic; }
    .sw-repair { display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; margin-top: 0.7rem;
                 padding: 0.6rem 0.7rem; border: 1px solid rgba(184,138,62,0.3); border-radius: 8px; background: rgba(255,255,255,0.03); }
    .sw-repair-info { display: flex; flex-direction: column; gap: 0.15rem; }
    .sw-repair-title { font-size: 1.0rem; color: #f0e3c6; font-weight: 600; }
    .sw-repair-sub { font-size: 0.78rem; color: #cdbb95; }
    .sw-repair-ok { color: #9fc98a; }
    .sw-repair-btn { white-space: nowrap; }
    .sw-list { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.7rem; }
    .sw-card { border: 1px solid rgba(184,138,62,0.3); border-radius: 8px; padding: 0.6rem 0.7rem; background: rgba(255,255,255,0.03); }
    .sw-card--owned { border-color: rgba(240,200,105,0.55); background: rgba(240,200,105,0.07); }
    .sw-card-head { display: flex; align-items: center; gap: 0.5rem; }
    .sw-name { font-size: 1.05rem; color: #f0e3c6; font-weight: 600; }
    .sw-badge { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.04em; color: #2c1d09; background: #f0c869; border-radius: 4px; padding: 0.05rem 0.35rem; }
    .sw-desc { font-size: 0.82rem; color: #cdbb95; margin: 0.25rem 0; }
    .sw-stats { display: flex; gap: 0.9rem; font-size: 0.78rem; color: #b89a62; font-variant-numeric: tabular-nums; }
    .sw-actions { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; }
    .sw-buy { padding: 0.3rem 0.7rem; border-radius: 6px; border: 1px solid transparent; font-family: inherit; font-size: 0.85rem; cursor: pointer;
              background: linear-gradient(135deg, #c89a4a, #a3792f); color: #2c1d09; font-weight: 600; }
    .sw-commission { background: linear-gradient(135deg, #6f8f5a, #4f6b3c); color: #f3f7e8; }
    .sw-buy:disabled { opacity: 0.32; cursor: not-allowed; }
    .sw-tradein { font-size: 0.74rem; color: #9fe0a0; }
    .sw-warn { font-size: 0.74rem; color: #f0a8a0; }
    .sw-current { font-size: 0.8rem; color: #b89a62; font-style: italic; }
    .sw-err { margin-top: 0.6rem; padding: 0.4rem 0.6rem; border-radius: 6px; background: rgba(150,40,30,0.25); border: 1px solid rgba(190,80,60,0.5); color: #f0c0b0; font-size: 0.84rem; }
    .sw-close { margin-top: 0.9rem; width: 100%; padding: 0.55rem; border-radius: 8px; border: 1px solid #6e5326; background: #3a2817; color: #e8d3a0; font-family: inherit; font-size: 0.95rem; cursor: pointer; }
    .sw-close:hover { background: #4a3420; }
  `],
})
export class ShipwrightMenuComponent implements OnInit {
  @Input() admin = false;
  @Output() close = new EventEmitter<void>();
  protected mp = inject(MultiplayerService);
  private combat = inject(CombatService);
  private http = inject(HttpClient);

  protected ships = signal<ShipRow[]>([]);
  protected readonly repairFee = 40;   // matches server REPAIR_FEE (and the old dock-menu button)

  /** True when any hull zone is below its max — i.e. there's something to repair. */
  protected damaged = computed(() => {
    const z = this.combat.zones();
    if (!z) { return false; }                       // null = full health
    const m = this.combat.maxHp();
    return (Object.keys(m) as (keyof typeof m)[]).some((k) => (z[k] ?? m[k]) < m[k]);
  });
  /** Repair price label — free for admins, or if you can't even afford the fee (so you're never stuck broke + holed). */
  protected repairLabel = computed(() => (this.admin || this.mp.gold() < this.repairFee) ? 'free' : this.repairFee + 'g');

  async ngOnInit(): Promise<void> {
    this.mp.shipError.set(null);
    try {
      this.ships.set(await firstValueFrom(this.http.get<ShipRow[]>(`${Settings.apiUrl}vessels`)));
    } catch { /* leave empty — the panel just shows nothing buyable */ }
  }

  owned(slug: string): boolean { return this.mp.ownedShip() === slug; }
  /** 50% of the currently-owned hull's price (the trade-in credit toward any purchase). */
  protected tradeIn = computed(() => {
    const o = this.ships().find((s) => s.slug === this.mp.ownedShip());
    return Math.floor((o?.price ?? 0) * 0.5);
  });
  netCost(s: ShipRow): number { return Math.max(0, s.price - this.tradeIn()); }
  /** Cargo currently held (slot count) — server re-validates by true volume. */
  private used(): number { return Object.values(this.mp.cargo()).reduce((a, b) => a + (b || 0), 0); }
  fits(s: ShipRow): boolean { return this.used() <= s.cargo; }
  canBuy(s: ShipRow): boolean { return !this.owned(s.slug) && this.fits(s) && this.mp.gold() >= this.netCost(s); }

  buy(slug: string): void { this.mp.buyShip(slug); }

  /** Repair the hull to full in place (server-authoritative; the updated combat_state disables the button). */
  repair(): void { this.mp.requestCombatReset(); }

  prettyError(reason: string): string {
    const map: Record<string, string> = {
      not_docked: 'You must be docked at a port.', no_gold: 'Not enough gold.',
      hold_too_small: 'Your cargo won\'t fit that hold — sell some goods first.',
      already_owned: 'You already sail that ship.', bad_ship: 'No such vessel.',
    };
    return map[reason] ?? `Purchase failed (${reason}).`;
  }

  onClose(): void { this.mp.shipError.set(null); this.close.emit(); }
}
