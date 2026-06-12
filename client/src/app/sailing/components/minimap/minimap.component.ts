import {
  Component, ElementRef, ViewChild, AfterViewInit, OnInit,
  OnDestroy, inject, signal, NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TerrainService } from '../../services/terrain.service';
import { VesselService } from '../../services/vessel.service';
import { MultiplayerService } from '../../services/multiplayer.service';
import { SceneService } from '../../services/scene.service';
import { MinimapBakeCompute } from '../../services/terrain/minimap-bake-compute';
import type { WebGPUEngine } from '@babylonjs/core';

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
  private sceneService       = inject(SceneService);
  private zone               = inject(NgZone);

  expanded = signal(false);

  // Zoom + pan for the EXPANDED map. zoom 1 = whole world (the original view); higher = zoomed in on a
  // sub-region centred on (viewCX, viewCZ) in world coords. Wheel zooms toward the cursor. Plain fields
  // (not signals): the rAF draw loop reads them every frame, so they need no change detection.
  private readonly MAX_ZOOM = 6;
  private zoom = 1;
  private viewCX = 0;
  private viewCZ = 0;
  private viewInit = false;

  // Click-drag pan (expanded map). dragMoved distinguishes a pan from a click so a drag doesn't also
  // toggle the map closed; suppressClick eats the click event that fires at the end of a drag.
  private dragging = false;
  private dragMoved = false;
  private dragLastX = 0;
  private dragLastY = 0;
  private dragStartX = 0;
  private dragStartY = 0;

  private animFrameId: number | null = null;
  private terrainLayerSmall: HTMLCanvasElement | null = null;
  private terrainLayerLarge: HTMLCanvasElement | null = null;
  private keyHandler = (e: KeyboardEvent) => { if (e.code === 'KeyM') this.toggleExpand(); };
  /** Cursor position in canvas-pixel space (null when off the map) — drives the town hover tooltip. */
  private hoverPx: { x: number; y: number } | null = null;

  /** Track the cursor over the map (canvas-pixel space, accounting for any CSS scaling). */
  onPointerMove(e: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || this.dragging) { this.hoverPx = null; return; }   // no town tooltip mid-pan
    const r = canvas.getBoundingClientRect();
    this.hoverPx = {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }
  onPointerLeave(): void { this.hoverPx = null; }

  // ── Click-drag pan (expanded map) ───────────────────────────────────────────

  /** Begin a drag-pan. Only on the expanded map + left button; the drag itself is tracked via window
   *  listeners (outside the zone) so it keeps working if the cursor leaves the canvas and adds no CD. */
  onMouseDown(e: MouseEvent): void {
    if (!this.expanded() || e.button !== 0) { return; }
    e.preventDefault();
    this.dragging = true;
    this.dragMoved = false;
    this.dragStartX = this.dragLastX = e.clientX;
    this.dragStartY = this.dragLastY = e.clientY;
    this.hoverPx = null;
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) { canvas.style.cursor = 'grabbing'; }
    this.zone.runOutsideAngular(() => {
      window.addEventListener('mousemove', this.onDragMove);
      window.addEventListener('mouseup', this.onDragUp);
    });
  }

  private onDragMove = (e: MouseEvent): void => {
    if (!this.dragging) { return; }
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) { return; }
    const r = canvas.getBoundingClientRect();
    const dxPx = (e.clientX - this.dragLastX) * (canvas.width / r.width);
    const dyPx = (e.clientY - this.dragLastY) * (canvas.height / r.height);
    this.dragLastX = e.clientX; this.dragLastY = e.clientY;
    if (Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY) > 4) { this.dragMoved = true; }
    const b = this.terrainService.getWorldBounds();
    const visW = (b.maxX - b.minX) / this.zoom, visH = (b.maxZ - b.minZ) / this.zoom;
    this.viewCX -= dxPx * (visW / canvas.width);    // grab-and-pull: the world follows the cursor
    this.viewCZ += dyPx * (visH / canvas.height);   // Z flipped (north = up)
    this.clampView();
  };

  private onDragUp = (): void => {
    if (!this.dragging) { return; }
    this.dragging = false;
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) { canvas.style.cursor = ''; }
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragUp);
  };

  /** Wrapper click → toggle expand, UNLESS it was the tail of a drag-pan. dragMoved is reset by the next
   *  mousedown, so checking it directly (vs a persisted flag) can't get stuck if a drag ends off-canvas. */
  onMapClick(): void {
    if (this.dragMoved) { return; }
    this.toggleExpand();
  }

  /** Mouse-wheel zoom — only on the EXPANDED map. Zooms toward the cursor (the world point under the
   *  pointer stays put), clamped to [1, MAX_ZOOM] and to the world bounds. Registered outside the Angular
   *  zone (see ngAfterViewInit) so scrolling adds no change detection; the rAF loop redraws from the fields. */
  private wheelHandler = (e: WheelEvent): void => {
    if (!this.expanded()) { return; }   // small map stays whole-world; let the page scroll otherwise
    e.preventDefault();
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) { return; }
    const r = canvas.getBoundingClientRect();
    const cxp = (e.clientX - r.left) * (canvas.width / r.width);
    const cyp = (e.clientY - r.top) * (canvas.height / r.height);
    const before = this.canvasToWorld(cxp, cyp);
    // Scale the step by the wheel delta but cap it at one notch, so a mouse wheel (deltaY≈±100/notch) and a
    // trackpad two-finger scroll (many small deltas) both zoom at a comfortable rate. Up/out → zoom in.
    const step = Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100);
    this.zoom = Math.max(1, Math.min(this.MAX_ZOOM, this.zoom * Math.pow(1.2, -step)));
    this.clampView();
    const after = this.canvasToWorld(cxp, cyp);
    this.viewCX += before.x - after.x;                     // keep the cursor's world point fixed
    this.viewCZ += before.z - after.z;
    this.clampView();
  };

  /** Canvas-pixel → world coords under the current zoom/pan view. */
  private canvasToWorld(cxp: number, cyp: number): { x: number; z: number } {
    const canvas = this.canvasRef.nativeElement;
    const b = this.terrainService.getWorldBounds();
    const visW = (b.maxX - b.minX) / this.zoom, visH = (b.maxZ - b.minZ) / this.zoom;
    return {
      x: (this.viewCX - visW / 2) + (cxp / canvas.width) * visW,
      z: (this.viewCZ + visH / 2) - (cyp / canvas.height) * visH,   // Z flipped (north = up)
    };
  }

  /** Keep the view centre inside the world so the visible window never runs past the map edge. At zoom 1
   *  this pins the centre to the world centre → the exact original whole-world framing. */
  private clampView(): void {
    const b = this.terrainService.getWorldBounds();
    if (!this.viewInit) { this.viewCX = (b.minX + b.maxX) / 2; this.viewCZ = (b.minZ + b.maxZ) / 2; this.viewInit = true; }
    const visW = (b.maxX - b.minX) / this.zoom, visH = (b.maxZ - b.minZ) / this.zoom;
    this.viewCX = Math.max(b.minX + visW / 2, Math.min(b.maxX - visW / 2, this.viewCX));
    this.viewCZ = Math.max(b.minZ + visH / 2, Math.min(b.maxZ - visH / 2, this.viewCZ));
  }

  ngOnInit(): void {
    window.addEventListener('keydown', this.keyHandler);
  }

  ngAfterViewInit(): void {
    this.rebuildTerrainLayers();
    // Wheel listener outside the zone (no change detection per scroll) + non-passive so preventDefault
    // can stop the page from scrolling while zooming the map.
    this.zone.runOutsideAngular(() => {
      this.canvasRef.nativeElement.addEventListener('wheel', this.wheelHandler, { passive: false });
    });
    this.renderLoop();
  }

  ngOnDestroy(): void {
    if (this.animFrameId !== null) cancelAnimationFrame(this.animFrameId);
    window.removeEventListener('keydown', this.keyHandler);
    this.canvasRef?.nativeElement.removeEventListener('wheel', this.wheelHandler);
    window.removeEventListener('mousemove', this.onDragMove);   // in case torn down mid-drag
    window.removeEventListener('mouseup', this.onDragUp);
  }

  toggleExpand(): void {
    this.expanded.update(v => !v);
    if (!this.expanded()) { this.zoom = 1; this.viewInit = false; }   // collapsing → reset to whole-world view
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

    // Visible window = the zoom/pan view (zoom 1 → whole world). clampView pins it inside the map.
    this.clampView();
    const visW = worldW / this.zoom, visH = worldH / this.zoom;
    const viewMinX = this.viewCX - visW / 2;
    const viewMaxZ = this.viewCZ + visH / 2;

    // World → canvas (view-relative)
    const wx = (x: number) => ((x - viewMinX) / visW) * W;
    const wz = (z: number) => ((viewMaxZ - z) / visH) * H; // Z flipped (north=up)

    // Terrain raster background — blit the visible sub-rectangle of the (whole-world) layer up to fill.
    const layer = this.expanded() ? this.terrainLayerLarge : this.terrainLayerSmall;
    if (layer) {
      const sx = ((viewMinX - bounds.minX) / worldW) * layer.width;
      const sy = ((bounds.maxZ - viewMaxZ) / worldH) * layer.height;
      const sw = (visW / worldW) * layer.width;
      const sh = (visH / worldH) * layer.height;
      ctx.drawImage(layer, sx, sy, sw, sh, 0, 0, W, H);
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

    // Harbor towns (expanded map only) — markers + a tooltip on hover. Discovered towns (in the player's
    // ledger) are tinted + reveal specialty/prices; a pulsing beacon marks the trader's current rumour town.
    if (this.expanded()) {
      const harbors = this.terrainService.getHarbors();
      const hp = this.hoverPx;
      const ledger = this.multiplayerService.ledger();
      const hinted = this.multiplayerService.hintedHarbor();
      const cat = this.multiplayerService.goodsCatalog();
      const now = performance.now();
      const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
      let hovered: { lines: string[]; x: number; y: number } | null = null;
      let bestD = 8;   // px hover radius
      for (const h of harbors) {
        const hxp = wx(h.x), hyp = wz(h.z);
        const known = !!ledger[h.id];
        // Pulsing beacon ring at the rumoured town (drawn under the marker dot).
        if (hinted && h.id === hinted) {
          const pulse = 0.5 + 0.5 * Math.sin(now / 350);
          ctx.strokeStyle = `rgba(240,200,105,${0.4 + 0.5 * pulse})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(hxp, hyp, 7 + pulse * 5, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle   = known ? '#9fe0a0' : '#e8d3a0';   // green = discovered, tan = unexplored
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth   = 0.8;
        ctx.beginPath();
        ctx.arc(hxp, hyp, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (hp) {
          const d = Math.hypot(hp.x - hxp, hp.y - hyp);
          if (d < bestD) {
            bestD = d;
            const lines = [h.name, h.description];
            const led = ledger[h.id];
            if (led) {
              lines.push(`Trade: ${cap(led.specialty)}`);
              const cheap = [...led.goods].sort((a, b) => a.ask - b.ask)[0];
              const dear  = [...led.goods].sort((a, b) => b.bid - a.bid)[0];
              if (cheap) lines.push(`Buy ${cat[cheap.id] ?? cheap.id} @ ${cheap.ask}g`);
              if (dear)  lines.push(`Pays ${dear.bid}g for ${cat[dear.id] ?? dear.id}`);
            } else {
              lines.push('(unexplored — dock to learn its trade)');
            }
            hovered = { lines, x: hxp, y: hyp };
          }
        }
      }
      if (hovered) {
        // Highlight the hovered marker, then draw a multi-line pill above it.
        ctx.fillStyle = '#fff4d0';
        ctx.beginPath(); ctx.arc(hovered.x, hovered.y, 4, 0, Math.PI * 2); ctx.fill();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        let maxW = 0;
        hovered.lines.forEach((ln, i) => {
          ctx.font = i === 0 ? 'bold 11px monospace' : '9px monospace';
          maxW = Math.max(maxW, ctx.measureText(ln).width);
        });
        const padX = 6, lineH = 12, boxW = maxW + padX * 2, boxH = 9 + hovered.lines.length * lineH;
        let bx = hovered.x - boxW / 2;
        let by = hovered.y - 8 - boxH;
        bx = Math.max(2, Math.min(W - boxW - 2, bx));   // keep the pill on-map
        by = Math.max(2, by);

        ctx.fillStyle = 'rgba(10,16,26,0.9)';
        ctx.strokeStyle = 'rgba(232,211,160,0.5)';
        ctx.lineWidth = 1;
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeRect(bx, by, boxW, boxH);

        const cx = bx + boxW / 2;
        let ty = by + 13;
        hovered.lines.forEach((ln, i) => {
          if (i === 0)      { ctx.fillStyle = '#ffe9b0'; ctx.font = 'bold 11px monospace'; }
          else if (i === 1) { ctx.fillStyle = 'rgba(220,220,210,0.85)'; ctx.font = '9px monospace'; }
          else              { ctx.fillStyle = '#9fe0a0'; ctx.font = '9px monospace'; }
          ctx.fillText(ln, cx, ty);
          ty += lineH;
        });
      }
    }

    // Other players — split into friends (gold) and strangers (orange)
    const mutuals = this.multiplayerService.mutualFriends();
    const others = this.multiplayerService.otherPlayers();

    // Nearest merchant beacon — the server reports the single closest merchant's position at ANY distance
    // (no ship is built for a far one), so the map always points to the nearest trader.
    const nm = this.multiplayerService.nearestMerchant();
    if (nm) {
      const mx = wx(nm.x), mz = wz(nm.z), s = this.expanded() ? 7 : 6;
      ctx.fillStyle   = '#22e3d0';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth   = 1.4;
      ctx.beginPath();
      ctx.moveTo(mx,     mz - s);
      ctx.lineTo(mx + s, mz);
      ctx.lineTo(mx,     mz + s);
      ctx.lineTo(mx - s, mz);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    for (const p of others) {
      if (p.npc) continue;   // merchants are shown via the nearest-merchant beacon above, not per-ship
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

    // Floating salvage crates (from sunk merchants) — small amber boxes.
    for (const c of this.multiplayerService.salvageService.crateList()) {
      const cx = wx(c.x), cz = wz(c.z);
      ctx.fillStyle   = 'rgba(240, 200, 105, 0.95)';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth   = 0.7;
      ctx.fillRect(cx - 2, cz - 2, 4, 4);
      ctx.strokeRect(cx - 2, cz - 2, 4, 4);
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

  // Stale-bake guard: rebuilds can overlap (terrain reload while a GPU bake is in flight) — only
  // the newest generation's results are applied.
  private bakeGeneration = 0;

  private rebuildTerrainLayers(): void {
    if (!this.terrainService.isReady()) {
      this.terrainLayerSmall = null;
      this.terrainLayerLarge = null;
      return;
    }

    // GPU bake (roadmap P4): one compute pass + readback per layer instead of 4.2M CPU height
    // reads (~400 ms hitch at 2048²). The layers pop in a few frames later — drawFrame already
    // tolerates null layers. A/B hatch: localStorage.setItem('ignis_minimap_gpu','0') forces CPU.
    const hf = this.terrainService.getHeightFieldGPU();
    if (hf && this.sceneService.isWebGPU && localStorage.getItem('ignis_minimap_gpu') !== '0') {
      const gen = ++this.bakeGeneration;
      const peak = this.terrainService.getManifest()?.targetPeakElevation ?? 920;
      const baker = new MinimapBakeCompute(
        this.sceneService.engine as WebGPUEngine, this.sceneService.scene);
      const apply = (res: number, assign: (c: HTMLCanvasElement) => void) =>
        baker.bake(res, hf.tex, hf.texSize, peak).then((px) => {
          if (gen === this.bakeGeneration) { assign(this.pixelsToCanvas(res, px)); }
        });
      apply(256, (c) => { this.terrainLayerSmall = c; })
        .then(() => apply(2048, (c) => { this.terrainLayerLarge = c; }))
        .catch((e) => {
          console.warn('[Minimap] GPU bake failed — falling back to CPU raster:', e);
          if (gen === this.bakeGeneration) {
            this.terrainLayerSmall = this.buildTerrainLayer(256, 256);
            this.terrainLayerLarge = this.buildTerrainLayer(2048, 2048);
          }
        })
        .finally(() => baker.dispose());
      return;
    }

    this.terrainLayerSmall = this.buildTerrainLayer(256, 256);
    this.terrainLayerLarge = this.buildTerrainLayer(2048, 2048);   // hi-res so zoomed-in terrain stays crisp
  }

  /** Wrap GPU-baked RGBA bytes (canvas row order) in a canvas for drawImage. */
  private pixelsToCanvas(res: number, px: Uint8Array): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, res * res * 4), res, res);
    ctx.putImageData(image, 0, 0);
    return canvas;
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
        const e = this.terrainService.getElevationFast(x, z);   // nearest is plenty for a coarse raster (cheaper at 1024²)

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
