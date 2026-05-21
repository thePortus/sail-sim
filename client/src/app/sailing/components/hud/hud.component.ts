import { Component, computed, inject, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VesselService } from '../../services/vessel.service';
import { WeatherService } from '../../services/weather.service';
import { SceneService } from '../../services/scene.service';
import { SailState } from '../../models';

@Component({
  selector: 'app-hud',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hud.component.html',
})
export class HudComponent {
  vesselService  = inject(VesselService);
  weatherService = inject(WeatherService);
  sceneService   = inject(SceneService);

  vessel  = this.vesselService.state;
  weather = this.weatherService.weather;

  // Wind FROM bearing for compass arrow (SVG rotation)
  windFromDeg = computed(() => this.weather()?.wind.fromBearingDeg ?? 0);

  // Heading in compass cardinal form
  headingCardinal = computed(() => {
    const h = this.vessel().heading;
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(h / 22.5) % 16];
  });

  // Knots: 1 unit/s ≈ 1.94 knots (using 1 unit = 1 m/s)
  speedKnots = computed(() => Math.abs(this.vessel().speed * 1.94).toFixed(1));

  // Wind speed in knots
  windKnots = computed(() => {
    const w = this.weather()?.wind;
    return w ? (w.speed * 1.94).toFixed(1) : '--';
  });

  // Point-of-sail label — thresholds mirror sailEfficiency() in vessel.service
  pointOfSail = computed(() => {
    const a = this.vessel().windAngle;
    if (a < 32)  return 'In Irons';
    if (a < 45)  return 'Close Hauled';
    if (a < 60)  return 'Close Reach';
    if (a < 90)  return 'Beam Reach';
    if (a < 145) return 'Broad Reach';
    if (a < 165) return 'Running';
    return 'Dead Downwind';
  });

  sailLabel = computed(() => {
    switch (this.vessel().sailState) {
      case 'reefed':   return 'Sails Furled';
      case 'topsails': return 'Reduced Sail';
      case 'full':     return 'Full Sail';
    }
  });

  // Clock: 12-hour format with AM/PM and a phase icon
  gameTimeStr = computed(() => {
    const h    = this.sceneService.gameTime();
    const hrs  = Math.floor(h);
    const mins = Math.floor((h - hrs) * 60);
    const h12  = hrs === 0 ? 12 : hrs > 12 ? hrs - 12 : hrs;
    const ampm = hrs < 12 ? 'AM' : 'PM';
    return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
  });

  dayPhaseIcon = computed(() => {
    const h = this.sceneService.gameTime();
    if (h >= 5.5 && h < 7)  return '🌅';
    if (h >= 7   && h < 17) return '☀️';
    if (h >= 17  && h < 19) return '🌇';
    return '🌙';
  });

  grounded  = this.vesselService.grounded;
  exitGame  = output<void>();

  setSail(state: SailState): void {
    this.vesselService.setSailState(state);
  }

  refloat(): void {
    this.vesselService.refloat();
  }

  exit(): void {
    this.exitGame.emit();
  }
}
