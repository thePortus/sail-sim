import { Component, ElementRef, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MultiplayerService } from '../sailing/services/multiplayer.service';

/**
 * Quest tracker HUD — a persistent checklist of the active quest's current objectives, with each objective's
 * onscreen HINT as guidance. Server-verified objectives (sail / dock / trade / sink) tick themselves as the
 * server reports them done; trivial UI steps (client_ack — rotate camera, trim sails, listen for a rumour) get a
 * "Done ✓" button that the player clicks to confirm (→ questAck). Intro quests show a "Skip tutorial" button.
 * Reads MultiplayerService.quest(); the story modal overlays this during narrative beats.
 */
@Component({
  selector: 'app-quest-tracker',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (mp.quest(); as q) {
      <div class="qt" [class.placed]="pos()" [class.dragging]="dragging()"
           [style.left.px]="pos()?.x" [style.top.px]="pos()?.y">
        <div class="qt-head" (pointerdown)="onDragStart($event)" title="Drag to reposition">
          <span class="qt-grip">⠿</span>
          <span class="qt-title">{{ q.title }}</span>
          <span class="qt-stage">{{ q.stageIndex + 1 }} / {{ q.stageCount }}</span>
        </div>
        <ul class="qt-objs">
          @for (o of q.objectives; track o.id) {
            <li class="qt-obj" [class.done]="o.done">
              <span class="qt-check">{{ o.done ? '☑' : '☐' }}</span>
              <div class="qt-body">
                <div class="qt-label">{{ o.label }}</div>
                @if (!o.done && o.hint) { <div class="qt-hint">{{ o.hint }}</div> }
                @if (!o.done && o.type === 'client_ack') {
                  <button class="qt-ack" (click)="mp.questAck(o.id)">Done ✓</button>
                }
              </div>
            </li>
          }
        </ul>
        <div class="qt-foot">
          @if (q.reward.gold > 0) { <span class="qt-reward">Reward ⚜ {{ q.reward.gold }}</span> }
          @else { <span></span> }
          @if (isIntro(q.questId)) {
            @if (confirmSkip()) {
              <span class="qt-confirm">
                <button class="qt-skip qt-skip-yes" (click)="doSkip()">Skip — sure?</button>
                <button class="qt-skip" (click)="confirmSkip.set(false)">Keep</button>
              </span>
            } @else {
              <button class="qt-skip" (click)="confirmSkip.set(true)">Skip tutorial</button>
            }
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 70; pointer-events: none; }
    .qt {
      position: fixed; right: 210px; top: 4.5rem;
      width: 286px; pointer-events: auto; color: #e8e0cf;
      background: rgba(18,24,31,0.86); border: 1px solid #34485a; border-radius: 9px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.45); font-family: Georgia, 'Times New Roman', serif; overflow: hidden;
    }
    .qt.placed { right: auto; }
    .qt.dragging { box-shadow: 0 12px 36px rgba(0,0,0,0.6); border-color: #4f7390; user-select: none; }
    .qt-head { display: flex; align-items: baseline; gap: 7px; justify-content: space-between;
      padding: 9px 12px; background: rgba(46,73,96,0.5); border-bottom: 1px solid #34485a;
      cursor: grab; touch-action: none; }
    .qt.dragging .qt-head { cursor: grabbing; }
    .qt-grip { font-size: 12px; color: #6f8498; letter-spacing: -2px; }
    .qt-title { flex: 1; font-weight: 700; font-size: 14px; letter-spacing: 0.3px; color: #f0e8d6; }
    .qt-stage { font: 600 11px ui-monospace, monospace; color: #8aa0b4; }
    .qt-objs { list-style: none; margin: 0; padding: 6px 4px; }
    .qt-obj { display: flex; gap: 7px; padding: 6px 8px; }
    .qt-obj.done .qt-label { color: #8fbf8a; text-decoration: line-through; opacity: 0.8; }
    .qt-check { font-size: 15px; line-height: 1.4; color: #9bb3c6; }
    .qt-obj.done .qt-check { color: #8fbf8a; }
    .qt-body { flex: 1; }
    .qt-label { font-size: 13.5px; line-height: 1.35; }
    .qt-hint { font-size: 12px; line-height: 1.4; color: #9fb0c0; margin-top: 2px; font-style: italic; }
    .qt-ack { margin-top: 5px; background: #2e4960; color: #eaf2fb; border: 1px solid #45627d;
      border-radius: 5px; padding: 3px 11px; font: 600 12px Georgia, serif; cursor: pointer; }
    .qt-ack:hover { background: #386081; }
    .qt-foot { display: flex; align-items: center; justify-content: space-between;
      padding: 7px 12px; border-top: 1px solid #34485a; }
    .qt-reward { font-size: 12px; color: #ffd479; font-weight: 700; }
    .qt-skip { background: transparent; color: #8aa0b4; border: 1px solid #3a4d5e; border-radius: 5px;
      padding: 3px 10px; font: 500 11px Georgia, serif; cursor: pointer; }
    .qt-skip:hover { color: #cfe; border-color: #557; }
    .qt-confirm { display: flex; gap: 6px; }
    .qt-skip-yes { color: #ffb3a0; border-color: #6a3a32; }
    .qt-skip-yes:hover { color: #ffd0c4; border-color: #8a4a40; }
  `],
})
export class QuestTrackerComponent {
  readonly mp = inject(MultiplayerService);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly confirmSkip = signal(false);

  /** Saved top-left of the panel; null = auto-place to the left of the sails panel. Persisted across sessions. */
  readonly pos = signal<{ x: number; y: number } | null>(this.loadPos());
  readonly dragging = signal(false);
  private grab = { dx: 0, dy: 0 };
  private autoPlaced = false;

  constructor() {
    // On first appearance (no saved position), tuck the tracker just left of the sails panel so they
    // don't overlap. Measured at runtime since the sails panel's width varies; not persisted.
    effect(() => {
      const q = this.mp.quest();
      if (q && !this.pos() && !this.autoPlaced) {
        requestAnimationFrame(() => requestAnimationFrame(() => this.autoPlaceLeftOfSails()));
      }
    });
  }

  private autoPlaceLeftOfSails(): void {
    if (this.pos() || this.autoPlaced) return;
    const panel = this.host.nativeElement.querySelector('.qt') as HTMLElement | null;
    const sails = document.querySelector('[data-guide="sails"]') as HTMLElement | null;
    if (!panel) return;
    this.autoPlaced = true;
    if (!sails) return; // keep the CSS fallback default
    const sr = sails.getBoundingClientRect();
    const pw = panel.offsetWidth || 286;
    const x = Math.max(8, sr.left - pw - 12);
    const y = Math.max(8, sr.top);
    this.pos.set({ x, y });
  }

  private static readonly KEY = 'ignis_quest_pos';
  private loadPos(): { x: number; y: number } | null {
    try {
      const raw = localStorage.getItem(QuestTrackerComponent.KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
    } catch { /* ignore */ }
    return null;
  }

  isIntro(id: string): boolean { return id.startsWith('intro'); }
  doSkip(): void { this.confirmSkip.set(false); this.mp.questSkip(); }

  onDragStart(ev: PointerEvent): void {
    const panel = (ev.currentTarget as HTMLElement).closest('.qt') as HTMLElement | null;
    if (!panel) return;
    ev.preventDefault();
    const r = panel.getBoundingClientRect();
    this.grab = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    // Seed from the live rect so the first frame doesn't jump from the CSS default anchor.
    this.pos.set({ x: r.left, y: r.top });
    this.dragging.set(true);
    const move = (e: PointerEvent) => this.onDragMove(e, panel);
    const up = () => {
      this.dragging.set(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const cur = this.pos();
      if (cur) { try { localStorage.setItem(QuestTrackerComponent.KEY, JSON.stringify(cur)); } catch { /* ignore */ } }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private onDragMove(ev: PointerEvent, panel: HTMLElement): void {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const x = Math.max(4, Math.min(window.innerWidth - w - 4, ev.clientX - this.grab.dx));
    const y = Math.max(4, Math.min(window.innerHeight - h - 4, ev.clientY - this.grab.dy));
    this.pos.set({ x, y });
  }
}
