import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  Mesh,
  MeshBuilder,
  Vector3,
  VertexBuffer,
  StandardMaterial,
  Color3,
} from '@babylonjs/core';
import { Settings } from '../../app.settings';
import { TerrainManifest, TerrainWorldBounds } from '../models';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';

@Injectable({ providedIn: 'root' })
export class TerrainService {
  private readonly CHUNK_CONCURRENCY = 8;
  private readonly CHUNK_RETRIES = 2;

  private http = inject(HttpClient);
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);

  private manifest: TerrainManifest | null = null;
  private heightfield: Uint16Array | null = null;
  private terrainMesh: Mesh | null = null;

  async init(): Promise<void> {
    if (!this.manifest || !this.heightfield) {
      const manifest = await firstValueFrom(
        this.http.get<TerrainManifest>(`${Settings.apiUrl}terrain/manifest`),
      );

      this.manifest = manifest;
      this.heightfield = new Uint16Array(manifest.width * manifest.height);
      await this.loadAllChunks();
    }

    this.buildTerrainMesh();
  }

  isReady(): boolean {
    return !!this.manifest && !!this.heightfield;
  }

  dispose(): void {
    this.terrainMesh?.dispose();
    this.terrainMesh = null;
  }

  getManifest(): TerrainManifest | null {
    return this.manifest;
  }

  getWorldBounds(): TerrainWorldBounds {
    return this.manifest?.worldBounds ?? {
      minX: -25000,
      maxX: 25000,
      minZ: -25000,
      maxZ: 25000,
    };
  }

  getElevation(worldX: number, worldZ: number): number {
    if (!this.manifest || !this.heightfield) return 0;

    const { width, height, worldBounds, quantizationLevels, targetPeakElevation } = this.manifest;
    const px = ((worldX - worldBounds.minX) / (worldBounds.maxX - worldBounds.minX)) * (width - 1);
    const pz = ((worldBounds.maxZ - worldZ) / (worldBounds.maxZ - worldBounds.minZ)) * (height - 1);

    const x0 = Math.floor(px);
    const z0 = Math.floor(pz);
    const x1 = Math.min(width - 1, x0 + 1);
    const z1 = Math.min(height - 1, z0 + 1);

    const tx = px - x0;
    const tz = pz - z0;

    const h00 = this.sampleQuantized(x0, z0);
    const h10 = this.sampleQuantized(x1, z0);
    const h01 = this.sampleQuantized(x0, z1);
    const h11 = this.sampleQuantized(x1, z1);

    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    const hq = h0 + (h1 - h0) * tz;

    return (hq / quantizationLevels) * targetPeakElevation;
  }

  isOnLand(worldX: number, worldZ: number): boolean {
    return this.getElevation(worldX, worldZ) > 0.02;
  }

  nearestSpawn(worldX: number, worldZ: number): { spawnX: number; spawnZ: number; heading: number } {
    const manifest = this.manifest;
    if (!manifest || !manifest.spawns.length) {
      return { spawnX: 0, spawnZ: 0, heading: 270 };
    }

    let best = manifest.spawns[0];
    let bestDist = Infinity;
    for (const s of manifest.spawns) {
      const dx = worldX - s.x;
      const dz = worldZ - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist) {
        bestDist = d2;
        best = s;
      }
    }

    return { spawnX: best.x, spawnZ: best.z, heading: best.heading };
  }

  private buildTerrainMesh(): void {
    const scene = this.sceneService.scene;
    const manifest = this.manifest;
    if (!scene || !manifest || !this.heightfield) return;

    if (this.terrainMesh) {
      this.terrainMesh.dispose();
      this.terrainMesh = null;
    }

    const worldWidth = manifest.worldBounds.maxX - manifest.worldBounds.minX;
    const worldDepth = manifest.worldBounds.maxZ - manifest.worldBounds.minZ;
    const centerX = (manifest.worldBounds.minX + manifest.worldBounds.maxX) * 0.5;
    const centerZ = (manifest.worldBounds.minZ + manifest.worldBounds.maxZ) * 0.5;
    const subdivisions = Math.max(
      420,
      Math.min(640, Math.floor(Math.max(manifest.width, manifest.height) * 0.42)),
    );

    const mesh = MeshBuilder.CreateGround('terrain_heightfield', {
      width: worldWidth,
      height: worldDepth,
      subdivisions,
      updatable: true,
    }, scene);
    mesh.position.set(centerX, 0, centerZ);
    mesh.renderingGroupId = 2;

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const numVerts = (subdivisions + 1) * (subdivisions + 1);
    const colors: number[] = [];

    for (let i = 0; i < numVerts; i++) {
      const localX = positions[i * 3];
      const localZ = positions[i * 3 + 2];
      const wx = centerX + localX;
      const wz = centerZ + localZ;

      const elevation = this.getElevation(wx, wz);
      const y = elevation > 0 ? elevation : -2.2;
      positions[i * 3 + 1] = y;

      if (elevation <= 0) {
        colors.push(0.06, 0.14, 0.28, 1.0);
      } else {
        const t = elevation / manifest.targetPeakElevation;
        let r = 0.18;
        let g = 0.35;
        let b = 0.14;

        if (t < 0.03) {
          r = 0.78; g = 0.71; b = 0.54;
        } else if (t < 0.25) {
          r = 0.22; g = 0.44; b = 0.16;
        } else if (t < 0.55) {
          r = 0.34; g = 0.30; b = 0.22;
        } else if (t < 0.80) {
          r = 0.24; g = 0.21; b = 0.19;
        } else {
          r = 0.16; g = 0.14; b = 0.14;
        }
        colors.push(r, g, b, 1.0);
      }
    }

    mesh.updateVerticesData(VertexBuffer.PositionKind, positions, false);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors, false);
    mesh.createNormals(true);
    mesh.refreshBoundingInfo();

    const mat = new StandardMaterial('terrain_heightfield_mat', scene);
    mat.specularColor = new Color3(0.03, 0.03, 0.03);
    mat.zOffset = 4;
    mesh.material = mat;

    this.oceanService.addToRenderList(mesh);
    this.sceneService.shadowGenerator?.addShadowCaster(mesh, true);
    mesh.receiveShadows = true;

    this.terrainMesh = mesh;
  }

  private async loadAllChunks(): Promise<void> {
    const manifest = this.manifest;
    const heightfield = this.heightfield;
    if (!manifest || !heightfield) return;

    const jobs: Array<{ cz: number; cx: number }> = [];
    for (let cz = 0; cz < manifest.chunkCountZ; cz++) {
      for (let cx = 0; cx < manifest.chunkCountX; cx++) {
        jobs.push({ cz, cx });
      }
    }

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(this.CHUNK_CONCURRENCY, jobs.length) }, async () => {
      while (nextIndex < jobs.length) {
        const job = jobs[nextIndex++];
        await this.loadChunkWithRetry(job.cz, job.cx);
      }
    });

    await Promise.all(workers);
  }

  private async loadChunkWithRetry(cz: number, cx: number): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.CHUNK_RETRIES; attempt++) {
      try {
        await this.loadChunk(cz, cx);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === this.CHUNK_RETRIES) break;
        await this.delay(120 * (attempt + 1));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to load terrain chunk ${cz}/${cx}`);
  }

  private async loadChunk(cz: number, cx: number): Promise<void> {
    const manifest = this.manifest;
    const heightfield = this.heightfield;
    if (!manifest || !heightfield) return;

    const data = await firstValueFrom(
      this.http.get(`${Settings.apiUrl}terrain/chunk/${cz}/${cx}`, {
        responseType: 'arraybuffer',
      }),
    );

    const x0 = cx * manifest.chunkSize;
    const z0 = cz * manifest.chunkSize;
    const chunkW = Math.min(manifest.chunkSize, manifest.width - x0);
    const chunkH = Math.min(manifest.chunkSize, manifest.height - z0);

    const view = new DataView(data);
    let offset = 0;

    for (let z = 0; z < chunkH; z++) {
      for (let x = 0; x < chunkW; x++) {
        const q = view.getUint16(offset, true);
        offset += 2;
        const dstIdx = (z0 + z) * manifest.width + (x0 + x);
        heightfield[dstIdx] = q;
      }
    }
  }

  private sampleQuantized(px: number, pz: number): number {
    const manifest = this.manifest;
    const heightfield = this.heightfield;
    if (!manifest || !heightfield) return 0;

    const x = Math.max(0, Math.min(manifest.width - 1, px));
    const z = Math.max(0, Math.min(manifest.height - 1, pz));
    return heightfield[z * manifest.width + x];
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }
}
