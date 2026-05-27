import { Color3, Color4, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { SolidParticleSystem } from '@babylonjs/core/Particles/solidParticleSystem';

export interface SpsTreeArchetypeOptions {
  seed: number;
  trunkHeight: number;
  trunkRadius: number;
  branchLevels: number;
  forksPerLevel: number;
  lengthDecay: number;
  radiusDecay: number;
  forkAngleMin: number;
  forkAngleMax: number;
  bowAmount: number;
  leafClusters: number;
  leafSizeMin: number;
  leafSizeMax: number;
  leafAspectMin: number;
  leafAspectMax: number;
  branchColor: Color4;
  leafColor: Color4;
}

type BranchSegment = {
  start: Vector3;
  end: Vector3;
  radiusStart: number;
  radiusEnd: number;
};

type LeafAnchor = {
  position: Vector3;
  direction: Vector3;
  size: number;
  aspect: number;
};

function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function alignYAxisTo(direction: Vector3): Quaternion {
  const dir = direction.normalize();
  const up = Vector3.Up();
  const dot = clamp(Vector3.Dot(up, dir), -1, 1);

  if (dot > 0.9999) {
    return Quaternion.Identity();
  }
  if (dot < -0.9999) {
    return Quaternion.RotationAxis(Vector3.Right(), Math.PI);
  }

  const axis = Vector3.Cross(up, dir).normalize();
  const angle = Math.acos(dot);
  return Quaternion.RotationAxis(axis, angle);
}

export function createSpsTreeArchetype(
  name: string,
  scene: Scene,
  options: SpsTreeArchetypeOptions,
): Mesh {
  const rng = makeRng(options.seed);
  const branchSegments: BranchSegment[] = [];
  const leafAnchors: LeafAnchor[] = [];

  const buildBranch = (
    start: Vector3,
    direction: Vector3,
    length: number,
    radius: number,
    level: number,
  ): void => {
    const dir = direction.normalize();
    const side = Vector3.Cross(dir, Math.abs(dir.y) > 0.85 ? Vector3.Forward() : Vector3.Up()).normalize();
    const bowSign = rng() > 0.5 ? 1 : -1;
    const segmentCount = Math.max(3, Math.round(3 + length * 0.35));
    let branchEnd = start.clone();

    for (let i = 0; i < segmentCount; i++) {
      const t0 = i / segmentCount;
      const t1 = (i + 1) / segmentCount;

      const bend0 = side.scale(Math.sin(t0 * Math.PI) * options.bowAmount * length * bowSign);
      const bend1 = side.scale(Math.sin(t1 * Math.PI) * options.bowAmount * length * bowSign);

      const p0 = start.add(dir.scale(length * t0)).add(bend0);
      const p1 = start.add(dir.scale(length * t1)).add(bend1);
      const r0 = radius * (1 - t0 * 0.7);
      const r1 = radius * (1 - t1 * 0.7);

      branchSegments.push({ start: p0, end: p1, radiusStart: Math.max(0.03, r0), radiusEnd: Math.max(0.02, r1) });
      branchEnd = p1;
    }

    const isTerminal = level >= options.branchLevels - 1;
    if (isTerminal) {
      const leaves = Math.max(3, Math.round(options.leafClusters * (0.7 + rng() * 0.8)));
      for (let i = 0; i < leaves; i++) {
        const jitter = new Vector3(
          (rng() - 0.5) * length * 0.24,
          (rng() - 0.2) * length * 0.22,
          (rng() - 0.5) * length * 0.24,
        );
        leafAnchors.push({
          position: branchEnd.add(jitter),
          direction: dir.add(new Vector3(rng() - 0.5, rng() * 0.8, rng() - 0.5)).normalize(),
          size: options.leafSizeMin + (options.leafSizeMax - options.leafSizeMin) * rng(),
          aspect: options.leafAspectMin + (options.leafAspectMax - options.leafAspectMin) * rng(),
        });
      }
      return;
    }

    const forks = Math.max(1, Math.round(options.forksPerLevel + (rng() - 0.5)));
    for (let i = 0; i < forks; i++) {
      const axis = Vector3.Cross(dir, new Vector3(rng() - 0.5, rng(), rng() - 0.5).normalize()).normalize();
      const forkAngle = options.forkAngleMin + (options.forkAngleMax - options.forkAngleMin) * rng();
      const spun = Quaternion.RotationAxis(dir, (rng() - 0.5) * Math.PI * 0.9);
      const forkRot = Quaternion.RotationAxis(axis, forkAngle).multiply(spun);
      const rotMatrix = Matrix.Identity();
      forkRot.toRotationMatrix(rotMatrix);
      const childDir = Vector3.TransformNormal(dir, rotMatrix).normalize();
      const childLen = length * options.lengthDecay * (0.78 + rng() * 0.38);
      const childRad = radius * options.radiusDecay * (0.82 + rng() * 0.28);
      buildBranch(branchEnd, childDir, childLen, childRad, level + 1);
    }
  };

  // Start from a slight random lean so archetypes feel less procedural.
  const trunkTilt = new Vector3((rng() - 0.5) * 0.12, 1, (rng() - 0.5) * 0.12).normalize();
  buildBranch(Vector3.Zero(), trunkTilt, options.trunkHeight, options.trunkRadius, 0);

  const branchUnit = MeshBuilder.CreateCylinder(`${name}_branchUnit`, {
    diameterTop: 1,
    diameterBottom: 1,
    height: 1,
    tessellation: 6,
  }, scene);
  const leafUnit = MeshBuilder.CreatePlane(`${name}_leafUnit`, {
    width: 1,
    height: 1,
    sideOrientation: Mesh.DOUBLESIDE,
  }, scene);

  const sps = new SolidParticleSystem(`${name}_sps`, scene, {
    isPickable: false,
    updatable: false,
  });

  sps.addShape(branchUnit, branchSegments.length, {
    positionFunction: (particle, index) => {
      const segment = branchSegments[index];
      if (!segment) {
        particle.position.setAll(0);
        particle.scaling.setAll(0.001);
        return;
      }
      const delta = segment.end.subtract(segment.start);
      const len = Math.max(0.01, delta.length());
      const dir = delta.scale(1 / len);

      particle.position = segment.start.add(segment.end).scale(0.5);
      particle.scaling.set(
        (segment.radiusStart + segment.radiusEnd) * 0.9,
        len,
        (segment.radiusStart + segment.radiusEnd) * 0.9,
      );
      particle.rotationQuaternion = alignYAxisTo(dir);
      particle.color = options.branchColor;
    },
  });

  sps.addShape(leafUnit, leafAnchors.length, {
    positionFunction: (particle, index) => {
      const leafIndex = index - branchSegments.length;
      const anchor = leafAnchors[leafIndex];
      if (!anchor) {
        particle.position.setAll(0);
        particle.scaling.setAll(0.001);
        return;
      }
      particle.position = anchor.position;
      particle.scaling.set(anchor.size * anchor.aspect, anchor.size, 1);
      particle.rotationQuaternion = alignYAxisTo(anchor.direction);
      particle.color = options.leafColor;
    },
  });

  const mesh = sps.buildMesh();
  const material = new StandardMaterial(`${name}_mat`, scene);
  material.diffuseColor = new Color3(1, 1, 1);
  material.specularColor = new Color3(0.04, 0.04, 0.04);
  material.emissiveColor = new Color3(0, 0, 0);
  material.disableLighting = false;

  mesh.material = material;
  mesh.useVertexColors = true;
  mesh.isPickable = false;

  branchUnit.dispose();
  leafUnit.dispose();
  sps.setParticles();

  return mesh;
}
