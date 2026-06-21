import { Scene, Color3, StandardMaterial, Material, AbstractMesh, TransformNode } from '@babylonjs/core';

/**
 * Player-customizable FLAG colour. Each vessel's flags carry a baked texture / vertex colour (a red ensign, a
 * nation pennant…); this overrides them with a flat cloth material in the player's chosen RGB, per-vessel, so a
 * captain flies their own colours. Detected across all three hulls by mesh name OR material name (the flag is a
 * named mesh on the sloop — Mast_Flag/Mast_Pennant — and a dedicated material on the others — FLAG_RED on the
 * pinnace, SHIP_FLAG on the brig). The replacement material is UNIQUE per vessel (so each ship tints
 * independently) and freed by the handle's dispose().
 */
export interface FlagColorHandle {
  setColor(color: Color3): void;
  dispose(): void;
}

/** A mesh is a flag if its name OR its material's name looks flag-like. Covers all three vessels. */
function isFlagMesh(m: AbstractMesh): boolean {
  if (m.getTotalVertices() <= 0) return false;
  const nm = m.name || '';
  const mat = m.material?.name || '';
  return /flag|pennant|ensign|burgee/i.test(nm) || /flag/i.test(mat);
}

/** Parse '#rrggbb' → Color3 (falls back to a deep red on garbage). */
export function flagColor3(hex: string | null | undefined): Color3 {
  if (typeof hex === 'string' && /^#?[0-9a-fA-F]{6}$/.test(hex.trim())) return Color3.FromHexString(hex.trim().startsWith('#') ? hex.trim() : '#' + hex.trim());
  return Color3.FromHexString('#b22222');
}

export function applyFlagColor(
  scene: Scene, root: TransformNode, color: Color3, opts: { excludeFromPrePass?: (m: Material) => void } = {},
): FlagColorHandle {
  const mats: StandardMaterial[] = [];
  for (const m of root.getChildMeshes(false)) {
    if (!isFlagMesh(m)) continue;
    // A fresh, per-vessel cloth material: flat colour (overrides the baked texture/vertex colour), a little
    // self-lit so it stays legible at dusk / in shadow, two-sided so the flag reads from either side.
    const mat = new StandardMaterial('flag_' + m.uniqueId, scene);
    mat.diffuseColor    = color;
    mat.emissiveColor   = color.scale(0.28);
    mat.specularColor   = new Color3(0.04, 0.04, 0.04);
    mat.backFaceCulling = false;
    mat.fogEnabled      = false;          // mirror the ship materials (WebGPU varying budget / fog wash)
    opts.excludeFromPrePass?.(mat);
    m.material = mat;                       // shared original material is left intact for other vessels
    mats.push(mat);
  }
  return {
    setColor(c: Color3) { for (const mt of mats) { mt.diffuseColor = c; mt.emissiveColor = c.scale(0.28); } },
    dispose() { for (const mt of mats) mt.dispose(); mats.length = 0; },
  };
}
