import {
  AssetContainer, Color3, Material, Matrix, Mesh, MeshBuilder, PBRMaterial, Scene, SceneLoader,
  StandardMaterial, Texture,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { Settings } from '../../../app.settings';

/**
 * Streaming loader + cache for the authored scatter GLBs (palms / beech / rocks / driftwood). Assets
 * are served from the API server's `geometry/scatter/` endpoint (same origin + delivery as the
 * vessels), so the `/reloadassets` owner command can hot-swap edited GLBs live. This keeps a tiny
 * load-once container cache: each GLB is fetched ONCE, then thin-instanced for the whole world.
 */

/** Base URL for scatter GLBs + textures (server geometry endpoint — matches the vessel cache). */
const SCATTER_BASE = Settings.apiUrl + 'geometry/scatter/';

/** Cache-busting token appended as ?v=<version> (set by /reloadassets so the browser refetches edited
 *  GLBs/textures instead of serving the maxAge-cached copy). 0 = no token (normal caching). */
let version = 0;

/** Set the cache-bust version (server-supplied timestamp on /reloadassets). */
export function setScatterVersion(v: number): void { version = v || 0; }

function withV(url: string): string { return version ? `${url}?v=${version}` : url; }

/** Full URL for a scatter texture (impostor / albedo / normal), with the cache-bust token. */
export function scatterTextureUrl(name: string): string { return withV(`${SCATTER_BASE}textures/${name}`); }

/** filename → in-flight or resolved container load (load-once). */
const containerCache = new Map<string, Promise<AssetContainer>>();

function loadContainer(scene: Scene, file: string): Promise<AssetContainer> {
  let p = containerCache.get(file);
  if (!p) {
    p = SceneLoader.LoadAssetContainerAsync(SCATTER_BASE, withV(file), scene, null, '.glb');
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
  mat.albedoTexture = new Texture(scatterTextureUrl(albedoFile), scene);
  mat.bumpTexture = new Texture(scatterTextureUrl(normalFile), scene, false, false);  // linear
  mat.metallic = 0.0;
  mat.roughness = 0.9;
  mat.invertNormalMapY = false;   // OpenGL-convention normal map (green = +Y)
  mat.invertNormalMapX = false;
  return mat;
}

/**
 * Load a GEOMETRY-ONLY scatter GLB (rocks / driftwood / grass), assign the SHARED material, and return
 * a hidden, thin-instanceable base mesh. `vertexColors` controls how COLOR_0 is treated:
 *  - true (rocks/driftwood): baked AO that multiplies albedo (the opposite of the trees, and it avoids
 *    the WebGPU colour-attribute issue entirely),
 *  - false (grass): COLOR_0 is WIND data, NOT colour — keep it off so it can't tint the blades.
 * Opaque (no alpha-test). Normals/tangents left untouched. Returns null on failure.
 */
export async function loadScatterGeometry(
  scene: Scene, file: string, name: string, material: Material, vertexColors = true,
): Promise<Mesh | null> {
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
    mesh.useVertexColors = vertexColors;
    return mesh;
  } catch (err) {
    console.warn(`[scatter] loadScatterGeometry failed: ${file}`, err);
    return null;
  }
}

/**
 * Shared grass material — matte, DOUBLE-SIDED (blades are thin geometry seen from both sides), lit by
 * the base→tip gradient albedo (UV V = base→tip). No normal map, no alpha (opaque blades → no sort
 * cost). COLOR_0 is wind data, so the mesh loads with useVertexColors=false; per-instance tint comes
 * from the thin-instance colour buffer.
 */
export function buildGrassMaterial(scene: Scene, name: string, albedoFile: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseTexture = new Texture(scatterTextureUrl(albedoFile), scene);
  mat.specularColor = new Color3(0, 0, 0);   // matte foliage
  mat.backFaceCulling = false;               // double-sided blades
  mat.twoSidedLighting = true;               // shade blade backs too (no black undersides)
  return mat;
}

/** Drop all cached scatter containers (e.g. on an asset reload). */
export function clearScatterCache(): void { containerCache.clear(); }
