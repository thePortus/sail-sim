import { Injectable, inject, signal } from '@angular/core';
import {
  Scene, TransformNode, Mesh, MeshBuilder, StandardMaterial, Color3, Observer,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { VesselService } from './vessel.service';

/**
 * Floating salvage crates (NPC Traders — NP4). When a merchant is sunk the server drops a crate at the wreck;
 * this renders a small bobbing crate there and, when the local ship sails within reach, asks the server to
 * collect it (server validates + awards). Server-authoritative: crates appear/disappear only on server
 * `salvage_spawn`/`salvage_despawn`/`salvage_snapshot`; this service just renders + requests.
 */
@Injectable({ providedIn: 'root' })
export class SalvageService {
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);
  private vesselService = inject(VesselService);

  private readonly COLLECT_R = 40;   // request a pickup within this many world units (server re-checks ≤ 60)

  private crates = new Map<string, { x: number; z: number; root: TransformNode; requested: boolean }>();
  private mat: StandardMaterial | null = null;
  private obs: Observer<Scene> | null = null;
  private scene: Scene | null = null;

  /** Set by MultiplayerService — sends a `salvage_collect` to the server. */
  sendCollect: ((crateId: string) => void) | null = null;
  /** Crate positions for the minimap. */
  readonly crateList = signal<{ id: string; x: number; z: number }[]>([]);

  /** Start the per-frame bob + proximity loop. Call once the scene exists. */
  init(scene: Scene): void {
    this.scene = scene;
    this.mat = new StandardMaterial('salvage_mat', scene);
    this.mat.diffuseColor = new Color3(0.45, 0.30, 0.16);
    this.mat.specularColor = new Color3(0.1, 0.1, 0.1);
    this.obs?.remove();
    this.obs = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  /** Server dropped a crate. */
  spawn(id: string, x: number, z: number): void {
    if (!this.scene || this.crates.has(id)) return;
    const root = new TransformNode('salvage_' + id, this.scene);
    root.position.set(x, 0, z);
    const box = MeshBuilder.CreateBox('salvage_box_' + id, { width: 2.4, height: 1.6, depth: 2.4 }, this.scene);
    box.material = this.mat;
    box.parent = root;
    box.isPickable = false;
    box.rotation.y = (x * 0.013 + z * 0.017) % Math.PI;   // varied yaw so they don't all face the same way
    this.crates.set(id, { x, z, root, requested: false });
    this.publish();
  }

  /** Server removed a crate (collected dry or expired). */
  despawn(id: string): void {
    const c = this.crates.get(id);
    if (!c) return;
    c.root.getChildMeshes(false).forEach((m) => m.dispose());
    c.root.dispose();
    this.crates.delete(id);
    this.publish();
  }

  /** Replace all crates from a server snapshot (on connect). */
  snapshot(list: { id: string; x: number; z: number }[]): void {
    for (const id of [...this.crates.keys()]) this.despawn(id);
    for (const c of list) this.spawn(c.id, c.x, c.z);
  }

  /** Tear down all crate meshes + the loop (on disconnect / scene teardown). */
  clear(): void {
    for (const id of [...this.crates.keys()]) this.despawn(id);
    this.obs?.remove(); this.obs = null;
    this.mat?.dispose(); this.mat = null;
    this.scene = null;
    this.crateList.set([]);
  }

  private publish(): void {
    this.crateList.set([...this.crates.entries()].map(([id, c]) => ({ id, x: c.x, z: c.z })));
  }

  private tick(): void {
    if (!this.crates.size) return;
    const t = this.oceanService.getOceanTime();
    const p = this.vesselService.getPosition();
    for (const [id, c] of this.crates) {
      c.root.position.y = this.oceanService.getWaveHeightAt(c.x, c.z, t) + 0.5;   // bob on the swell
      c.root.rotation.z = Math.sin(t * 0.9 + c.x * 0.01) * 0.12;                 // gentle rock
      const dx = c.x - p.x, dz = c.z - p.z, near = dx * dx + dz * dz <= this.COLLECT_R * this.COLLECT_R;
      if (near && !c.requested) { c.requested = true; this.sendCollect?.(id); }
      else if (!near && c.requested) { c.requested = false; }   // re-arm so re-entering (e.g. after making room) retries
    }
  }
}
