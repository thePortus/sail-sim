import {
  Component, ElementRef, ViewChild, AfterViewInit, OnInit,
  OnDestroy, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TerrainService } from '../../services/terrain.service';
import { VesselService } from '../../services/vessel.service';
import { MultiplayerService } from '../../services/multiplayer.service';

@Component({
  selector: 'app-minimap',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './minimap.component.html',
  styles: [],
})
export class MinimapComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private terrainService     = inject(TerrainService);
  private vesselService      = inject(VesselService);
  private multiplayerService = inject(MultiplayerService);

  expanded = signal(false);

  private animFrameId: number | null = null;
  private terrainLayerSmall: HTMLCanvasElement | null = null;
  private terrainLayerLarge: HTMLCanvasElement | null = null;
  private keyHandler = (e: KeyboardEvent) => { if (e.code === 'KeyM') this.toggleExpand(); };
  /** Cursor position in canvas-pixel space (null when off the map) — drives the town hover tooltip. */
  private hoverPx: { x: number; y: number } | null = null;

  /** Track the cursor over the map (canvas-pixel space, accounting for any CSS scaling). */
  onPointerMove(e: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) { this.hoverPx = null; return; }
    const r = canvas.getBoundingClientRect();
    this.hoverPx = {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }
  onPointerLeave(): void { this.hoverPx = null; }

  ngOnInit(): void {
    window.addEventListener('keydown', this.keyHandler);
  }

  ngAfterViewInit(): void {
    this.rebuildTerrainLayers();
    this.renderLoop();
  }

  ngOnDestroy(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('keydown', this.keyHandler);
  }

  toggleExpand(): void {
    this.expanded.update(v => !v);
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
    const bounds = this.terrainService.getWorldBounds();
    const worldW = bounds.maxX - bounds.minX;
    const worldH = bounds.maxZ - bounds.minZ;

    // World → canvas
    const wx = (x: number) => ((x - bounds.minX) / worldW) * W;
    const wz = (z: number) => ((bounds.maxZ - z) / worldH) * H; // Z flipped (north=up)

    // Terrain raster background
    const layer = this.expanded() ? this.terrainLayerLarge : this.terrainLayerSmall;
    if (layer) {
      ctx.drawImage(layer, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#0d2640';
      ctx.fillRect(0, 0, W, H);
    }

    // Subtle grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 0.5;
    const gridStep = W / 8;
    for (let gx = 0; gx <= W; gx += gridStep) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy <= H; gy += gridStep) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    // Harbor towns (expanded map only) — markers + a name/description tooltip on hover.
    if (this.expanded()) {
      const harbors = this.terrainService.getHarbors();
      const hp = this.hoverPx;
      let hovered: { name: string; description: string; x: number; y: number } | null = null;
      let bestD = 8;   // px hover radius
      for (const h of harbors) {
        const hxp = wx(h.x), hyp = wz(h.z);
        ctx.fillStyle   = '#e8d3a0';            // tan — distinct from player gold/orange
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth   = 0.8;
        ctx.beginPath();
        ctx.arc(hxp, hyp, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (hp) {
          const d = Math.hypot(hp.x - hxp, hp.y - hyp);
          if (d < bestD) { bestD = d; hovered = { name: h.name, description: h.description, x: hxp, y: hyp }; }
        }
      }
      if (hovered) {
        // Highlight the hovered marker, then draw a name (+ description) pill above it.
        ctx.fillStyle = '#fff4d0';
        ctx.beginPath(); ctx.arc(hovered.x, hovered.y, 4, 0, Math.PI * 2); ctx.fill();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.font = 'bold 11px monospace';
        const nameW = ctx.measureText(hovered.name).width;
        ctx.font = '9px monospace';
        const descW = ctx.measureText(hovered.description).width;
        const padX = 6, boxW = Math.max(nameW, descW) + padX * 2, boxH = 30;
        let bx = hovered.x - boxW / 2;
        let by = hovered.y - 8 - boxH;
        bx = Math.max(2, Math.min(W - boxW - 2, bx));   // keep the pill on-map
        by = Math.max(2, by);

        ctx.fillStyle = 'rgba(10,16,26,0.86)';
        ctx.strokeStyle = 'rgba(232,211,160,0.5)';
        ctx.lineWidth = 1;
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeRect(bx, by, boxW, boxH);

        const cx = bx + boxW / 2;
        ctx.fillStyle = '#ffe9b0';
        ctx.font = 'bold 11px monospace';
        ctx.fillText(hovered.name, cx, by + 13);
        ctx.fillStyle = 'rgba(220,220,210,0.85)';
        ctx.font = '9px monospace';
        ctx.fillText(hovered.description, cx, by + 25);
      }
    }

    // Other players — split into friends (gold) and strangers (orange)
    const mutuals = this.multiplayerService.mutualFriends();

    for (const p of this.multiplayerService.otherPlayers()) {
      const px = wx(p.x);
      const pz = wz(p.z);

      if (mutuals.includes(p.callsign)) {
        // Mutual friend — gold diamond with callsign label
        const s = this.expanded() ? 6 : 5;
        ctx.fillStyle   = '#fbbf24';
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth   = 0.9;
        ctx.beginPath();
        ctx.moveTo(px,     pz - s);
        ctx.lineTo(px + s, pz);
        ctx.lineTo(px,     pz + s);
        ctx.lineTo(px - s, pz);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        const fontSize = this.expanded() ? 9 : 8;
        ctx.fillStyle    = 'rgba(251,191,36,0.92)';
        ctx.font         = `bold ${fontSize}px monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(p.callsign.toUpperCase(), px, pz - s - 2);
      } else {
        // Regular player — small orange circle
        ctx.fillStyle = 'rgba(255, 120, 80, 0.85)';
        ctx.beginPath();
        ctx.arc(px, pz, 3, 0, Math.PI * 2);
        ctx.fill();
      }
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

  private rebuildTerrainLayers(): void {
    if (!this.terrainService.isReady()) {
      this.terrainLayerSmall = null;
      this.terrainLayerLarge = null;
      return;
    }
    this.terrainLayerSmall = this.buildTerrainLayer(200, 200);
    this.terrainLayerLarge = this.buildTerrainLayer(600, 600);
  }

  private buildTerrainLayer(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = ctx.createImageData(width, height);
    const data = image.data;

    const manifest = this.terrainService.getManifest();
    const bounds = this.terrainService.getWorldBounds();
    const peak = manifest?.targetPeakElevation ?? 920;

    for (let py = 0; py < height; py++) {
      const z = bounds.maxZ - (py / (height - 1)) * (bounds.maxZ - bounds.minZ);
      for (let px = 0; px < width; px++) {
        const x = bounds.minX + (px / (width - 1)) * (bounds.maxX - bounds.minX);
        const e = this.terrainService.getElevation(x, z);

        const idx = (py * width + px) * 4;
        let r = 13;
        let g = 38;
        let b = 64;

        if (e > 0.01) {
          const t = e / peak;
          if (t < 0.03)      { r = 170; g = 148; b = 110; }
          else if (t < 0.25) { r = 63;  g = 104; b = 48;  }
          else if (t < 0.55) { r = 95;  g = 83;  b = 65;  }
          else if (t < 0.80) { r = 72;  g = 64;  b = 57;  }
          else               { r = 56;  g = 52;  b = 52;  }
        }

        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(image, 0, 0);
    return canvas;
  }
}
