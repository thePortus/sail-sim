import {
  AssetContainer, Color3, Material, Matrix, Mesh, MeshBuilder, PBRMaterial, Scene, SceneLoader,
  StandardMaterial, Texture,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';

/**
 * Streaming loader + cache for the authored scatter GLBs (palms now; beech/rocks/driftwood/grass
 * next). Scatter assets are static client files under `public/assets/scatter/` (NOT the API-server
 * geometry endpoint the vessel cache uses), so this has its own tiny load-once container cache:
 * each variant GLB is fetched ONCE, then thin-instanced for the whole world.
 */

/** Base URL for scatter GLBs + impostor textures (served statically from public/assets/scatter/). */
const SCATTER_BASE = '/assets/scatter/';

/** filename → in-flight or resolved container load (load-once). */
const containerCache = new Map<string, Promise<AssetContainer>>();

function loadContainer(scene: Scene, file: string): Promise<AssetContainer> {
  let p = containerCache.get(file);
  if (!p) {
    p = SceneLoader.LoadAssetContainerAsync(SCATTER_BASE, file, scene, null, '.glb');
    containerCache.set(file, p);
  }
  return p;
}

/**
 * Load one authored scatter GLB and return a single hidden, thin-instanceable base mesh, with the
 * material/mesh setup the Blender assets require:
 *  - alpha-TEST fronds (EEVEE exports alphaMode BLEND, which sorts wrong when instanced),
 *  - `useVertexColors = false` (COLOR_0 carries baked WIND data, not albedo tint — leaving it on
 *    turns the trees red/green),
 *  - normals left UNTOUCHED (baked domed-canopy normals — recomputing destroys the soft lighting).
 * The container is cached, so calling again for the same file reuses the fetch.
 * Returns null on failure (caller falls back to the procedural primitive).
 */
export async function loadScatterMesh(scene: Scene, file: string, name: string): Promise<Mesh | null> {
  try {
    const container = await loadContainer(scene, file);
    const entries = container.instantiateModelsToScene((n) => n, false);
    const root = entries.rootNodes[0];
    const mesh = root.getChildMeshes(false).find((m) => m.getTotalVertices() > 0) as Mesh | undefined;
    if (!mesh) { entries.dispose(); return null; }
    // Detach from the glTF __root__ (which carries the Y-up/handedness conversion), keeping the world
    // transform, then bake it so the mesh stands correctly with an identity transform. Unique geometry
    // first so we never mutate the cached container's shared buffers.
    mesh.setParent(null);
    mesh.makeGeometryUnique();
    mesh.bakeCurrentTransformIntoVertices();
    root.dispose();
    mesh.name = name;
    mesh.isVisible = false;
    mesh.useVertexColors = false;            // COLOR_0 = wind data, NOT colour
    const mat = mesh.material;
    if (mat) {
      mat.transparencyMode = Material.MATERIAL_ALPHATEST;
      // GLB material is a PBRMaterial; type loosely (the exact class varies across exporters).
      const m = mat as unknown as {
        alphaCutOff: number; backFaceCulling: boolean; useAlphaFromAlbedoTexture: boolean;
        albedoTexture: { hasAlpha: boolean } | null;
      };
      m.alphaCutOff = 0.4;
      m.backFaceCulling = false;             // fronds are double-sided cards
      if (m.albedoTexture) { m.albedoTexture.hasAlpha = true; m.useAlphaFromAlbedoTexture = true; }
    }
    return mesh;
  } catch (err) {
    console.warn(`[scatter] loadScatterMesh failed: ${file}`, err);
    return null;
  }
}

/**
 * Build a cheap distance-LOD impostor: 3 quads crossed 60° apart around Y, each mapped to the full
 * pre-lit impostor image (alpha-tested, unlit so the baked lighting shows directly). Stands base at
 * y=0 at the given real-world height; thin-instanced like the full mesh, with NO per-instance
 * billboard needed (a 3-way cross reads fine from the near-horizontal angles you sail at). Hidden by
 * default (the PatchManager clones it per far patch).
 */
export function createCrossImpostor(scene: Scene, name: string, tex: Texture, width: number, height: number): Mesh {
  const planes: Mesh[] = [];
  for (let k = 0; k < 3; k++) {
    const q = MeshBuilder.CreatePlane(`${name}_q${k}`, { width, height }, scene);
    q.bakeTransformIntoVertices(Matrix.Translation(0, height / 2, 0));   // base at y=0
    q.rotation.y = (k / 3) * Math.PI;                                    // 0°, 60°, 120°
    q.bakeCurrentTransformIntoVertices();
    planes.push(q);
  }
  const merged = Mesh.MergeMeshes(planes, true, true, undefined, false, false);
  if (!merged) { return planes[0]; }
  merged.name = name;
  merged.isVisible = false;

  tex.hasAlpha = true;
  const mat = new StandardMaterial(`${name}_mat`, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;               // pre-lit impostor: show the baked image directly
  mat.diffuseColor = new Color3(0, 0, 0);
  mat.disableLighting = true;
  mat.transparencyMode = Material.MATERIAL_ALPHATEST;
  mat.alphaCutOff = 0.4;
  mat.backFaceCulling = false;
  mat.useAlphaFromDiffuseTexture = true;
  merged.material = mat;
  return merged;
}

/**
 * Build the shared normal-mapped stone PBR material for the rocks. The rock GLBs are GEOMETRY-ONLY and
 * all share these two textures (neutral-gray albedo + tileable rocky normal), so we load them ONCE here
 * and assign this one material to every shape + LOD. Per-instance tint (thin-instance colour buffer)
 * multiplies on top of the baked-AO vertex colour, turning the neutral stone into granite/sandstone/etc.
 */
export function buildScatterPBR(scene: Scene, name: string, albedoFile: string, normalFile: string): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoTexture = new Texture(`/assets/scatter/textures/${albedoFile}`, scene);
  mat.bumpTexture = new Texture(`/assets/scatter/textures/${normalFile}`, scene, false, false);  // linear
  mat.metallic = 0.0;
  mat.roughness = 0.9;
  mat.invertNormalMapY = false;   // OpenGL-convention normal map (green = +Y)
  mat.invertNormalMapX = false;
  return mat;
}

/**
 * Load a GEOMETRY-ONLY scatter GLB (rocks now), assign the SHARED material, and keep its baked-AO
 * vertex colour ON (`useVertexColors = true` — COLOR_0 multiplies albedo, the opposite of the trees,
 * and it avoids the WebGPU colour-attribute issue entirely). Opaque (no alpha-test). Normals/tangents
 * left untouched. Returns a hidden, thin-instanceable base mesh, or null on failure.
 */
export async function loadScatterGeometry(scene: Scene, file: string, name: string, material: Material): Promise<Mesh | null> {
  try {
    const container = await loadContainer(scene, file);
    const entries = container.instantiateModelsToScene((n) => n, false);
    const root = entries.rootNodes[0];
    const mesh = root.getChildMeshes(false).find((m) => m.getTotalVertices() > 0) as Mesh | undefined;
    if (!mesh) { entries.dispose(); return null; }
    mesh.setParent(null);
    mesh.makeGeometryUnique();
    mesh.bakeCurrentTransformIntoVertices();
    root.dispose();
    mesh.name = name;
    mesh.isVisible = false;
    mesh.material = material;
    mesh.useVertexColors = true;     // COLOR_0 = baked AO, multiplies albedo
    return mesh;
  } catch (err) {
    console.warn(`[scatter] loadScatterGeometry failed: ${file}`, err);
    return null;
  }
}

/** Drop all cached scatter containers (e.g. on an asset reload). */
export function clearScatterCache(): void { containerCache.clear(); }
