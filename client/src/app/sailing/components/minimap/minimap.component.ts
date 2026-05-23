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
})
export class MinimapComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private islandService      = inject(IslandService);
  private vesselService      = inject(VesselService);
  private multiplayerService = inject(MultiplayerService);

  expanded = signal(false);

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
