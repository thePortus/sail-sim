import { Component, computed, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MultiplayerService } from '../sailing/services/multiplayer.service';

/**
 * Ship-naming modal. Opened from MultiplayerService.shipNameModal (set on tutorial completion, on buying a new
 * hull, or from the Shipwright's "Rename" button). The captain types a name (≤28 chars); confirming sends
 * set_ship_name (server-authoritative — it persists + broadcasts, and the reply closes the modal via
 * ship_name_set). Keeping the current name just dismisses it. The copy adapts to why it opened.
 */
@Component({
  selector: 'app-ship-name-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (mp.shipNameModal(); as m) {
      <div class="sn-backdrop"></div>
      <div class="sn-panel">
        <div class="sn-title">{{ titleFor(m.reason) }}</div>
        <div class="sn-blurb">{{ blurbFor(m.reason) }}</div>

        <input class="sn-input" type="text" maxlength="28" spellcheck="false"
               [ngModel]="name()" (ngModelChange)="name.set($event)"
               (keydown.enter)="confirm()" placeholder="Name your ship…" #box />

        <div class="sn-row">
          <span class="sn-count">{{ name().trim().length }}/28</span>
        </div>

        <div class="sn-actions">
          <button class="sn-btn sn-keep" (click)="keep(m.reason)">{{ keepLabelFor(m.reason) }}</button>
          <button class="sn-btn sn-confirm" [disabled]="!valid()" (click)="confirm()">Christen her</button>
        </div>
      </div>
    }
  `,
  styles: [`
    .sn-backdrop { position: fixed; inset: 0; background: rgba(8, 6, 3, 0.6); z-index: 80; }
    .sn-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 81;
      width: min(420px, 92vw);
      background: linear-gradient(160deg, #2e2013, #15100a);
      border: 1px solid #6e5326; border-radius: 12px; padding: 1.2rem 1.3rem 1.3rem;
      box-shadow: 0 18px 50px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(184,138,62,0.15);
      color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .sn-title { font-size: 1.3rem; font-weight: 600; color: #e8d3a0; }
    .sn-blurb { font-size: 0.86rem; color: #cdbb95; margin: 0.4rem 0 0.9rem; line-height: 1.4; }
    .sn-input {
      width: 100%; box-sizing: border-box; padding: 0.6rem 0.7rem; border-radius: 8px;
      border: 1px solid #6e5326; background: rgba(255,255,255,0.05); color: #fdf3d8;
      font-family: Georgia, 'Times New Roman', serif; font-size: 1.2rem; letter-spacing: 0.02em; text-align: center;
    }
    .sn-input:focus { outline: none; border-color: #c89a4a; box-shadow: 0 0 0 2px rgba(200,154,74,0.25); }
    .sn-row { display: flex; justify-content: flex-end; margin-top: 0.3rem; }
    .sn-count { font-size: 0.72rem; color: #9c8755; font-variant-numeric: tabular-nums; }
    .sn-actions { display: flex; gap: 0.6rem; margin-top: 0.9rem; }
    .sn-btn { flex: 1; padding: 0.55rem; border-radius: 8px; font-family: inherit; font-size: 0.95rem; cursor: pointer; border: 1px solid transparent; }
    .sn-keep { background: #3a2817; border-color: #6e5326; color: #e8d3a0; }
    .sn-keep:hover { background: #4a3420; }
    .sn-confirm { background: linear-gradient(135deg, #c89a4a, #a3792f); color: #2c1d09; font-weight: 600; }
    .sn-confirm:disabled { opacity: 0.35; cursor: not-allowed; }
  `],
})
export class ShipNameModalComponent {
  protected mp = inject(MultiplayerService);
  protected name = signal('');
  protected valid = computed(() => this.name().trim().length > 0);

  constructor() {
    // Seed the input with the current name whenever the modal opens (and refocus is handled by autofocus below).
    effect(() => {
      const m = this.mp.shipNameModal();
      if (m) { this.name.set(m.current || ''); queueMicrotask(() => this.focusBox()); }
    });
  }

  private focusBox(): void {
    const el = document.querySelector('.sn-input') as HTMLInputElement | null;
    if (el) { el.focus(); el.select(); }
  }

  confirm(): void {
    if (!this.valid()) return;
    this.mp.setShipName(this.name().trim());   // server reply (ship_name_set) closes the modal
  }

  /** Keep the current name. On tutorial/buy this still "accepts" the default; from the shipwright it just cancels. */
  keep(_reason: string): void {
    this.mp.shipNameModal.set(null);
  }

  titleFor(reason: string): string {
    return reason === 'tutorial' ? 'Name Your Ship'
         : reason === 'buy'      ? 'Name Your New Ship'
         :                          'Rename Your Ship';
  }
  blurbFor(reason: string): string {
    return reason === 'tutorial'
      ? 'She’s yours now, Captain. Every ship deserves a name — christen her, or sail on as the Saltmeadow.'
      : reason === 'buy'
      ? 'A fresh hull and a clean slate. What shall the signwriter carve on her stern?'
      : 'The signwriter waits with chisel in hand. What name shall she carry?';
  }
  keepLabelFor(reason: string): string {
    return reason === 'rename' ? 'Cancel' : 'Keep current';
  }
}
