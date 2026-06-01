import { Injectable } from '@angular/core';
import {
  AssetContainer, SceneLoader, Scene, TransformNode, Quaternion, Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';   // registers GLB/GLTF plugin with SceneLoader
import { Settings } from '../../app.settings';

/**
 * Loads each vessel GLB **once** into an {@link AssetContainer}, then hands out
 * cheap instantiated clones on demand.  Both the local ship (VesselService) and
 * every remote player (MultiplayerService) draw from the same containers, so a
 * given GLB is fetched and GLTF-parsed a single time per session regardless of
 * how many vessels are on screen.
 *
 * Before this, each remote player re-imported all of its GLBs — N players meant
 * 4·N downloads and, worse, 4·N GLTF parses of the 1.2 MB hull.  Instantiating
 * from a container reuses the parsed geometry (shared GPU buffers) and shared
 * materials, so adding a player is nearly free.
 */
@Injectable({ providedIn: 'root' })
export class VesselAssetCacheService {
  private readonly baseUrl = Settings.apiUrl + 'geometry/';

  /** filename → in-flight or resolved container load. Promise is cached so
   *  concurrent callers for the same file dedupe onto one network request. */
  private readonly containers = new Map<string, Promise<AssetContainer>>();

  /** Cache-busting token appended as ?v=<version> to GLB URLs. 0 = no token
   *  (normal browser caching). Bumped by reloadAssets() so the browser refetches
   *  edited GLBs instead of serving the maxAge-cached copy. */
  private version = 0;

  /** Set the cache-bust version (server-supplied timestamp on /reloadassets). */
  setVersion(v: number): void { this.version = v || 0; }

  /** Load (or reuse) the AssetContainer for one GLB file. */
  private getContainer(filename: string, scene: Scene): Promise<AssetContainer> {
    let pending = this.containers.get(filename);
    if (!pending) {
      // Append ?v= so an edited GLB bypasses the browser's maxAge cache. Pass the
      // plugin extension explicitly ('.glb') so the query string doesn't break the
      // GLTF loader's extension sniffing.
      const url = this.version ? `${filename}?v=${this.version}` : filename;
      pending = SceneLoader.LoadAssetContainerAsync(this.baseUrl, url, scene, null, '.glb')
        .catch((err) => {
          // Drop the failed entry so a later attempt can retry rather than
          // forever resolving the rejected promise.
          this.containers.delete(filename);
          throw err;
        });
      this.containers.set(filename, pending);
    }
    return pending;
  }

  /**
   * Instantiate one GLB file's model into the scene, applying the same 180°
   * Y-flip the direct-import path used (bow faces +Z), parenting it to `parent`,
   * and tagging every instantiated mesh with renderingGroupId 2 (the world
   * layer used by terrain/ocean/vessels).
   *
   * @returns the instantiated root TransformNode, or null on load failure.
   */
  async instantiate(
    filename: string, scene: Scene, parent: TransformNode,
  ): Promise<TransformNode | null> {
    try {
      const container = await this.getContainer(filename, scene);

      // Clone the model. cloneMaterials=false → instances share one material
      // (and geometry buffers where possible) for minimal per-vessel cost.
      const entries = container.instantiateModelsToScene((n) => n, false);
      const root = entries.rootNodes[0] as TransformNode | undefined;
      if (!root) return null;

      // Compound the 180° Y-flip onto the loader's coordinate-conversion
      // rotation, exactly as the previous per-mesh import did.
      const flipY = Quaternion.RotationAxis(Vector3.Up(), Math.PI);
      root.rotationQuaternion = root.rotationQuaternion
        ? flipY.multiply(root.rotationQuaternion)
        : flipY;

      root.parent = parent;
      for (const m of root.getChildMeshes(false)) m.renderingGroupId = 2;

      return root;
    } catch (err) {
      console.warn(`[VesselAssetCache] instantiate failed: ${filename}`, err);
      return null;
    }
  }

  /** Dispose all cached containers (e.g. for a future /reloadassets command). */
  clearCache(): void {
    for (const pending of this.containers.values()) {
      pending.then((c) => c.dispose()).catch(() => { /* load failed; nothing to dispose */ });
    }
    this.containers.clear();
  }
}
