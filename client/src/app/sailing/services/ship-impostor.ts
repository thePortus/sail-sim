/**
 * Distant-ship impostor: an AZIMUTHAL billboard LOD for remote players + NPC merchants. Ships move and turn,
 * so a fixed billboard won't read right — instead we bake N horizon-level views around each hull (see
 * ship_impostor_bake.py → geometry/ship_impostors/<slug>_atlas.png, a 1×N strip) and pick the cell matching
 * the angle the camera views the ship from RELATIVE to its heading. The quad is a camera-facing billboard
 * (BILLBOARDMODE_Y); the atlas cell is chosen per frame. One full rigged GLB → one alpha-tested quad far off.
 *
 * The atlas Texture is shared per ship-type (loaded once, cached); each ship gets its own tiny ShaderMaterial
 * holding its per-frame UV offset (so they don't fight over one shared texture transform, and disposing a ship
 * never frees the shared atlas). GLSL — Babylon transpiles to WGSL; the sample uses textureLod (WGSL-legal).
 */
import { Effect, Mesh, MeshBuilder, Scene, ShaderMaterial, Texture, Vector2 } from '@babylonjs/core';
import { Settings } from '../../app.settings';

export interface ShipImpostorAtlas { tex: Texture; size: number; centerY: number; n: number; cols: number; }
export interface ShipImpostor { mesh: Mesh; mat: ShaderMaterial; atlas: ShipImpostorAtlas; cell: number; calib: number; }

const BASE = `${Settings.apiUrl}geometry/ship_impostors/`;

// Calibration mapping the baked atlas azimuths to in-game heading. If ships face the wrong way, tune these
// (degrees / ±1) — overridable live via localStorage for quick iteration without a rebuild.
const CALIB_DEG = +(localStorage.getItem('ignis_shipimp_calib') ?? '0');
const CALIB_DIR = +(localStorage.getItem('ignis_shipimp_dir') ?? '1') < 0 ? -1 : 1;
// Per-slug bow offset: the bake loads the RAW GLB (no runtime importFlipY), so a model authored bow-reversed
// vs the others bakes a 180°-rotated atlas and reads "sailing backwards". The brig's GLB is one such — give it
// a half-turn. Override any slug live with localStorage ignis_shipimp_calib_<slug> (degrees) if one's still off.
// merchantman: its atlas was rendered straight from the .blend (bow = Blender +X) rather than an imported
// glTF like the others, so cell 0 lands on the PORT beam not the bow — a −90° correction (best analytic
// guess; tune live via ignis_shipimp_calib_merchantman if it reads off).
const CALIB_DEG_BY_SLUG: Record<string, number> = { brig: 180, merchantman: -90 };
function calibRadFor(slug: string): number {
  const per = localStorage.getItem('ignis_shipimp_calib_' + slug);
  const deg = per !== null ? +per : CALIB_DEG + (CALIB_DEG_BY_SLUG[slug] ?? 0);
  return (deg * Math.PI) / 180;
}

let manifestPromise: Promise<Record<string, { size: number; centerY: number; n: number; cols: number }>> | null = null;
const atlasCache = new Map<string, ShipImpostorAtlas | null>();

const SHADER_NAME = 'shipImpostor';
let shaderRegistered = false;
function registerShader(): void {
  if (shaderRegistered) return;
  Effect.ShadersStore[`${SHADER_NAME}VertexShader`] = `
    precision highp float;
    attribute vec3 position; attribute vec2 uv;
    uniform mat4 worldViewProjection;
    varying vec2 vUV;
    void main(void) { vUV = uv; gl_Position = worldViewProjection * vec4(position, 1.0); }`;
  Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D atlas;
    uniform vec2 uUvOffset;   // cell origin in the 1xN strip
    uniform vec2 uUvScale;    // (1/cols, 1)
    void main(void) {
      vec2 uv = uUvOffset + vUV * uUvScale;
      vec4 c = textureLod(atlas, uv, 0.0);   // explicit LOD -> valid WGSL
      if (c.a < 0.4) discard;
      gl_FragColor = vec4(c.rgb, 1.0);
    }`;
  shaderRegistered = true;
}

function loadManifest(): Promise<Record<string, { size: number; centerY: number; n: number; cols: number }>> {
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE}ship_impostors_manifest.json`)
      .then(r => r.json()).then(j => j?.ships ?? {}).catch(() => ({}));
  }
  return manifestPromise;
}

/** Load (and cache) the shared atlas for a ship slug. null if there's no impostor for it. */
export async function getShipImpostorAtlas(scene: Scene, slug: string): Promise<ShipImpostorAtlas | null> {
  if (atlasCache.has(slug)) return atlasCache.get(slug) ?? null;
  const ships = await loadManifest();
  const m = ships[slug];
  if (!m) { atlasCache.set(slug, null); return null; }
  const tex = new Texture(`${BASE}${slug}_atlas.png`, scene, undefined, undefined, Texture.TRILINEAR_SAMPLINGMODE);
  tex.hasAlpha = true;
  const atlas: ShipImpostorAtlas = { tex, size: m.size, centerY: m.centerY ?? m.size * 0.4, n: m.n, cols: m.cols };
  atlasCache.set(slug, atlas);
  return atlas;
}

/** Build one ship's impostor quad (camera-facing billboard) sharing the type's atlas. Disabled initially. */
export function createShipImpostor(scene: Scene, slug: string, atlas: ShipImpostorAtlas): ShipImpostor {
  registerShader();
  const mat = new ShaderMaterial(`shipimp_${slug}_${Math.floor(scene.getUniqueId())}`, scene,
    { vertex: SHADER_NAME, fragment: SHADER_NAME },
    { attributes: ['position', 'uv'], uniforms: ['worldViewProjection', 'uUvOffset', 'uUvScale'], samplers: ['atlas'] });
  mat.setTexture('atlas', atlas.tex);
  mat.setVector2('uUvOffset', new Vector2(0, 0));
  mat.setVector2('uUvScale', new Vector2(1 / atlas.cols, 1));
  mat.backFaceCulling = false;

  const mesh = MeshBuilder.CreatePlane(`shipimp_${slug}`, { width: atlas.size, height: atlas.size }, scene);
  mesh.material = mat;
  mesh.billboardMode = Mesh.BILLBOARDMODE_Y;          // upright, yaw to camera
  mesh.renderingGroupId = 2;                          // world layer (terrain/ocean/vessels)
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;              // positioned each frame; skip cull churn
  mesh.metadata = { excludeFromRefraction: true };
  mesh.setEnabled(false);
  return { mesh, mat, atlas, cell: -1, calib: calibRadFor(slug) };
}

/** Per frame (while impostored): place the billboard at the ship + select the atlas cell for the view angle. */
export function updateShipImpostor(
  imp: ShipImpostor, x: number, y: number, z: number, headingRad: number, camX: number, camZ: number,
): void {
  imp.mesh.position.set(x, y + imp.atlas.centerY, z);
  // Azimuth the camera views the ship FROM, relative to the ship's heading (atan2(x,z) = heading convention).
  const viewAz = Math.atan2(camX - x, camZ - z);
  let rel = (viewAz - headingRad) * CALIB_DIR + imp.calib;
  rel /= (2 * Math.PI);
  const n = imp.atlas.n;
  let cell = Math.round(rel * n) % n;
  cell = ((cell % n) + n) % n;
  if (cell !== imp.cell) {
    imp.cell = cell;
    imp.mat.setVector2('uUvOffset', new Vector2(cell / imp.atlas.cols, 0));
  }
}
