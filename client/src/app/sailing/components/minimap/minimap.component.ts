import {
  Component, ElementRef, ViewChild, AfterViewInit, OnInit,
  OnDestroy, effect, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IslandService } from '../../services/island.service';
import { VesselService } from '../../services/vessel.service';
import { MultiplayerService } from '../../services/multiplayer.service';
import { Island } from '../../models';

@Component({
  selector: 'app-minimap',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './minimap.component.html',
  styles: [`
    .island-tooltip {
      position: fixed;
      background: rgba(8, 16, 28, 0.96);
      border: 1px solid rgba(190, 150, 60, 0.70);
      border-radius: 3px;
      padding: 8px 12px;
      pointer-events: none;
      z-index: 9999;
      max-width: 230px;
      box-shadow: 0 3px 14px rgba(0,0,0,0.65);
    }
    .island-tooltip__name {
      color: #e8c96a;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.03em;
      margin-bottom: 2px;
    }
    .island-tooltip__type {
      color: rgba(190, 150, 60, 0.75);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 5px;
    }
    .island-tooltip__desc {
      color: rgba(205, 193, 165, 0.88);
      font-size: 11px;
      line-height: 1.55;
    }
  `],
})
export class MinimapComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private islandService      = inject(IslandService);
  private vesselService      = inject(VesselService);
  private multiplayerService = inject(MultiplayerService);

  expanded      = signal(false);
  hoveredIsland = signal<Island | null>(null);
  tooltipX      = signal(0);
  tooltipY      = signal(0);

  // World bounds for map projection
  private readonly WORLD_RANGE = 25000; // ±25 000 units shown on full map

  private animFrameId: number | null = null;
  private precomputedIslands: { polygon: [number, number][]; color: string }[] = [];
  private keyHandler = (e: KeyboardEvent) => { if (e.code === 'KeyM') this.toggleExpand(); };

  constructor() {
    // effect() must run inside an injection context (constructor / field initializer).
    // Angular 19 throws NG0203 if called from ngAfterViewInit or later lifecycle hooks.
    effect(() => {
      this.islandService.islands();   // reactive dependency
      this.precomputeIslandPolygons();
    });
  }

  ngOnInit(): void {
    window.addEventListener('keydown', this.keyHandler);
  }

  ngAfterViewInit(): void {
    this.precomputeIslandPolygons();
    this.renderLoop();
  }

  ngOnDestroy(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('keydown', this.keyHandler);
  }

  toggleExpand(): void {
    this.expanded.update(v => !v);
  }

  onMouseMove(event: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const rect   = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const W = canvas.width;
    const H = canvas.height;
    const range = this.WORLD_RANGE;

    // Canvas pixels → world coordinates
    const worldX = (canvasX / W) * (range * 2) - range;
    const worldZ = range - (canvasY / H) * (range * 2);

    const islands = this.islandService.islands();
    let found: Island | null = null;
    for (let i = 0; i < this.precomputedIslands.length; i++) {
      if (this.pointInPolygon(worldX, worldZ, this.precomputedIslands[i].polygon)) {
        found = islands[i];
        break;
      }
    }
    this.hoveredIsland.set(found);

    // Position tooltip to the right of (and slightly above) the cursor.
    // Clamp so it doesn't overflow the right edge of the viewport.
    const TW = 246; // max-width + padding
    const left = event.clientX + 18 + TW > window.innerWidth
      ? event.clientX - TW - 8
      : event.clientX + 18;
    this.tooltipX.set(left);
    this.tooltipY.set(event.clientY - 6);
  }

  onMouseLeave(): void {
    this.hoveredIsland.set(null);
  }

  typeLabel(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  // ── Island pre-computation ────────────────────────────────────────────────

  private precomputeIslandPolygons(): void {
    this.precomputedIslands = this.islandService.islands().map(island => ({
      polygon: this.buildPolygon(island),
      color:   island.maxRadius > 3000 ? '#4a3728' : island.maxRadius > 1000 ? '#3d2e22' : '#2e2218',
    }));
  }

  private buildPolygon(island: Island): [number, number][] {
    const pts: [number, number][] = [];
    const N = 32;
    for (let i = 0; i < N; i++) {
      const angleDeg = (i / N) * 360;
      const r   = this.interpolateRadius(angleDeg, island);
      const rad = angleDeg * Math.PI / 180;
      pts.push([island.centerX + Math.sin(rad) * r, island.centerZ + Math.cos(rad) * r]);
    }
    return pts;
  }

  private interpolateRadius(angleDeg: number, island: Island): number {
    const cl = island.coastline;
    const sorted = [...cl].sort((a, b) => a.angleDeg - b.angleDeg);
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      let end = next.angleDeg <= curr.angleDeg ? next.angleDeg + 360 : next.angleDeg;
      if (angleDeg >= curr.angleDeg && angleDeg < end) {
        const t = (angleDeg - curr.angleDeg) / (end - curr.angleDeg);
        return curr.radius + t * (next.radius - curr.radius);
      }
    }
    return sorted[0].radius;
  }

  private pointInPolygon(px: number, pz: number, poly: [number, number][]): boolean {
    let inside = false;
    const n = poly.length;
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const xi = poly[i][0], zi = poly[i][1];
      const xj = poly[j][0], zj = poly[j][1];
      if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
        inside = !inside;
      }
      j = i;
    }
    return inside;
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  private renderLoop(): void {
    const draw = () => {
      this.drawFrame();
      this.animFrameId = requestAnimationFrame(draw);
    };
    this.animFrameId = requestAnimationFrame(draw);
  }

  private drawFrame(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const range = this.WORLD_RANGE;

    // World → canvas
    const wx = (x: number) => ((x + range) / (range * 2)) * W;
    const wz = (z: number) => ((range - z) / (range * 2)) * H; // Z flipped (north=up)

    // Background ocean
    ctx.fillStyle = '#0d2640';
    ctx.fillRect(0, 0, W, H);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 0.5;
    const gridStep = W / 8;
    for (let gx = 0; gx <= W; gx += gridStep) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy <= H; gy += gridStep) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    // Islands
    for (const { polygon, color } of this.precomputedIslands) {
      if (polygon.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(wx(polygon[0][0]), wz(polygon[0][1]));
      for (let i = 1; i < polygon.length; i++) ctx.lineTo(wx(polygon[i][0]), wz(polygon[i][1]));
      ctx.closePath();
      ctx.fillStyle   = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth   = 0.8;
      ctx.stroke();
    }

    // Other players
    for (const p of this.multiplayerService.otherPlayers()) {
      const px = wx(p.x);
      const pz = wz(p.z);
      ctx.fillStyle = 'rgba(255, 120, 80, 0.85)';
      ctx.beginPath();
      ctx.arc(px, pz, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Local vessel — arrow pointing in heading direction
    const vs = this.vesselService.state();
    const vx = wx(vs.x);
    const vz = wz(vs.z);
    const hr  = vs.heading * Math.PI / 180;
    const sz  = this.expanded() ? 9 : 6;

    ctx.save();
    ctx.translate(vx, vz);
    ctx.rotate(hr);
    ctx.fillStyle   = '#00ff88';
    ctx.strokeStyle = '#004422';
    ctx.lineWidth   = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, -sz);          // bow
    ctx.lineTo(-sz * 0.55, sz * 0.7); // port stern
    ctx.lineTo(0, sz * 0.3);     // notch
    ctx.lineTo(sz * 0.55, sz * 0.7);  // starboard stern
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Compass rose (top-right of minimap)
    const roseX = W - 16;
    const roseY = 16;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font      = `${this.expanded() ? 10 : 8}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('N', roseX, roseY);

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0, 0, W, H);
  }
}
