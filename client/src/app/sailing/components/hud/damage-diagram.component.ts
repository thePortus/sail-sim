import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CombatService } from '../../services/combat.service';
import { Zone } from '../../services/combat.constants';

/**
 * HUD hull-damage diagram: a stylised top-down sloop whose five zones (bow, port,
 * starboard, stern, masts) light from the LOCAL player's authoritative hull state
 * (CombatService): unlit (no damage) → green → yellow → red.
 */
@Component({
  selector: 'app-damage-diagram',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="hud-panel damage-diagram pointer-events-none">
      <div class="dd-title">Hull</div>
      <svg viewBox="0 0 100 184" class="dd-svg" aria-label="hull damage">
        <!-- bow -->
        <path [attr.fill]="fill('bow')" stroke="#0c141d" stroke-width="1"
              d="M50,8 C70,30 78,50 78,62 L22,62 C22,50 30,30 50,8 Z" />
        <!-- port (left) / starboard (right) midship -->
        <path [attr.fill]="fill('port')" stroke="#0c141d" stroke-width="1"
              d="M22,62 L50,62 L50,135 L22,135 Z" />
        <path [attr.fill]="fill('starboard')" stroke="#0c141d" stroke-width="1"
              d="M50,62 L78,62 L78,135 L50,135 Z" />
        <!-- stern -->
        <path [attr.fill]="fill('stern')" stroke="#0c141d" stroke-width="1"
              d="M22,135 L78,135 L78,150 C78,166 65,174 50,174 C35,174 22,166 22,150 Z" />
        <!-- masts (centreline) -->
        <circle [attr.fill]="fill('masts')" stroke="#0c141d" stroke-width="1"
                cx="50" cy="99" r="9" />
        <!-- zone labels -->
        <g class="dd-label" fill="#cfe3f5">
          <text x="50" y="40"  text-anchor="middle">BOW</text>
          <text x="34" y="102" text-anchor="middle">P</text>
          <text x="66" y="102" text-anchor="middle">S</text>
          <text x="50" y="158" text-anchor="middle">STERN</text>
        </g>
      </svg>
    </div>
  `,
})
export class DamageDiagramComponent {
  private combat = inject(CombatService);

  private readonly COLORS: Record<string, string> = {
    none:      'rgba(120,140,160,0.10)',
    green:     '#3fb950',
    yellow:    '#d29922',
    red:       '#f85149',
    destroyed: '#5a0f0f',
  };

  fill(zone: Zone): string {
    return this.COLORS[this.combat.severity(zone)] ?? this.COLORS['none'];
  }
}
