import { Scene, DynamicTexture, StandardMaterial, Color3, MeshBuilder, Mesh } from '@babylonjs/core';

/**
 * Shared ornate "brass plaque" billboard builder — the floating nameplate used for both ship callsigns/merchant
 * names (MultiplayerService) and harbour-town signs (HarborService). One source of truth for the look:
 *  • a near-opaque panel gradient (tinted by `baseColor`, or dark slate when null — slate is reserved for player
 *    characters), a dark rim + brass double border + corner rivets;
 *  • bold serif text with a dark outline + drop shadow, AUTO-FIT (font shrinks) so long names never clip;
 *  • single big centred line when `subtitle` is omitted, else a two-line name-over-tag layout.
 * Returns the unparented billboard plane (renderingGroupId 2, BILLBOARDMODE_ALL); the caller positions/scales it.
 */
export interface NameplateOpts {
  title: string;
  subtitle?: string;          // present → two-line plaque; absent → one big centred line
  baseColor?: string | null;  // null → dark slate (player); '#rrggbb' → tinted panel (nation / town)
  accentColor?: string;       // present → border + rivets + subtitle use this colour instead of brass (pirate red)
  width: number;
  height: number;
  kind?: 'ship' | 'town';     // 'ship' (default): rounded brass plaque. 'town': swallowtail wooden banner — a
                              //  distinct silhouette + border so a port reads differently from a vessel at a glance.
}

