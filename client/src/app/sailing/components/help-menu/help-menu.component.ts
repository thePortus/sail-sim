import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

// ── Single source of truth for the controls ─────────────────────────────────
// Drives the Reference table, the visual Keyboard map, and the printable sheet — so they never drift apart.
type Cat = 'helm' | 'gun' | 'ui';
interface CtrlRow { k: string[]; d: string; }
interface CtrlGroup { title: string; cat: Cat; rows: CtrlRow[]; }

const GROUPS: CtrlGroup[] = [
  { title: 'Helm & Sail', cat: 'helm', rows: [
    { k: ['A', '←'],            d: 'Turn to port (left)' },
    { k: ['D', '→'],            d: 'Turn to starboard (right)' },
    { k: ['1', '2', '3'],       d: 'Reefed · Topsails · Full canvas' },
    { k: ['W', 'S'],            d: 'Step sail up / down' },
    { k: ['Q', 'E'],            d: 'Ease / haul the sheet (trim)' },
    { k: ['T'],                 d: 'Auto-trim to best sheet angle' },
    { k: ['P'],                 d: 'Drop / weigh anchor' },
    { k: ['V'],                 d: 'First-person / orbit view' },
  ] },
  { title: 'Gunnery', cat: 'gun', rows: [
    { k: ['Z'],                 d: 'Arm / fire port broadside' },
    { k: ['C'],                 d: 'Arm / fire starboard broadside' },
    { k: ['Shift'],             d: 'Hold — raise aim (toward masts)' },
    { k: ['Ctrl'],              d: 'Hold — lower aim (toward hull)' },
    { k: ['G'],                 d: 'Shot: Round → Bar → Grape' },
  ] },
  { title: 'Interface', cat: 'ui', rows: [
    { k: ['I', 'Tab'],          d: "Ship's Hold (cargo · gold · standing)" },
    { k: ['K'],                 d: 'Diplomacy (faction relations)' },
    { k: ['M'],                 d: 'Expand / close the map' },
    { k: ['RMB'],               d: 'Spyglass — magnify the view (5×) [hold]' },
    { k: ['Enter'],             d: 'Chat · / for a command' },
    { k: ['Esc'],               d: 'Pause · close panels' },
  ] },
];

