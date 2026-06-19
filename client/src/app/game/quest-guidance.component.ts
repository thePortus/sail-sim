import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MultiplayerService } from '../sailing/services/multiplayer.service';

/**
 * Contextual tutorial guidance: for the active quest objective, point at the REAL UI control it concerns — a
 * pulsing ring around the on-screen element (wind compass, sail selector, the dock "Trade"/"Tavern" buttons),
 * with a short callout. Objectives that aren't a UI element (steering, sailing a point of sail, hunting the
 * marked target) show a centred keyboard/action hint instead. Element targets are found by a `data-guide="<key>"`
 * attribute on the HUD/menu element, so the wiring stays declarative and easy to extend for storyline quests.
 *
 * Repositions on objective change, on resize, and on a slow interval (so it follows the dock menu appearing as
 * you near a port). If a targeted element isn't on screen yet, it falls back to the centred hint so guidance
 * never vanishes mid-step.
 */
// `key` may be a LIST: the ring anchors to the first on-screen match. This lets an objective point at the dock
// button when the market is shut and at an in-market element once it opens (the closed button is then covered).
type Guide = { kind: 'el'; key: string | string[]; text: string } | { kind: 'keys'; text: string };

const GUIDE: Record<string, Guide> = {
  // Seamanship — steering/sailing are keyboard; wind & sails are real HUD controls.
  rotate_cam:    { kind: 'keys', text: 'Drag with the mouse to look around your ship.' },
  turn_helm:     { kind: 'keys', text: 'Steer with A / D (or drag the view) to turn to port and starboard.' },
  make_way:      { kind: 'keys', text: 'Bear off the wind and let the Saltmeadow gather way.' },
  read_wind:     { kind: 'el', key: 'wind',  text: 'This is the wind — the arrow points where it blows FROM.' },
  trim_sails:    { kind: 'el', key: 'sails', text: 'Set your canvas here (keys 1–3).' },
  find_reach:    { kind: 'el', key: 'wind',  text: 'Turn until the wind is on your beam and your speed climbs.' },
  // Trade — dock prompt, then the Trade button; once the market is open, point INTO it.
  dock_portA:    { kind: 'el', key: 'dock',  text: 'Approach the pier and dock here.' },
  buy_cargo:     { kind: 'el', key: ['market', 'trade'], text: 'Open the market and buy a cargo to carry.' },
  sell_cargo:    { kind: 'el', key: ['market-hint', 'market'], text: 'This rumour names the port that pays best — sail there and sell your cargo.' },
  // Combat — dock at the tavern port, then the Tavern button, then hunt.
  dock_tavern:   { kind: 'el', key: 'dock',  text: 'Approach the pier and dock here.' },
  listen_rumour: { kind: 'el', key: 'tavern', text: 'Step into the tavern and listen for a rumour.' },
  sink_prey:     { kind: 'keys', text: 'Follow the gold marker. Run out your guns and fire a broadside until she sinks.' },
};

@Component({
  selector: 'app-quest-guidance',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (guide(); as g) {
      @if (box(); as b) {
        <div class="qg-ring" [style.left.px]="b.x" [style.top.px]="b.y" [style.width.px]="b.w" [style.height.px]="b.h"></div>
        <div class="qg-call" [style.left.px]="b.cx" [style.top.px]="b.by">{{ g.text }}</div>
      } @else {
        <div class="qg-call qg-call--center">{{ g.text }}</div>
      }
    }
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 80; pointer-events: none; }
    .qg-ring {
      position: absolute; border-radius: 9px; border: 2px solid #ffd479;
      animation: qg-pulse 1.4s ease-in-out infinite;
    }
    @keyframes qg-pulse {
      0%,100% { box-shadow: 0 0 0 2px rgba(255,212,121,0.55), 0 0 14px 3px rgba(255,200,90,0.45); }
      50%     { box-shadow: 0 0 0 3px rgba(255,224,138,0.95), 0 0 22px 6px rgba(255,200,90,0.8); }
    }
    .qg-call {
      position: absolute; transform: translateX(-50%);
      max-width: 260px; padding: 7px 12px; border-radius: 7px;
      background: rgba(20,26,33,0.92); color: #f0e8d6; border: 1px solid #c9a24a;
      font: 500 13px Georgia, 'Times New Roman', serif; line-height: 1.4; text-align: center;
      box-shadow: 0 6px 18px rgba(0,0,0,0.5);
    }
    /* Sit clear ABOVE the centred gunnery panel (bottom: 4.75rem, ~3 rows tall) so the hint never overlaps it. */
    .qg-call--center { left: 50%; bottom: 16rem; top: auto; transform: translateX(-50%); }
  `],
})
export class QuestGuidanceComponent implements OnDestroy {
  private mp = inject(MultiplayerService);

  /** Ring + callout box for an element target (screen px), or null to fall back to the centred hint. */
  readonly box = signal<{ x: number; y: number; w: number; h: number; cx: number; by: number } | null>(null);

  /** The active guidance: the first not-done objective that has a mapping. */
  readonly guide = computed<Guide | null>(() => {
    const q = this.mp.quest();
    if (!q) return null;
    for (const o of q.objectives) { if (!o.done && GUIDE[o.id]) return GUIDE[o.id]; }
    return null;
  });

  private timer: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => { this.guide(); this.reposition(); }, { allowSignalWrites: true });   // re-measure on objective change
    this.timer = setInterval(this.reposition, 250);                                      // follow the dock menu / layout shifts
    window.addEventListener('resize', this.reposition);
    // Capture-phase scroll: catches scrolling INSIDE any panel (e.g. the trader market), so the ring tracks the
    // anchored element instead of being left behind on the text it was pointing at. (window scroll itself bubbles.)
    window.addEventListener('scroll', this.reposition, true);
  }

  /** First on-screen element among the guide's key(s). Lets a step prefer an in-modal anchor over a covered one. */
  private findTarget(key: string | string[]): HTMLElement | null {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      const el = document.querySelector(`[data-guide="${k}"]`) as HTMLElement | null;
      if (el && el.offsetParent !== null) { return el; }   // in the DOM and not display:none
    }
    return null;
  }

  /** The clip rect of the element's nearest SCROLLING ancestor, if any — used to hide the ring once the target
   *  has scrolled out of that panel (otherwise a fixed ring would float over the panel's frame). */
  private scrollClipRect(el: HTMLElement): DOMRect | null {
    let p = el.parentElement;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) { return p.getBoundingClientRect(); }
      p = p.parentElement;
    }
    return null;
  }

  private reposition = (): void => {
    const g = this.guide();
    if (!g || g.kind === 'keys') { this.box.set(null); return; }
    const el = this.findTarget(g.key);
    if (!el) { this.box.set(null); return; }               // none on screen → centred hint
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { this.box.set(null); return; }
    // If the target has scrolled out of its panel, drop the ring (fall back to the centred hint) rather than
    // drawing it floating over the panel's edge.
    const clip = this.scrollClipRect(el);
    if (clip && (r.bottom < clip.top + 2 || r.top > clip.bottom - 2)) { this.box.set(null); return; }
    const pad = 8;
    const x = r.left - pad, y = r.top - pad, w = r.width + pad * 2, h = r.height + pad * 2;
    // Callout below the element, unless that would run off the bottom — then above.
    const below = y + h + 56 < window.innerHeight;
    this.box.set({ x, y, w, h, cx: x + w / 2, by: below ? y + h + 8 : y - 44 });
  };

  ngOnDestroy(): void {
    clearInterval(this.timer);
    window.removeEventListener('resize', this.reposition);
    window.removeEventListener('scroll', this.reposition, true);
  }
}
