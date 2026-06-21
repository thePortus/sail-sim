import { Scene, DynamicTexture, StandardMaterial, Color3, MeshBuilder, Mesh, TransformNode } from '@babylonjs/core';
import type { VesselRig } from './vessel-controller';

/**
 * A small carved-and-gilded "nameboard" on a vessel's stern transom, showing the ship's name in 3D — the
 * historically correct place a ship's name was painted/carved. Built as a flat textured plane (DynamicTexture)
 * parented to the vessel root, so it banks + turns with the hull (NOT a billboard). One per local + remote
 * PLAYER vessel; the name updates in place on a rename.
 *
 * Placement comes from the vessel's `rig.nameboard` (root-local z/y + width/height), and can be nudged live
 * (no rebuild) via localStorage `ignis_nameboard_<slug>` = "z,y,width,height" — handy because the exact transom
 * spot is hard to eyeball per hull. Returns a handle to update the name or dispose it.
 */
export interface SternNameboardHandle {
  readonly mesh: Mesh;
  update(name: string): void;
  dispose(): void;
}

/** Paint the plank + gilded, engraved lettering (auto-fit) onto the board texture. */
function paint(tex: DynamicTexture, name: string): void {
  const { width: w, height: h } = tex.getSize();
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);

  // Dark varnished plank with a faint grain.
  const plank = ctx.createLinearGradient(0, 0, 0, h);
  plank.addColorStop(0, '#3a2614'); plank.addColorStop(0.5, '#27190c'); plank.addColorStop(1, '#190f06');
  ctx.fillStyle = plank; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) { const y = (h * i) / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // Gilt inner border.
  const bw = Math.max(3, h * 0.045);
  ctx.strokeStyle = '#c8a13c'; ctx.lineWidth = bw;
  ctx.strokeRect(bw, bw, w - 2 * bw, h - 2 * bw);

  // Carved gold lettering — auto-fit so long names shrink instead of clipping.
  const text = (name || 'Saltmeadow').toUpperCase();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const SERIF = 'Georgia, "Times New Roman", serif';
  const maxW = w * 0.84;
  let px = Math.floor(h * 0.5);
  ctx.font = `bold ${px}px ${SERIF}`;
  while (px > 12 && ctx.measureText(text).width > maxW) { px -= 2; ctx.font = `bold ${px}px ${SERIF}`; }
  const cy = h * 0.52;
  // Engraved shadow, then a vertical gold gradient fill → a struck-metal look.
  ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillText(text, w / 2 + 2, cy + 2);
  const gold = ctx.createLinearGradient(0, h * 0.28, 0, h * 0.72);
  gold.addColorStop(0, '#ffe9a8'); gold.addColorStop(0.5, '#d6ad4e'); gold.addColorStop(1, '#9c7a2a');
  ctx.fillStyle = gold; ctx.fillText(text, w / 2, cy);
  tex.update();
}

export function buildSternNameboard(
  scene: Scene, key: string, root: TransformNode, slug: string, rig: VesselRig, name: string,
): SternNameboardHandle | null {
  let spec = rig.nameboard;
  // Live override: localStorage ignis_nameboard_<slug> = "z,y,width,height".
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem('ignis_nameboard_' + slug);
    if (raw) {
      const [z, y, width, height] = raw.split(',').map((n) => parseFloat(n.trim()));
      if ([z, y, width, height].every((n) => Number.isFinite(n))) spec = { z, y, width, height };
    }
  } catch { /* ignore malformed override */ }
  if (!spec) return null;   // no transom placement for this hull → skip

  const tex = new DynamicTexture(key + '_tex', { width: 512, height: 144 }, scene, true);
  tex.hasAlpha = true;
  const mat = new StandardMaterial(key + '_mat', scene);
  mat.diffuseTexture  = tex;
  mat.backFaceCulling = false;                       // visible even if the facing guess is off (tunable)
  mat.specularColor   = new Color3(0.08, 0.08, 0.08);
  mat.emissiveColor   = new Color3(0.34, 0.30, 0.22); // stays legible in shadow / at dusk without glowing
  paint(tex, name);

  const mesh = MeshBuilder.CreatePlane(key, { width: spec.width, height: spec.height }, scene);
  mesh.material         = mat;
  mesh.parent           = root;
  mesh.isPickable       = false;
  mesh.receiveShadows   = false;
  mesh.renderingGroupId = 2;                          // same layer as the hull/ocean/vessels
  mesh.position.set(0, spec.y, spec.z);              // centred across the beam, on the transom
  mesh.rotation.y       = Math.PI;                    // face aft (−Z), away from the ship

  return {
    mesh,
    update(n: string) { paint(tex, n); },
    dispose() { mesh.dispose(); mat.dispose(); tex.dispose(); },
  };
}
