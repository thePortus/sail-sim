import { Component, inject } from '@angular/core';
import { MultiplayerService } from '../sailing/services/multiplayer.service';

/**
 * Quest reward toast — a brief floating "⚜ +Xg" badge for stage rewards that land WITHOUT a story beat (e.g.
 * the steer/sails seamanship sub-stages). Narrative-bearing rewards are shown inside the story modal instead;
 * this only fires on the server's `quest_reward` message. Auto-clears after ~2.8s (set in MultiplayerService).
 */
@Component({
  selector: 'app-quest-toast',
  standalone: true,
  template: `
    @if (mp.questReward(); as g) {
      <div class="qrt" role="status">
        <span class="qrt-coin">⚜</span>
        <span class="qrt-amt">+{{ g }}</span>
        <span class="qrt-label">gold earned</span>
      </div>
    }
  `,
  styles: [`
    :host { position: fixed; left: 0; right: 0; top: 64px; z-index: 80; pointer-events: none;
      display: flex; justify-content: center; }
    .qrt {
      display: flex; align-items: center; gap: 9px;
      padding: 9px 18px; color: #2a2008;
      background: linear-gradient(180deg, #f6dd92, #e7c264);
      border: 1px solid #b9912f; border-radius: 24px;
      box-shadow: 0 6px 22px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.55);
      font-family: Georgia, 'Times New Roman', serif;
      animation: qrt-in 0.34s cubic-bezier(.2,1.3,.4,1) both, qrt-out 0.5s ease-in 2.3s both;
    }
    .qrt-coin { font-size: 18px; }
    .qrt-amt { font-weight: 700; font-size: 17px; letter-spacing: 0.3px; }
    .qrt-label { font-size: 13px; opacity: 0.8; }
    @keyframes qrt-in { from { opacity: 0; transform: translateY(-14px) scale(0.9); } to { opacity: 1; transform: none; } }
    @keyframes qrt-out { from { opacity: 1; } to { opacity: 0; transform: translateY(-8px); } }
  `],
})
export class QuestToastComponent {
  readonly mp = inject(MultiplayerService);
}
