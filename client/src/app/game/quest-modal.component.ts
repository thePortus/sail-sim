import { Component, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { QuestPanel } from '../sailing/models';

/**
 * Story modal for the intro tutorial (and future storyline quests). Shows the atmospheric narrative panels —
 * a stage's intro narrative (once per stage) and a stage's closing "beat" (with any gold awarded) — as a
 * click-through sequence over a darkened backdrop. Each panel has an IMAGE SLOT resolved to
 * /images/quests/<slot>.png (drop art there later; missing → text-only, no broken image).
 *
 * Pure story delivery: it does NOT complete objectives — those live in the quest tracker / are server-verified.
 * Reads MultiplayerService.quest()/questNarrative(); a closing beat is shown FIRST (server sends it first), then
 * the next stage's intro.
 */
@Component({
  selector: 'app-quest-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (panels().length) {
      <div class="qm-backdrop"></div>
      <div class="qm-panel" (click)="$event.stopPropagation()">
        @if (cur().image) {
          <img class="qm-img" [src]="'/images/quests/' + cur().image + '.png'" (error)="hideImg($event)" alt="">
        }
        <div class="qm-text">{{ cur().text }}</div>
        @if (reward() > 0 && last()) {
          <div class="qm-reward">⚜ +{{ reward() }} gold</div>
        }
        <div class="qm-foot">
          <span class="qm-progress">{{ idx() + 1 }} / {{ panels().length }}</span>
          <button class="qm-btn" (click)="next()">{{ last() ? doneLabel : 'Continue ›' }}</button>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 200; pointer-events: none; }
    .qm-backdrop { position: absolute; inset: 0; background: rgba(6,10,16,0.78); pointer-events: auto; }
    .qm-panel {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
      width: min(620px, 92vw); max-height: 88vh; overflow: auto; pointer-events: auto;
      background: linear-gradient(180deg,#1c232c,#141a21); color: #e8e0cf;
      border: 1px solid #3a4d5e; border-radius: 10px; box-shadow: 0 18px 60px rgba(0,0,0,0.6);
      padding: 0 0 14px; font-family: Georgia, 'Times New Roman', serif;
    }
    .qm-img { display: block; width: 100%; height: auto; border-radius: 10px 10px 0 0; border-bottom: 1px solid #2a3a48; }
    .qm-text { padding: 18px 22px 6px; font-size: 16px; line-height: 1.6; letter-spacing: 0.2px; }
    .qm-reward { padding: 4px 22px; color: #ffd479; font-weight: 700; }
    .qm-foot { display: flex; align-items: center; justify-content: space-between; padding: 10px 22px 0; }
    .qm-progress { color: #7b8a99; font-size: 12px; font-family: ui-monospace, monospace; }
    .qm-btn {
      background: #2e4960; color: #eaf2fb; border: 1px solid #45627d; border-radius: 6px;
      padding: 8px 18px; font: 600 15px Georgia, serif; cursor: pointer;
    }
    .qm-btn:hover { background: #386081; }
  `],
})
export class QuestModalComponent {
  private mp = inject(MultiplayerService);

  readonly panels = signal<QuestPanel[]>([]);
  readonly idx    = signal(0);
  readonly reward = signal(0);
  private mode: 'stage' | 'beat' = 'stage';
  private lastStageKey = '';

  constructor() {
    effect(() => {
      // A closing beat takes priority (server sends it before the next stage). Only enqueue while idle.
      const beat = this.mp.questNarrative();
      if (this.panels().length === 0 && beat && beat.panels.length) {
        this.mode = 'beat'; this.reward.set(beat.rewardGold); this.idx.set(0); this.panels.set(beat.panels);
        return;
      }
      const q = this.mp.quest();
      if (this.panels().length === 0 && q && q.narrative && q.narrative.length) {
        const key = q.questId + ':' + q.stageIndex;
        if (key !== this.lastStageKey) {
          this.lastStageKey = key; this.mode = 'stage'; this.reward.set(0); this.idx.set(0); this.panels.set(q.narrative);
        }
      }
    }, { allowSignalWrites: true });
  }

  cur(): QuestPanel { return this.panels()[this.idx()] ?? { image: null, text: '' }; }
  last(): boolean { return this.idx() >= this.panels().length - 1; }
  get doneLabel(): string { return this.mode === 'beat' ? 'Onward ›' : 'Begin ›'; }

  next(): void {
    if (!this.last()) { this.idx.set(this.idx() + 1); return; }
    const wasBeat = this.mode === 'beat';
    this.panels.set([]); this.idx.set(0); this.reward.set(0);
    if (wasBeat) { this.mp.dismissQuestNarrative(); }   // let the next stage's intro flow in
  }

  hideImg(e: Event): void { (e.target as HTMLImageElement).style.display = 'none'; }
}
