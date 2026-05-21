import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import {
  MeshBuilder, Vector3, StandardMaterial, Color3,
  VertexBuffer, Mesh,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { Island, CoastlinePoint, IslandPeak } from '../models';
import { Settings } from '../../app.settings';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class IslandService {
  private http         = inject(HttpClient);
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);

  islands = signal<Island[]>([]);

  // Cached coastline polygons keyed by island id — built once during mesh creation
  private polygonCache = new Map<string, { x: number; z: number }[]>();

  async load(): Promise<void> {
    const data = await firstValueFrom(
      this.http.get<Island[]>(`${Settings.apiUrl}islands`)
    );
    this.islands.set(data);
    for (const island of data) {
      this.buildIslandMesh(island);
    }
  }

  // ── Public land-check API ─────────────────────────────────────────────────
  // Used by VesselService for collision detection. Returns true if the given
  // world position (wx, wz) falls inside any island's coastline polygon.

  isOnLand(wx: number, wz: number): boolean {
    for (const island of this.islands()) {
      const poly = this.polygonCache.get(island.id);
      if (!poly) continue;
      if (this.pointInPolygon(wx, wz, poly)) return true;
    }
    return false;
  }

  // Returns the island whose spawn point is nearest to (wx, wz), or the first
  // island as a fallback. Used by refloat() to find a safe relaunching spot.
  nearestIslandSpawn(wx: number, wz: number): { spawnX: number; spawnZ: number } {
    const list = this.islands();
    if (!list.length) return { spawnX: 7200, spawnZ: 0 };
    let best = list[0];
    let bestDist = Infinity;
    for (const island of list) {
      const dx = wx - island.centerX;
      const dz = wz - island.centerZ;
      const d  = dx * dx + dz * dz;
      if (d < bestDist) { bestDist = d; best = island; }
    }
    return { spawnX: best.spawnX, spawnZ: best.spawnZ };
  }

  // ── Coastline helpers ──────────────────────────────────────────────────────

  private interpolateRadius(angleDeg: number, coastline: CoastlinePoint[]): number {
    const sorted = [...coastline].sort((a, b) => a.angleDeg - b.angleDeg);
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      let endAngle = next.angleDeg <= curr.angleDeg ? next.angleDeg + 360 : next.angleDeg;
      if (angleDeg >= curr.angleDeg && angleDeg < endAngle) {
        const t = (angleDeg - curr.angleDeg) / (endAngle - curr.angleDeg);
        return curr.radius + t * (next.radius - curr.radius);
      }
    }
    return sorted[0].radius;
  }

  private buildCoastlinePolygon(island: Island): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    const N = 64;
    for (let i = 0; i < N; i++) {
      const angleDeg = (i / N) * 360;
      const r = this.interpolateRadius(angleDeg, island.coastline);
      const rad = angleDeg * Math.PI / 180;
      pts.push({
        x: island.centerX + Math.sin(rad) * r,
        z: island.centerZ + Math.cos(rad) * r,
      });
    }
    return pts;
  }

  private pointInPolygon(px: number, pz: number, poly: { x: number; z: number }[]): boolean {
    let inside = false;
    const n = poly.length;
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const xi = poly[i].x, zi = poly[i].z;
      const xj = poly[j].x, zj = poly[j].z;
      if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
        inside = !inside;
      }
      j = i;
    }
    return inside;
  }

  // ── Elevation model ────────────────────────────────────────────────────────

  private computeElevation(
    wx: number, wz: number,
    island: Island,
    polygon: { x: number; z: number }[],
  ): number {
    if (!this.pointInPolygon(wx, wz, polygon)) return 0;

    const dx = wx - island.centerX;
    const dz = wz - island.centerZ;
    const distFromCenter = Math.sqrt(dx * dx + dz * dz);

    // Compass angle to this vertex from island centre
    const angleDeg = ((Math.atan2(dx, dz) * 180 / Math.PI) + 360) % 360;
    const coastlineRadius = this.interpolateRadius(angleDeg, island.coastline);
    const normalizedR = Math.min(1, distFromCenter / coastlineRadius);

    // Steep volcanic cone profile
    const profile = Math.pow(Math.max(0, 1 - normalizedR), 1.35);
    let elevation = island.peakElevation * profile;

    // Multi-octave terrain noise for natural texture
    const n = (f: number, ox: number, oz: number) =>
      Math.sin(wx * f + oz) * Math.cos(wz * f + ox);
    const noise =
      n(0.003,  0,    0   ) * 0.55 +
      n(0.0071, 13.7, -8.3) * 0.28 +
      n(0.018,  -5.1, 22.6) * 0.12 +
      n(0.045,  31.2,  7.9) * 0.05;
    elevation += noise * 90 * profile;

    // Additive secondary peaks
    for (const peak of island.peaks) {
      const pdx = wx - (island.centerX + peak.dx);
      const pdz = wz - (island.centerZ + peak.dz);
      const peakDist = Math.sqrt(pdx * pdx + pdz * pdz);
      if (peakDist < peak.radius) {
        const t = 1 - peakDist / peak.radius;
        elevation += peak.elevation * t * t * 0.55;
      }
    }

    // Smooth transition to sea at coastline (no sharp cliffs at waterline)
    if (normalizedR > 0.82) {
      const blend = (normalizedR - 0.82) / 0.18;
      elevation *= Math.max(0, 1 - blend * blend);
    }

    return Math.max(0, elevation);
  }

  // ── Elevation-based vertex colour ─────────────────────────────────────────

  private elevationColor(elevation: number, peakElev: number): [number, number, number] {
    const t = elevation / peakElev;
    const lerp = (a: number[], b: number[], x: number): [number, number, number] => [
      a[0] + (b[0] - a[0]) * x,
      a[1] + (b[1] - a[1]) * x,
      a[2] + (b[2] - a[2]) * x,
    ] as [number, number, number];

    const sand    = [0.78, 0.71, 0.54];
    const coastal = [0.42, 0.35, 0.27];
    const green   = [0.18, 0.40, 0.12];
    const scrub   = [0.32, 0.27, 0.19];
    const rock    = [0.22, 0.19, 0.17];
    const ash     = [0.15, 0.13, 0.13];

    if (t < 0.04) return lerp(sand, coastal, t / 0.04);
    if (t < 0.25) return lerp(green, coastal, (t - 0.04) / 0.21);
    if (t < 0.55) return lerp(scrub, green, (t - 0.25) / 0.30);
    if (t < 0.80) return lerp(rock, scrub, (t - 0.55) / 0.25);
    return lerp(ash, rock, Math.min(1, (t - 0.80) / 0.20));
  }

  // ── Mesh generation ────────────────────────────────────────────────────────

  private buildIslandMesh(island: Island): void {
    const { scene } = this.sceneService;
    const polygon   = this.buildCoastlinePolygon(island);
    this.polygonCache.set(island.id, polygon);   // cache for collision checks

    const gridRes  = island.maxRadius > 3000 ? 80 : island.maxRadius > 1000 ? 56 : 36;
    const worldSize = island.maxRadius * 2.3;

    const mesh = MeshBuilder.CreateGround('island_' + island.id, {
      width:        worldSize,
      height:       worldSize,
      subdivisions: gridRes,
      updatable:    true,
    }, scene);

    mesh.position = new Vector3(island.centerX, 0, island.centerZ);

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const numVerts  = (gridRes + 1) * (gridRes + 1);
    const colors: number[] = [];

    for (let i = 0; i < numVerts; i++) {
      const localX = positions[i * 3];
      const localZ = positions[i * 3 + 2];
      const wx = island.centerX + localX;
      const wz = island.centerZ + localZ;
      const elevation = this.computeElevation(wx, wz, island, polygon);
      positions[i * 3 + 1] = elevation;

      const [r, g, b] = elevation > 0
        ? this.elevationColor(elevation, island.peakElevation)
        : [0.06, 0.14, 0.28];
      colors.push(r, g, b, 1.0);
    }

    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors, false);
    mesh.createNormals(true);

    const mat = new StandardMaterial('islandMat_' + island.id, scene);
    mat.specularColor = new Color3(0.04, 0.04, 0.04);
    mesh.material     = mat;

    // Add island to ocean render list for reflections
    this.oceanService.addToRenderList(mesh);
  }
}
