import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Help screen (opened from the pause menu): the full control scheme grouped by purpose, plus a one-glance
 * rundown of the major game systems (sailing, trade, factions/diplomacy, piracy reputation, combat, crew,
 * ships, squadrons). Pure static reference — no services, no state.
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
        <button class="help-close" (click)="close.emit()" title="Close">✕</button>
      </div>

      <div class="help-body">
        <!-- ── Controls ─────────────────────────────────────────── -->
        <div class="help-col">
          <h3>Helm &amp; Sail</h3>
          <table>
            <tr><td><kbd>A</kbd> <kbd>←</kbd></td><td>Turn to port (left)</td></tr>
            <tr><td><kbd>D</kbd> <kbd>→</kbd></td><td>Turn to starboard (right)</td></tr>
            <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></td><td>Reefed · Topsails · Full canvas</td></tr>
            <tr><td><kbd>W</kbd> <kbd>S</kbd></td><td>Step sail up / down</td></tr>
            <tr><td><kbd>Q</kbd> <kbd>E</kbd></td><td>Ease / haul the sheet (trim)</td></tr>
            <tr><td><kbd>T</kbd></td><td>Auto-trim to best sheet angle</td></tr>
            <tr><td><kbd>P</kbd></td><td>Drop / weigh anchor</td></tr>
            <tr><td><kbd>V</kbd></td><td>First-person / orbit view</td></tr>
          </table>

          <h3>Gunnery</h3>
          <table>
            <tr><td><kbd>Z</kbd></td><td>Arm / fire <b>port</b> broadside</td></tr>
            <tr><td><kbd>C</kbd></td><td>Arm / fire <b>starboard</b> broadside</td></tr>
            <tr><td><kbd>Shift</kbd></td><td>Hold — raise aim (toward masts)</td></tr>
            <tr><td><kbd>Ctrl</kbd></td><td>Hold — lower aim (toward hull)</td></tr>
            <tr><td><kbd>G</kbd></td><td>Shot: Round → Bar → Grape</td></tr>
          </table>

          <h3>Interface</h3>
          <table>
            <tr><td><kbd>I</kbd> <kbd>Tab</kbd></td><td>Ship's Hold (cargo · gold · standing)</td></tr>
            <tr><td><kbd>K</kbd></td><td>Diplomacy (faction relations)</td></tr>
            <tr><td><kbd>M</kbd></td><td>Expand / close the map</td></tr>
            <tr><td><kbd>RMB</kbd> hold</td><td>Spyglass — magnify the view (5×)</td></tr>
            <tr><td><kbd>Enter</kbd></td><td>Chat · <kbd>/</kbd> for a command</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>Pause · close panels</td></tr>
          </table>
        </div>

        <!-- ── Mechanics at a glance ────────────────────────────── -->
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

      <div class="help-foot">Press <kbd>Esc</kbd> to close · fair winds, captain.</div>
    </div>
  `,
  styles: [`
    .help-backdrop { position: fixed; inset: 0; z-index: 202; background: rgba(4,10,20,0.72); backdrop-filter: blur(4px); cursor: pointer; }
    .help-panel {
      position: fixed; z-index: 203; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(840px, 94vw); max-height: 90vh; overflow: hidden auto;
      background: linear-gradient(160deg, #2e2013 0%, #15100a 100%);
      border: 1px solid rgba(200,170,100,0.30); border-radius: 12px; padding: 1.5rem 1.6rem 1.2rem;
      box-shadow: 0 24px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04) inset;
      color: #e9dcc0; font-family: 'IBM Plex Serif', Georgia, serif;
    }
    .help-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .help-title { font-family: monospace; font-size: 1.4rem; font-weight: bold; color: #c8a44a; letter-spacing: 0.04em; }
    .help-close { background: none; border: none; color: #b9a06a; font-size: 1.2rem; cursor: pointer; line-height: 1; padding: 2px 8px; }
    .help-close:hover { color: #f0e3c6; }
    .help-body { display: grid; grid-template-columns: 1fr 1fr; gap: 1.4rem 2rem; }
    @media (max-width: 680px) { .help-body { grid-template-columns: 1fr; } }
    .help-col h3 { font-family: monospace; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.1em; color: #c8a44a; margin: 1rem 0 0.4rem; }
    .help-col h3:first-child { margin-top: 0; }
    .help-col table { width: 100%; border-collapse: collapse; }
    .help-col td { padding: 0.2rem 0.3rem; vertical-align: top; font-size: 0.86rem; color: #ddd0b2; }
    .help-col td:first-child { width: 7.5rem; white-space: nowrap; }
    .help-col p { font-size: 0.85rem; line-height: 1.45; color: #cfc2a4; margin: 0 0 0.2rem; }
    .help-col b { color: #ecdcb2; }
    .help-col em { color: #e7d6ab; font-style: italic; }
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
  `],
})
export class HelpMenuComponent {
  @Output() close = new EventEmitter<void>();
}
