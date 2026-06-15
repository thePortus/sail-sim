import { Component, EventEmitter, Output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { FACTIONS } from '../sailing/faction.config';

/**
 * Diplomacy panel (Diplomacy module D4): the full inter-faction political map — each nation's WARS and ALLIANCES
 * plus YOUR standing with it — so a captain can predict who'll cheer or curse an attack on a given nation's
 * shipping. Reads the live `factionMatrix` (pushed on connect + on each rare shift) and `factionRep` signals.
 */
@Component({
  selector: 'app-diplomacy-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="dp-backdrop" (click)="close.emit()"></div>
    <div class="dp-panel" (click)="$event.stopPropagation()">
      <div class="dp-header">
        <span class="dp-title">⚔ Diplomacy</span>
        <button class="dp-close" (click)="close.emit()" title="Close">✕</button>
      </div>
      <div class="dp-hint">
        Attack a nation's shipping and its <b>enemies</b> warm to you while its <b>allies</b> turn cold — far more so for a sinking.
      </div>
      <div class="dp-list">
        @for (n of nations(); track n.id) {
          <div class="dp-nation">
            <div class="dp-nrow">
              <span class="dp-swatch" [style.background]="n.color"></span>
              <span class="dp-name">{{ n.name }}</span>
              <span class="dp-standing" [class.pos]="n.standing > 0" [class.neg]="n.standing < 0">{{ n.standingLabel }}</span>
            </div>
            <div class="dp-rels">
              @if (n.enemies.length) {
                <span class="dp-rel">⚔ War:
                  @for (e of n.enemies; track e.id) { <span class="dp-chip" [style.color]="e.color">{{ e.name }}</span> }
                </span>
              }
              @if (n.allies.length) {
                <span class="dp-rel">⚜ Allied:
                  @for (a of n.allies; track a.id) { <span class="dp-chip" [style.color]="a.color">{{ a.name }}</span> }
                </span>
              }
              @if (!n.enemies.length && !n.allies.length) {
                <span class="dp-rel dp-peace">· at peace with all</span>
              }
            </div>
          </div>
        }
      </div>
      <div class="dp-foot">Relations shift rarely — watch the chat for declarations of war and peace.</div>
    </div>
  `,
  styles: [`
    .dp-backdrop { position: fixed; inset: 0; background: rgba(8, 6, 3, 0.55); z-index: 70; }
    .dp-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
      width: min(460px, 92vw); max-height: 86vh; overflow: hidden auto;
      background: linear-gradient(160deg, #2e2013, #15100a);
      border: 1px solid #6e5326; border-radius: 12px; padding: 1.1rem 1.2rem 1.2rem;
      box-shadow: 0 18px 50px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(184,138,62,0.15);
      color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .dp-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
    .dp-title { font-size: 1.15rem; font-weight: 600; letter-spacing: 0.02em; }
    .dp-close { background: none; border: none; color: #b9a06a; font-size: 1.1rem; cursor: pointer; line-height: 1; padding: 2px 6px; }
    .dp-close:hover { color: #f0e3c6; }
    .dp-hint { font-size: 0.78rem; color: #b8a578; margin-bottom: 0.85rem; line-height: 1.35; }
    .dp-hint b { color: #e7d6ab; }
    .dp-list { display: flex; flex-direction: column; gap: 0.55rem; }
    .dp-nation { padding: 0.55rem 0.6rem; border-radius: 7px; background: rgba(255,255,255,0.035); border: 1px solid rgba(184,138,62,0.18); }
    .dp-nrow { display: flex; align-items: center; gap: 0.5rem; }
    .dp-swatch { width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.45); flex: none; }
    .dp-name { flex: 1; font-weight: 600; }
    .dp-standing { font-variant-numeric: tabular-nums; color: #cdbb95; font-size: 0.85rem; }
    .dp-standing.pos { color: #9fe0a0; }
    .dp-standing.neg { color: #f0a8a0; }
    .dp-rels { margin-top: 0.32rem; display: flex; flex-direction: column; gap: 2px; font-size: 0.8rem; }
    .dp-rel { color: #c9b88a; }
    .dp-rel.dp-peace { color: #8a7d5e; font-style: italic; }
    .dp-chip { font-weight: 600; margin-left: 0.3rem; }
    .dp-foot { margin-top: 0.9rem; padding-top: 0.6rem; border-top: 1px solid rgba(184,138,62,0.25); font-size: 0.72rem; color: #8a7d5e; text-align: center; }
  `],
})
export class DiplomacyMenuComponent {
  private mp = inject(MultiplayerService);
  @Output() close = new EventEmitter<void>();

  /** Per-nation rows: your standing + that nation's wars/alliances, derived from the live matrix + rep signals. */
  protected nations = computed(() => {
    const matrix = this.mp.factionMatrix();
    const rep = this.mp.factionRep();
    return FACTIONS.map((f) => {
      const row = matrix[f.id] || {};
      const enemies = FACTIONS.filter((o) => o.id !== f.id && row[o.id] === 'war').map((o) => ({ id: o.id, name: o.name, color: o.color }));
      const allies  = FACTIONS.filter((o) => o.id !== f.id && row[o.id] === 'alliance').map((o) => ({ id: o.id, name: o.name, color: o.color }));
      const v = Math.round(rep[f.id] ?? 0);
      return { id: f.id, name: f.name, color: f.color, standing: v, standingLabel: v === 0 ? 'Neutral' : (v > 0 ? `+${v}` : String(v)), enemies, allies };
    });
  });
}
