import { Component, Output, EventEmitter, computed, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MultiplayerService } from '../sailing/services/multiplayer.service';

/**
 * Trader panel (Town Economy — Phase 1). Opened from the dock menu's "Trade" button. Renders the town's
 * server-quoted market (ask = you buy, bid = you sell), the player's purse + cargo hold, and a shared
 * quantity stepper driving per-good Buy/Sell. All state is server-authoritative: this reads the
 * MultiplayerService signals (market/gold/cargo/capacity) and sends trade_buy/trade_sell — the server
 * validates (docked, gold, capacity, held) and pushes back the corrected wallet + market.
 */
@Component({
  selector: 'app-trader-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="tr-backdrop" (click)="onClose()"></div>

    <div class="tr-panel" (click)="$event.stopPropagation()">
      <div class="tr-header">
        <div class="tr-title">{{ mp.market()?.name || 'Trader' }}</div>
        <div class="tr-specialty">{{ specialtyLabel() }}</div>
      </div>

      <div class="tr-purse">
        <span class="tr-gold">⚜ {{ mp.gold() }} gold</span>
        <span class="tr-hold">
          Hold {{ used() }}/{{ mp.capacity() }}
          <span class="tr-bar"><span class="tr-bar-fill" [style.width.%]="holdPct()"></span></span>
        </span>
      </div>

      <div class="tr-qty">
        <span>Quantity</span>
        <button class="tr-step" (click)="bump(-1)">−</button>
        <span class="tr-qval">{{ qty() }}</span>
        <button class="tr-step" (click)="bump(1)">+</button>
      </div>

      @if (mp.market(); as m) {
        <div class="tr-table">
          <div class="tr-row tr-row--head">
            <span class="tr-good">Good</span>
            <span class="tr-num">Buy</span>
            <span class="tr-num">Sell</span>
            <span class="tr-num">Held</span>
            <span class="tr-acts"></span>
          </div>
          @for (g of m.goods; track g.goodId) {
            <div class="tr-row">
              <span class="tr-good">{{ g.name }}
                @if (scarcity(g.level); as sc) { <span class="tr-tag" [class]="'tr-tag--' + sc.cls">{{ sc.label }}</span> }
              </span>
              <span class="tr-num">{{ g.ask }}</span>
              <span class="tr-num">{{ g.bid }}</span>
              <span class="tr-num" [class.tr-have]="held(g.goodId) > 0">{{ held(g.goodId) }}</span>
              <span class="tr-acts">
                <button class="tr-buy"  [disabled]="!canBuy(g.ask)"        (click)="buy(g.goodId)">Buy</button>
                <button class="tr-sell" [disabled]="held(g.goodId) < qty()" (click)="sell(g.goodId)">Sell</button>
              </span>
            </div>
          }
        </div>
      } @else {
        <div class="tr-loading">Hailing the harbourmaster…</div>
      }

      @if (mp.tradeError(); as err) {
        <div class="tr-err">{{ prettyError(err) }}</div>
      }

      <button class="tr-close" (click)="onClose()">Cast Off</button>
    </div>
  `,
  styles: [`
    .tr-backdrop { position: fixed; inset: 0; background: rgba(8, 6, 3, 0.55); z-index: 70; }
    .tr-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
      width: min(440px, 92vw); max-height: 86vh; overflow: hidden auto;
      background: linear-gradient(160deg, #2e2013, #15100a);
      border: 1px solid #6e5326; border-radius: 12px; padding: 1.1rem 1.2rem 1.2rem;
      box-shadow: 0 18px 50px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(184,138,62,0.15);
      color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .tr-header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; border-bottom: 1px solid rgba(184,138,62,0.3); padding-bottom: 0.5rem; }
    .tr-title { font-size: 1.25rem; font-weight: 600; color: #e8d3a0; }
    .tr-specialty { font-size: 0.82rem; color: #b89a62; text-transform: capitalize; letter-spacing: 0.02em; }
    .tr-purse { display: flex; align-items: center; justify-content: space-between; margin: 0.7rem 0 0.4rem; font-size: 0.92rem; }
    .tr-gold { color: #f0c869; font-weight: 600; }
    .tr-hold { display: flex; align-items: center; gap: 0.45rem; color: #cdbb95; }
    .tr-bar { display: inline-block; width: 70px; height: 7px; background: rgba(0,0,0,0.4); border-radius: 4px; overflow: hidden; border: 1px solid rgba(184,138,62,0.3); }
    .tr-bar-fill { display: block; height: 100%; background: linear-gradient(90deg, #c89a4a, #a3792f); }
    .tr-qty { display: flex; align-items: center; gap: 0.6rem; margin: 0.5rem 0 0.7rem; font-size: 0.9rem; color: #cdbb95; }
    .tr-step { width: 26px; height: 26px; border-radius: 6px; border: 1px solid #6e5326; background: #3a2817; color: #f0e3c6; font-size: 1.1rem; cursor: pointer; line-height: 1; }
    .tr-step:hover { background: #4a3420; }
    .tr-qval { min-width: 1.6rem; text-align: center; font-weight: 600; color: #e8d3a0; }
    .tr-table { display: flex; flex-direction: column; gap: 2px; }
    .tr-row { display: grid; grid-template-columns: 1.5fr 0.7fr 0.7fr 0.7fr 1.5fr; align-items: center; gap: 0.3rem; padding: 0.3rem 0.2rem; border-radius: 5px; font-size: 0.9rem; }
    .tr-row:not(.tr-row--head):nth-child(odd) { background: rgba(255,255,255,0.03); }
    .tr-row--head { font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.05em; color: #b89a62; border-bottom: 1px solid rgba(184,138,62,0.2); }
    .tr-good { color: #f0e3c6; }
    .tr-tag { display: inline-block; margin-left: 0.35rem; padding: 0.02rem 0.32rem; border-radius: 4px; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.03em; vertical-align: middle; }
    .tr-tag--scarce { background: rgba(190,80,60,0.28); color: #f0b8a8; }
    .tr-tag--abundant { background: rgba(110,150,90,0.28); color: #c6e0b0; }
    .tr-num { text-align: right; color: #cdbb95; font-variant-numeric: tabular-nums; }
    .tr-have { color: #f0c869; font-weight: 600; }
    .tr-acts { display: flex; gap: 0.3rem; justify-content: flex-end; }
    .tr-buy, .tr-sell { padding: 0.2rem 0.55rem; border-radius: 5px; font-size: 0.8rem; cursor: pointer; border: 1px solid transparent; font-family: inherit; }
    .tr-buy { background: linear-gradient(135deg, #6f8f5a, #4f6b3c); color: #f3f7e8; }
    .tr-sell { background: linear-gradient(135deg, #c89a4a, #a3792f); color: #2c1d09; }
    .tr-buy:disabled, .tr-sell:disabled { opacity: 0.32; cursor: not-allowed; }
    .tr-loading { padding: 1.5rem 0; text-align: center; color: #b89a62; font-style: italic; }
    .tr-err { margin-top: 0.6rem; padding: 0.4rem 0.6rem; border-radius: 6px; background: rgba(150,40,30,0.25); border: 1px solid rgba(190,80,60,0.5); color: #f0c0b0; font-size: 0.84rem; }
    .tr-close { margin-top: 0.9rem; width: 100%; padding: 0.55rem; border-radius: 8px; border: 1px solid #6e5326; background: #3a2817; color: #e8d3a0; font-family: inherit; font-size: 0.95rem; cursor: pointer; }
    .tr-close:hover { background: #4a3420; }
  `],
})
export class TraderMenuComponent {
  @Output() close = new EventEmitter<void>();
  protected mp = inject(MultiplayerService);

  protected qty = signal<number>(1);

  /** Slots currently used in the hold (Phase 1: 1 slot per unit). */
  protected used = computed(() => Object.values(this.mp.cargo()).reduce((a, b) => a + (b || 0), 0));
  protected holdPct = computed(() => {
    const cap = this.mp.capacity();
    return cap > 0 ? Math.min(100, (this.used() / cap) * 100) : 0;
  });
  protected specialtyLabel = computed(() => {
    const s = this.mp.market()?.specialty ?? '';
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  });

  held(goodId: string): number { return this.mp.cargo()[goodId] ?? 0; }
  canBuy(ask: number): boolean { return this.mp.gold() >= ask * this.qty() && this.used() + this.qty() <= this.mp.capacity(); }

  bump(d: number): void { this.qty.set(Math.max(1, Math.min(99, this.qty() + d))); }

  buy(goodId: string): void {
    const m = this.mp.market(); if (!m) return;
    this.mp.tradeError.set(null);
    this.mp.tradeBuy(m.townId, goodId, this.qty());
  }
  sell(goodId: string): void {
    const m = this.mp.market(); if (!m) return;
    this.mp.tradeError.set(null);
    this.mp.tradeSell(m.townId, goodId, this.qty());
  }

  /** Scarcity badge from the server's `level` (stock/priceRef). Scarce → dear, Abundant → cheap. */
  scarcity(level?: number): { label: string; cls: string } | null {
    if (level == null) return null;
    if (level < 0.7) return { label: 'Scarce', cls: 'scarce' };
    if (level > 1.6) return { label: 'Abundant', cls: 'abundant' };
    return null;
  }

  prettyError(reason: string): string {
    const map: Record<string, string> = {
      no_gold: 'Not enough gold.', no_space: 'Hold is full.', no_goods: "You don't have that to sell.",
      not_docked: 'You must be docked here.', bad_qty: 'Invalid quantity.', bad_good: 'Unknown good.',
      no_town: 'No market here.', town_out: 'Sold out here.', town_broke: "The town can't afford that right now.",
    };
    return map[reason] ?? `Trade failed (${reason}).`;
  }

  onClose(): void { this.mp.closeTrade(); this.mp.tradeError.set(null); this.close.emit(); }
}
