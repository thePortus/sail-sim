import { Component, EventEmitter, Input, Output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { factionName, factionColor, reputationTier } from '../sailing/faction.config';
import { TerrainHarbor } from '../sailing/models';

/**
 * Governor's Mansion (capital) / Mayor's House (small + medium town) — opened from the dock menu. The seat of
 * the local nation's authority, where a captain in BAD standing can BUY back goodwill (server: petition_pardon).
 * A pardon is costly and only lifts you toward neutral — coin buys forgiveness, never affection. All authority is
 * server-side; this reads MultiplayerService signals (factionRep/gold) and mirrors the cost for display only.
 */
@Component({
  selector: 'app-governor-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (town.tier == 'capital') {
      <img src="/images/governor.png" alt="A governor's mansion.">
    }
    @else {
      <img src="/images/mayor.png" alt="A mayor's house.">
    }
    <div class="gv-backdrop" (click)="onClose()"></div>
    <div class="gv-panel" (click)="$event.stopPropagation()">
      <div class="gv-header">
        <div class="gv-title">{{ title() }}</div>
        <span class="gv-gold">⚜ {{ mp.gold() }} gold</span>
      </div>

      @if (fid(); as f) {
        <div class="gv-nation">
          <span class="gv-dot" [style.background]="color()"></span>
          <span class="gv-nation-name">{{ name() }}</span>
          <span class="gv-standing" [class.pos]="tier().tone === 'pos'" [class.neg]="tier().tone === 'neg'"
                [title]="'Standing ' + (standing() > 0 ? '+' : '') + standing()">{{ tier().label }}</span>
        </div>

        @if (standing() < 0) {
          <p class="gv-body">
            For the right sum, the {{ official() }} will overlook your past offences against the {{ name() }} and
            restore your good name — to a point. Coin buys forgiveness, never affection: a pardon only lifts you
            back toward neutral.
          </p>
          <button class="gv-buy" [disabled]="!canPetition()" (click)="petition()">
            {{ admin ? 'Grant pardon (free)' : 'Seek a pardon · ' + cost() + 'g' }}
            <span class="gv-gain">+{{ restore() }} standing</span>
          </button>
          @if (!admin && mp.gold() < cost()) { <div class="gv-warn">Not enough gold for a petition.</div> }
        } @else {
          <p class="gv-body gv-ok">
            Your standing with the {{ name() }} is sound — there is nothing to pardon. Favour beyond neutral is
            earned, not bought: privateer their enemies, and relieve their towns' shortages.
          </p>
        }

        @if (mp.pardonError(); as e) { <div class="gv-err">{{ prettyError(e) }}</div> }
      } @else {
        <p class="gv-body">This is a free port, beholden to no crown — there is no nation's favour to win or lose here.</p>
      }

      <button class="gv-close" (click)="onClose()">Go Back to Town</button>
    </div>
  `,
  styles: [`
    .gv-backdrop { position: fixed; inset: 0; background: rgba(8, 6, 3, 0.55); z-index: 70; }
    .gv-panel {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
      width: min(440px, 92vw); max-height: 86vh; overflow: hidden auto;
      background: linear-gradient(160deg, #2e2013, #15100a);
      border: 1px solid #6e5326; border-radius: 12px; padding: 1.1rem 1.2rem 1.2rem;
      box-shadow: 0 18px 50px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(184,138,62,0.15);
      color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .gv-header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid rgba(184,138,62,0.3); padding-bottom: 0.5rem; }
    .gv-title { font-size: 1.25rem; font-weight: 600; color: #e8d3a0; }
    .gv-gold { color: #f0c869; font-weight: 600; }
    .gv-nation { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.8rem; }
    .gv-dot { width: 13px; height: 13px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.45); flex: none; }
    .gv-nation-name { flex: 1; font-weight: 600; color: #f0e3c6; }
    .gv-standing { font-weight: 600; color: #cdbb95; }
    .gv-standing.pos { color: #9fe0a0; }
    .gv-standing.neg { color: #f0a8a0; }
    .gv-body { font-size: 0.86rem; color: #cdbb95; line-height: 1.45; margin: 0.8rem 0; }
    .gv-body.gv-ok { color: #b6cfa0; }
    .gv-buy { width: 100%; padding: 0.55rem 0.7rem; border-radius: 8px; border: 1px solid transparent; font-family: inherit; font-size: 0.95rem; cursor: pointer;
              background: linear-gradient(135deg, #c89a4a, #a3792f); color: #2c1d09; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
    .gv-buy:disabled { opacity: 0.35; cursor: not-allowed; }
    .gv-gain { font-size: 0.78rem; opacity: 0.85; }
    .gv-warn { margin-top: 0.45rem; font-size: 0.78rem; color: #f0a8a0; }
    .gv-err { margin-top: 0.6rem; padding: 0.4rem 0.6rem; border-radius: 6px; background: rgba(150,40,30,0.25); border: 1px solid rgba(190,80,60,0.5); color: #f0c0b0; font-size: 0.84rem; }
    .gv-close { margin-top: 0.95rem; width: 100%; padding: 0.55rem; border-radius: 8px; border: 1px solid #6e5326; background: #3a2817; color: #e8d3a0; font-family: inherit; font-size: 0.95rem; cursor: pointer; }
    .gv-close:hover { background: #4a3420; }
  `],
})
export class GovernorMenuComponent {
  @Input({ required: true }) town!: TerrainHarbor;
  @Input() admin = false;
  @Output() close = new EventEmitter<void>();
  protected mp = inject(MultiplayerService);

  // Mirror of the server pardon economics (display only — the server re-validates).
  private readonly PARDON_STEP = 20;
  private readonly GOLD_PER_POINT = 140;

  protected title    = computed(() => (this.town?.tier === 'capital' ? "Governor's Mansion" : "Mayor's House"));
  protected official = computed(() => (this.town?.tier === 'capital' ? 'Governor' : 'Mayor'));
  protected fid      = computed(() => this.town?.faction || null);
  protected name     = computed(() => factionName(this.fid()));
  protected color    = computed(() => factionColor(this.fid()));
  protected standing = computed(() => Math.round(this.mp.factionRep()[this.fid() ?? ''] ?? 0));
  protected tier     = computed(() => reputationTier(this.standing()));
  /** Points a single petition restores (capped at neutral). */
  protected restore  = computed(() => Math.min(this.PARDON_STEP, Math.max(0, -this.standing())));
  protected cost     = computed(() => (this.admin ? 0 : this.restore() * this.GOLD_PER_POINT));
  protected canPetition = computed(() =>
    this.fid() != null && this.standing() < 0 && (this.admin || this.mp.gold() >= this.cost()));

  petition(): void { if (this.town) { this.mp.petitionPardon(this.town.id); } }
  onClose(): void { this.mp.pardonError.set(null); this.close.emit(); }

  prettyError(reason: string): string {
    const map: Record<string, string> = {
      not_docked: 'You must be docked at one of this nation\'s ports.',
      no_faction: 'This port answers to no crown.',
      not_needed: 'Your standing is already neutral — nothing to pardon.',
      no_gold: 'Not enough gold for the petition.',
    };
    return map[reason] ?? `Petition failed (${reason}).`;
  }
}