// Visual keyboard: physical rows + a per-key short label & category for the keys the game uses.
const KB_ROWS: string[][] = [
  ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Enter'],
  ['Shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '/', '⇧'],
  ['Ctrl', 'Space'],
];
const WIDE: Record<string, number> = { Esc: 1.3, Tab: 1.5, Enter: 1.8, Shift: 2.0, '⇧': 2.0, Ctrl: 1.6, Space: 6 };
const KEY_FN: Record<string, { s: string; c: Cat }> = {
  A: { s: 'Port', c: 'helm' }, D: { s: 'Stbd', c: 'helm' }, W: { s: 'Sail ▲', c: 'helm' }, S: { s: 'Sail ▼', c: 'helm' },
  Q: { s: 'Ease', c: 'helm' }, E: { s: 'Haul', c: 'helm' }, T: { s: 'Trim', c: 'helm' }, P: { s: 'Anchor', c: 'helm' },
  V: { s: 'View', c: 'helm' }, '1': { s: 'Reef', c: 'helm' }, '2': { s: "Tops'l", c: 'helm' }, '3': { s: 'Full', c: 'helm' },
  Z: { s: 'Port ◉', c: 'gun' }, C: { s: 'Stbd ◉', c: 'gun' }, G: { s: 'Shot', c: 'gun' },
  Shift: { s: 'Aim ▲', c: 'gun' }, Ctrl: { s: 'Aim ▼', c: 'gun' },
  I: { s: 'Hold', c: 'ui' }, Tab: { s: 'Hold', c: 'ui' }, K: { s: 'Diplo.', c: 'ui' }, M: { s: 'Map', c: 'ui' },
  Enter: { s: 'Chat', c: 'ui' }, Esc: { s: 'Pause', c: 'ui' }, '/': { s: 'Cmd', c: 'ui' },
};

/**
 * Help screen (opened from the pause menu): the full control scheme + a one-glance rundown of the game systems,
 * a VISUAL keyboard map of the controls, and a one-click printer-friendly sheet (opens a clean print-only page,
 * not the whole site). Pure static reference — no services, no state beyond the active tab.
 */
@Component({
  selector: 'app-help-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="help-backdrop" (click)="close.emit()"></div>
    <div class="help-panel" (click)="$event.stopPropagation()">
      <div class="help-header">
        <div class="help-title">⚓ Captain's Handbook</div>
        <div class="help-tabs">
          <button [class.on]="view==='reference'" (click)="view='reference'">📖 Reference</button>
          <button [class.on]="view==='keyboard'"  (click)="view='keyboard'">⌨ Keyboard</button>
          <button class="print" (click)="print()" title="Open a printer-friendly controls sheet">🖨 Print</button>
        </div>
        <button class="help-close" (click)="close.emit()" title="Close">✕</button>
      </div>

      <!-- ── Reference (text) ─────────────────────────────────────── -->
      <div class="help-body" *ngIf="view==='reference'">
        <div class="help-col">
          <ng-container *ngFor="let g of groups">
            <h3>{{ g.title }}</h3>
            <table>
              <tr *ngFor="let r of g.rows">
                <td><kbd *ngFor="let key of r.k">{{ key }}</kbd></td>
                <td>{{ r.d }}</td>
              </tr>
            </table>
          </ng-container>
        </div>

        <div class="help-col">
          <h3>Wind &amp; Sailing</h3>
          <p>You're bound by the wind. Point within ~38° of where it blows <em>from</em> and you stall (in irons) and drift back. Fastest on a <b>broad reach</b>, 120–145° off the wind. Trim your sheets (<kbd>Q</kbd>/<kbd>E</kbd>/<kbd>T</kbd>) for every extra knot.</p>
          <h3>Trade &amp; Economy</h3>
          <p>Each town specialises — buy a good cheap where it's made, sell dear where it's scarce. Prices drift daily and react to what you (and rival traders) buy and sell. Persistent shortages drive the best profits.</p>
          <h3>Nations &amp; Diplomacy</h3>
          <p>Four powers — <span class="f-en">English</span>, <span class="f-fr">French</span>, <span class="f-es">Spanish</span>, <span class="f-du">Dutch</span> — fly over the towns. They make war, peace, and alliances; shifts are rare and announced in the chat. Press <kbd>K</kbd> to read the political map.</p>
          <h3>Reputation &amp; Piracy</h3>
          <p>Attack a nation's merchant shipping and your standing with it (and its allies) falls, while its <b>enemies</b> warm to you — far more for a sinking. Fall far enough out of favour and that nation's merchants treat you as an enemy on sight.</p>
          <h3>Merchants &amp; Combat</h3>
          <p>Autonomous traders ply the sea-lanes; sink one and a salvage crate floats free — sail over to scoop it. They shoot back and weigh your strength: outmatched, they flee; even or stronger, they hold their lane but engage if you close in. Round shot hulls, <b>bar shot</b> dismasts, <b>grape</b> thins crew. A downed mast slows a ship; a gutted crew sails and reloads slower.</p>
          <h3>Crew, Ships &amp; Squadrons</h3>
          <p>Your crew mans the guns and rigging — recruit replacements at a town's tavern. Buy bigger vessels at a shipwright; your ship and gold persist between voyages. Team up with <kbd>/squad invite</kbd> (up to four, friendly-fire off) and talk privately with <kbd>/s</kbd>.</p>
        </div>
      </div>

      <!-- ── Keyboard map ─────────────────────────────────────────── -->
      <div class="kb-wrap" *ngIf="view==='keyboard'">
        <div class="kb-legend">
          <span class="lg helm">Helm &amp; Sail</span>
          <span class="lg gun">Gunnery</span>
          <span class="lg ui">Interface</span>
        </div>
        <div class="kb">
          <div class="kb-row" *ngFor="let row of kbRows">
            <div class="key" *ngFor="let key of row"
                 [class.helm]="fn(key)?.c==='helm'" [class.gun]="fn(key)?.c==='gun'" [class.ui]="fn(key)?.c==='ui'"
                 [class.lit]="!!fn(key)" [style.flex-grow]="wide(key)">
              <span class="cap">{{ key }}</span>
              <span class="fn" *ngIf="fn(key)">{{ fn(key)!.s }}</span>
            </div>
          </div>
          <div class="kb-extra">
            <div class="arrows">
              <div class="key helm lit"><span class="cap">←</span><span class="fn">Port</span></div>
              <div class="key helm lit"><span class="cap">→</span><span class="fn">Stbd</span></div>
            </div>
            <div class="mouse">
              <div class="key ui lit"><span class="cap">RMB</span><span class="fn">Spyglass (hold)</span></div>
            </div>
          </div>
        </div>
        <p class="kb-note">Hold <kbd>Shift</kbd>/<kbd>Ctrl</kbd> while a broadside is armed to raise / lower aim. Highlighted keys are bound; the rest are unused.</p>
      </div>

      <div class="help-foot">Press <kbd>Esc</kbd> to close · fair winds, captain.</div>
    </div>
  `,
  styles: [`
    .help-backdrop { position: fixed; inset: 0; z-index: 202; background: rgba(4,10,20,0.72); backdrop-filter: blur(4px); cursor: pointer; }
    .help-panel {
      position: fixed; z-index: 203; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(900px, 94vw); max-height: 90vh; overflow: hidden auto;
      background: linear-gradient(160deg, #2e2013 0%, #15100a 100%);
      border: 1px solid rgba(200,170,100,0.30); border-radius: 12px; padding: 1.5rem 1.6rem 1.2rem;
      box-shadow: 0 24px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04) inset;
      color: #e9dcc0; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .help-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
    .help-title { font-family: monospace; font-size: 1.4rem; font-weight: bold; color: #c8a44a; letter-spacing: 0.04em; white-space: nowrap; }
    .help-tabs { display: flex; gap: 0.4rem; margin-left: auto; }
    .help-tabs button {
      background: rgba(255,255,255,0.05); border: 1px solid rgba(200,170,100,0.30); color: #cdb887;
      font-family: monospace; font-size: 0.78rem; padding: 4px 10px; border-radius: 6px; cursor: pointer;
    }
    .help-tabs button:hover { background: rgba(255,255,255,0.12); color: #f0e3c6; }
    .help-tabs button.on { background: rgba(200,170,100,0.22); color: #f4e8c8; border-color: rgba(200,170,100,0.6); }
    .help-tabs button.print { color: #9fd3a0; border-color: rgba(120,190,130,0.4); }
    .help-close { background: none; border: none; color: #b9a06a; font-size: 1.2rem; cursor: pointer; line-height: 1; padding: 2px 8px; }
    .help-close:hover { color: #f0e3c6; }
    .help-body { display: grid; grid-template-columns: 1fr 1fr; gap: 1.4rem 2rem; }
    @media (max-width: 680px) { .help-body { grid-template-columns: 1fr; } .help-tabs button { font-size: 0.7rem; padding: 4px 7px; } }
    .help-col h3 { font-family: monospace; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.1em; color: #c8a44a; margin: 1rem 0 0.4rem; }
    .help-col h3:first-child { margin-top: 0; }
    .help-col table { width: 100%; border-collapse: collapse; }
    .help-col td { padding: 0.2rem 0.3rem; vertical-align: top; font-size: 0.86rem; color: #ddd0b2; }
    .help-col td:first-child { width: 7.5rem; white-space: nowrap; }
    .help-col p { font-size: 0.85rem; line-height: 1.45; color: #cfc2a4; margin: 0 0 0.2rem; }
    .help-col b { color: #ecdcb2; } .help-col em { color: #e7d6ab; font-style: italic; }
    kbd {
      display: inline-block; min-width: 1.1rem; text-align: center; padding: 1px 5px; margin: 0 1px;
      font-family: monospace; font-size: 0.74rem; color: #f0e3c6;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(200,170,100,0.35);
      border-radius: 4px; box-shadow: 0 1px 0 rgba(0,0,0,0.4);
    }
    .f-en { color: #e06a6a; font-weight: 600; } .f-fr { color: #6a9be0; font-weight: 600; }
    .f-es { color: #e8c33a; font-weight: 600; } .f-du { color: #e89a55; font-weight: 600; }
    .help-foot { margin-top: 1.2rem; padding-top: 0.7rem; border-top: 1px solid rgba(200,170,100,0.2); text-align: center; font-family: monospace; font-size: 0.72rem; color: rgba(255,255,255,0.3); }
    .help-foot kbd { color: rgba(255,255,255,0.4); }

    /* ── Keyboard map ── */
    .kb-legend { display: flex; gap: 1rem; justify-content: center; margin-bottom: 0.9rem; font-family: monospace; font-size: 0.72rem; }
    .kb-legend .lg { padding: 2px 9px; border-radius: 5px; }
    .lg.helm { background: rgba(91,155,213,0.18); color: #9cc6ef; border: 1px solid rgba(91,155,213,0.5); }
    .lg.gun  { background: rgba(224,106,106,0.16); color: #ef9a9a; border: 1px solid rgba(224,106,106,0.5); }
    .lg.ui   { background: rgba(200,164,74,0.16);  color: #e3cd85; border: 1px solid rgba(200,164,74,0.55); }
    .kb { max-width: 720px; margin: 0 auto; }
    .kb-row { display: flex; gap: 6px; margin-bottom: 6px; }
    .key { flex: 1 1 0; min-width: 0; height: 3.1rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
           background: rgba(255,255,255,0.03); display: flex; flex-direction: column; align-items: center; justify-content: center;
           color: #8a8472; font-family: monospace; overflow: hidden; }
    .key .cap { font-size: 0.78rem; font-weight: 600; }
    .key .fn  { font-size: 0.6rem; margin-top: 2px; opacity: 0.95; line-height: 1; }
    .key.lit { color: #f0e7d0; }
    .key.helm.lit { background: rgba(91,155,213,0.22); border-color: rgba(91,155,213,0.7); }
    .key.gun.lit  { background: rgba(224,106,106,0.20); border-color: rgba(224,106,106,0.7); }
    .key.ui.lit   { background: rgba(200,164,74,0.20);  border-color: rgba(200,164,74,0.7); }
    .kb-extra { display: flex; gap: 2rem; justify-content: center; margin-top: 0.9rem; }
    .arrows { display: flex; gap: 6px; } .arrows .key, .mouse .key { width: 5rem; flex: none; }
    .kb-note { text-align: center; font-size: 0.74rem; color: #b6a983; margin-top: 1rem; line-height: 1.4; }
  `],
})
export class HelpMenuComponent {
  @Output() close = new EventEmitter<void>();

  view: 'reference' | 'keyboard' = 'reference';
  readonly groups = GROUPS;
  readonly kbRows = KB_ROWS;

  fn(key: string): { s: string; c: Cat } | undefined { return KEY_FN[key]; }
  wide(key: string): number { return WIDE[key] ?? 1; }

  /** Open a clean printer-only window with just the controls + keyboard map (no game, no site chrome). */
  print(): void {
    const w = window.open('', 'sailsim_controls', 'width=900,height=760');
    if (!w) { return; }
    w.document.open();
    w.document.write(this.buildPrintHtml());
    w.document.close();
    w.focus();
    // Give the new document a beat to lay out before invoking the print dialog.
    setTimeout(() => { try { w.print(); } catch { /* user can Ctrl+P */ } }, 200);
  }

  private buildPrintHtml(): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const groupsHtml = GROUPS.map(g => `
      <section>
        <h2 class="${g.cat}">${esc(g.title)}</h2>
        <table>${g.rows.map(r => `<tr><td class="keys">${r.k.map(k => `<kbd>${esc(k)}</kbd>`).join(' ')}</td><td>${esc(r.d)}</td></tr>`).join('')}</table>
      </section>`).join('');
    const kbHtml = KB_ROWS.map(row => `<div class="kr">${row.map(k => {
      const f = KEY_FN[k];
      return `<div class="pk ${f ? f.c + ' lit' : ''}" style="flex-grow:${WIDE[k] ?? 1}"><b>${esc(k)}</b>${f ? `<i>${esc(f.s)}</i>` : ''}</div>`;
    }).join('')}</div>`).join('') +
      `<div class="kr extra"><div class="pk helm lit"><b>←</b><i>Port</i></div><div class="pk helm lit"><b>→</b><i>Stbd</i></div><div class="pk ui lit"><b>RMB</b><i>Spyglass</i></div></div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Sail-Sim — Controls</title><style>
      * { box-sizing: border-box; } body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 24px; }
      h1 { font-size: 20px; margin: 0 0 2px; } .sub { color: #555; font-size: 12px; margin: 0 0 16px; }
      .cols { display: flex; gap: 28px; align-items: flex-start; }
      section { break-inside: avoid; margin-bottom: 12px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 4px; padding-bottom: 2px; border-bottom: 1px solid #ccc; }
      h2.helm { color: #1f5e9b; } h2.gun { color: #b23b3b; } h2.ui { color: #8a6a16; }
      table { border-collapse: collapse; width: 100%; } td { font-size: 12px; padding: 2px 4px; vertical-align: top; } td.keys { white-space: nowrap; width: 120px; }
      kbd { font-family: 'Courier New', monospace; font-size: 11px; border: 1px solid #999; border-radius: 3px; padding: 0 4px; background: #f4f4f4; }
      h3 { font-size: 13px; margin: 18px 0 6px; }
      .kb { max-width: 680px; } .kr { display: flex; gap: 4px; margin-bottom: 4px; } .kr.extra { justify-content: center; gap: 10px; margin-top: 8px; }
      .pk { flex: 1 1 0; min-width: 0; height: 40px; border: 1px solid #bbb; border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #999; }
      .kr.extra .pk { flex: none; width: 70px; }
      .pk b { font-family: 'Courier New', monospace; font-size: 11px; } .pk i { font-size: 8px; font-style: normal; margin-top: 1px; }
      .pk.lit { color: #111; } .pk.helm.lit { background: #dbeaf7; border-color: #1f5e9b; } .pk.gun.lit { background: #f7dede; border-color: #b23b3b; } .pk.ui.lit { background: #f6eccf; border-color: #8a6a16; }
      .foot { margin-top: 18px; color: #777; font-size: 11px; } @page { margin: 14mm; }
    </style></head><body>
      <h1>⚓ Sail-Sim — Controls</h1>
      <p class="sub">Keyboard &amp; mouse reference · fair winds, captain.</p>
      <div class="cols">
        <div style="flex:1">${groupsHtml}</div>
        <div style="flex:1.05"><h3>Keyboard map</h3><div class="kb">${kbHtml}</div></div>
      </div>
      <p class="foot">Hold Shift / Ctrl while a broadside is armed to raise / lower aim.</p>
    </body></html>`;
  }
}
