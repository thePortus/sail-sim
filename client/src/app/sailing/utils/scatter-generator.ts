import {
  Color3, DynamicTexture, Material, Mesh, MeshBuilder, Quaternion,
  Scene, StandardMaterial, Vector3,
} from '@babylonjs/core';

/**
 * Low-poly ground-scatter prototype meshes (rocks, grass tufts, beach grass,
 * driftwood, dead trees). Each returns a single mesh placed at the origin, meant
 * to be rendered via thin instances (one draw call for thousands of copies).
 * Caller is responsible for setting isVisible / alwaysSelectAsActiveMesh and
 * pushing the per-instance matrices.
 */

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0xffffffff; };
}

/** Crossed-quad grass tuft texture: thin tapering blades, transparent elsewhere. */
function makeBladeTexture(name: string, scene: Scene, palette: string[], seed: number): DynamicTexture {
  const S = 64;
  const tex = new DynamicTexture(name, { width: S, height: S }, scene, true);
  tex.hasAlpha = true;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, S, S);
  const rnd = makeRng(seed);
  const blades = 7;
  for (let i = 0; i < blades; i++) {
    const baseX = (i + 0.5) / blades * S + (rnd() - 0.5) * 6;
    const halfW = 1.5 + rnd() * 2.0;
    const height = S * (0.55 + rnd() * 0.42);
    const lean = (rnd() - 0.5) * 14;
    ctx.fillStyle = palette[(Math.floor(rnd() * palette.length)) % palette.length];
    ctx.beginPath();
    ctx.moveTo(baseX - halfW, S);
    ctx.lineTo(baseX + halfW, S);
    ctx.lineTo(baseX + lean, S - height);   // taper to a point at the tip
    ctx.closePath();
    ctx.fill();
  }
  tex.update();
  return tex;
}

/** Three crossed alpha-tested quads forming a tuft; base sits at y = 0. */
function makeCrossedTuft(name: string, scene: Scene, tex: DynamicTexture): Mesh {
  const planes: Mesh[] = [];
  for (let k = 0; k < 3; k++) {
    const p = MeshBuilder.CreatePlane(`${name}_p${k}`, { size: 1, sideOrientation: Mesh.DOUBLESIDE }, scene);
    p.rotation.y = (k * Math.PI) / 3;
    p.position.y = 0.5;               // lift so the base is at the ground
    p.bakeCurrentTransformIntoVertices();
    planes.push(p);
  }
  const merged = Mesh.MergeMeshes(planes, true, true, undefined, false, false)!;
  merged.name = name;

  const mat = new StandardMaterial(`${name}_mat`, scene);
  mat.diffuseTexture = tex;
  mat.diffuseTexture.hasAlpha = true;
  mat.useAlphaFromDiffuseTexture = true;
  mat.transparencyMode = Material.MATERIAL_ALPHATEST;
  mat.alphaCutOff = 0.35;
  mat.backFaceCulling = false;
  mat.specularColor = new Color3(0, 0, 0);
  mat.emissiveColor = new Color3(0.05, 0.07, 0.03);   // keeps foliage from going pure black in shade
  merged.material = mat;
  return merged;
}

/** Faceted low-poly boulder (unit radius — scale per instance). */
export function createRockProto(name: string, scene: Scene): Mesh {
  const rock = MeshBuilder.CreateIcoSphere(name, { radius: 1, subdivisions: 1, flat: true }, scene);
  const mat = new StandardMaterial(`${name}_mat`, scene);
  mat.diffuseColor = new Color3(0.40, 0.38, 0.36);
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  rock.material = mat;
  return rock;
}

/** Lush green grass tuft (~1 m tall at scale 1). */
export function createGrassProto(name: string, scene: Scene): Mesh {
  const tex = makeBladeTexture(`${name}_tex`, scene, ['#4a6b2a', '#5f8536', '#3c5a22', '#6f9440'], 1337);
  return makeCrossedTuft(name, scene, tex);
}

/** Pale, taller dune grass for the beach. */
export function createBeachGrassProto(name: string, scene: Scene): Mesh {
  const tex = makeBladeTexture(`${name}_tex`, scene, ['#a9a06a', '#bdb074', '#8f8a55', '#c8bd84'], 9001);
  return makeCrossedTuft(name, scene, tex);
}

/** A bleached driftwood log lying on its side (~2 m long at scale 1). */
export function createDriftwoodProto(name: string, scene: Scene): Mesh {
  const log = MeshBuilder.CreateCylinder(name, { height: 2, diameterTop: 0.26, diameterBottom: 0.34, tessellation: 6 }, scene);
  log.rotation.z = Math.PI / 2;          // lay it horizontal
  log.bakeCurrentTransformIntoVertices();
  const mat = new StandardMaterial(`${name}_mat`, scene);
  mat.diffuseColor = new Color3(0.52, 0.47, 0.40);
  mat.specularColor = new Color3(0.03, 0.03, 0.03);
  log.material = mat;
  return log;
}

/** A bare, weathered dead tree: trunk + a few angled branches. */
export function createDeadTreeProto(name: string, scene: Scene): Mesh {
  const parts: Mesh[] = [];
  const trunk = MeshBuilder.CreateCylinder(`${name}_trunk`, { height: 3.0, diameterTop: 0.10, diameterBottom: 0.30, tessellation: 6 }, scene);
  trunk.position.y = 1.5;
  trunk.bakeCurrentTransformIntoVertices();
  parts.push(trunk);
  const rnd = makeRng(4242);
  for (let i = 0; i < 4; i++) {
    const b = MeshBuilder.CreateCylinder(`${name}_b${i}`, { height: 1.2, diameterTop: 0.03, diameterBottom: 0.10, tessellation: 5 }, scene);
    b.rotation.z = (rnd() - 0.5) * 1.4;
    b.rotation.y = rnd() * Math.PI * 2;
    b.position.y = 1.8 + rnd() * 1.0;
    b.bakeCurrentTransformIntoVertices();
    parts.push(b);
  }
  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false)!;
  merged.name = name;
  const mat = new StandardMaterial(`${name}_mat`, scene);
  mat.diffuseColor = new Color3(0.36, 0.32, 0.28);
  mat.specularColor = new Color3(0, 0, 0);
  merged.material = mat;
  return merged;
}

/** Builds a yaw + optional slope-tilt quaternion (slope tilt via simple Euler). */
export function scatterRotation(yaw: number, tiltX: number, tiltZ: number): Quaternion {
  return Quaternion.RotationYawPitchRoll(yaw, tiltX, tiltZ);
}

export const SCATTER_UP = Vector3.Up();