/** Darken/lighten a #rrggbb colour by a factor (1 = unchanged). Returns an rgb() string. */
function shadeColor(hex: string, f: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) { return hex; }
  const n = parseInt(m[1], 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

export function buildNameplate(scene: Scene, name: string, o: NameplateOpts): Mesh {
  const texW = 1152, texH = 320;   // LOGICAL drawing space — all constants below are in these units
  const tinted = !!o.baseColor;

  // Rasterise that logical layout to a SMALLER backing texture (SS<1) to cut VRAM + fill — the plane keeps its
  // big world size, the text just comes from fewer texels. ctx.scale keeps every drawing constant unchanged.
  // Mipmaps on → the plate stays clean (no shimmer) when the billboard is scaled down at distance.
  const SS = 0.667;
  const tex = new DynamicTexture(name + '_tex', { width: Math.round(texW * SS), height: Math.round(texH * SS) }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.scale(SS, SS);
  ctx.clearRect(0, 0, texW, texH);

  const town = o.kind === 'town';
  const pad = 14, rad = 46, notch = 50;
  // Outline path at the given inset — a rounded rect for ships, a swallowtail (pennant-notched) banner for towns.
  const outline = (inset: number) => {
    const x = pad + inset, y = pad + inset, w = texW - 2 * (pad + inset), h = texH - 2 * (pad + inset);
    if (town) {
      const nn = notch;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w - nn, y + h / 2);   // right swallowtail notch (V cut inward)
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x + nn, y + h / 2);       // left swallowtail notch
      ctx.closePath();
    } else {
      const r = Math.max(8, rad - inset);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y,     x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x,     y + h, r);
      ctx.arcTo(x,     y + h, x,     y,     r);
      ctx.arcTo(x,     y,     x + w, y,     r);
      ctx.closePath();
    }
  };

  // Theme: tinted by nation/town (background indicates allegiance), or dark slate for players. Kept dark so cream
  // text stays high-contrast even on bright nations (Spanish yellow) and the plate reads against a white sky.
  const base = o.baseColor || '#1a2740';
  const top  = tinted ? shadeColor(base, 0.92) : '#26375a';
  const bot  = tinted ? shadeColor(base, 0.36) : '#090e18';

  // Panel — vertical gradient fill (near-opaque so a bright sky can't wash it out).
  outline(0);
  const fill = ctx.createLinearGradient(0, pad, 0, texH - pad);
  fill.addColorStop(0, top); fill.addColorStop(1, bot);
  ctx.globalAlpha = 0.96; ctx.fillStyle = fill; ctx.fill(); ctx.globalAlpha = 1;

  // Double border (BRASS for ships, dark WOOD for towns → distinct at a glance) over a dark halo rim that
  // separates the plate from a white sky.
  ctx.lineJoin = 'round';
  outline(0);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 16; ctx.stroke();   // dark halo rim
  outline(0);
  const accent = o.accentColor;
  const edge = ctx.createLinearGradient(0, 0, 0, texH);
  if (accent)     { edge.addColorStop(0, shadeColor(accent, 1.25)); edge.addColorStop(0.5, accent); edge.addColorStop(1, shadeColor(accent, 0.5)); }
  else if (town)  { edge.addColorStop(0, '#9a7647'); edge.addColorStop(0.5, '#5e4022'); edge.addColorStop(1, '#33220f'); }
  else            { edge.addColorStop(0, '#f7e9ad'); edge.addColorStop(0.5, '#c8a13c'); edge.addColorStop(1, '#7d6020'); }
  ctx.strokeStyle = edge; ctx.lineWidth = 11; ctx.stroke();
  outline(16);
  ctx.strokeStyle = accent ? 'rgba(255,150,150,0.6)' : (town ? 'rgba(226,196,142,0.5)' : 'rgba(247,233,173,0.55)'); ctx.lineWidth = 3; ctx.stroke();
  // Corner rivets on the brass (or pirate-red) ship plate only (the town banner's silhouette is its signature).
  if (!town) {
    for (const [sx, sy] of [[pad + 28, pad + 28], [texW - pad - 28, pad + 28],
                            [pad + 28, texH - pad - 28], [texW - pad - 28, texH - pad - 28]]) {
      ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.fillStyle = accent ? shadeColor(accent, 1.2) : '#ecd793'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(60,40,10,0.7)'; ctx.stroke();
    }
  }

  // Text — bold serif (engraved-nameplate feel) with a dark outline + drop shadow for readability on any hull/sky.
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
  const ls = (v: string) => { try { (ctx as unknown as { letterSpacing: string }).letterSpacing = v; } catch { /* unsupported → ignore */ } };
  const SERIF = 'Georgia, "Times New Roman", serif';
  const innerW = texW - 2 * (pad + 16) - (town ? 2 * notch + 30 : 40);   // usable text width (towns lose the notch ends)
  // Largest font (≤ maxPx) at which `s` fits innerW — so long names/tags shrink to fit instead of clipping.
  const fit = (s: string, maxPx: number, minPx: number): number => {
    let px = maxPx;
    ctx.font = `bold ${px}px ${SERIF}`;
    while (px > minPx && ctx.measureText(s).width > innerW) { px -= 3; ctx.font = `bold ${px}px ${SERIF}`; }
    return px;
  };
  const draw = (s: string, y: number, px: number, col: string, ow: number) => {
    ctx.font = `bold ${px}px ${SERIF}`;
    ctx.lineWidth = ow; ctx.strokeStyle = 'rgba(8,14,24,0.92)'; ctx.strokeText(s, texW / 2, y);
    ctx.fillStyle = col; ctx.fillText(s, texW / 2, y);
  };

  if (o.subtitle) {
    ctx.textBaseline = 'alphabetic';
    ls('3px'); draw(o.title, 162, fit(o.title, 116, 44), '#fff6df', 10);
    ls('2px'); draw(o.subtitle, 250, fit(o.subtitle, 58, 28), accent ? shadeColor(accent, 1.5) : '#ffe9b0', 8);
  } else {
    ctx.textBaseline = 'middle';
    ls('5px'); draw(o.title, texH / 2 + 6, fit(o.title, 150, 52), '#fdf6e3', 13);
  }
  ls('0px');
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  tex.update();
  tex.hasAlpha = true;

  const mat = new StandardMaterial(name + '_mat', scene);
  mat.diffuseTexture             = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.backFaceCulling            = false;
  mat.disableLighting            = true;
  mat.emissiveColor              = new Color3(1, 1, 1);

  const plane = MeshBuilder.CreatePlane(name + '_plane', { width: o.width, height: o.height }, scene);
  plane.billboardMode    = Mesh.BILLBOARDMODE_ALL;
  plane.isPickable       = false;
  plane.material         = mat;
  // Group 2 = same layer as terrain/ocean-near/vessels — the shared depth buffer keeps it above the hull but
  // hidden behind hills (the default group 0 would let foreground ocean/terrain paint over it).
  plane.renderingGroupId = 2;
  // WebGPU cold-start guard: a label first built during the intro camera swoop can reach the render loop before
  // its StandardMaterial effect has finished compiling — bindForSubMesh then binds a NULL effect and the whole
  // frame throws (`TypeError: Cannot read properties of null (reading 'setFloat4')`, a transparent-pass freeze).
  // Keep the plane invisible until the effect is actually compiled (forceCompilation pre-warms it off the render
  // path). Callers gate display via setEnabled — a SEPARATE flag — so this composes cleanly: a label shows only
  // once both compiled (isVisible) and in-range (isEnabled).
  mat.allowShaderHotSwapping = false;
  plane.isVisible = false;
  mat.forceCompilation(plane, () => { if (!plane.isDisposed()) plane.isVisible = true; });
  return plane;
}
