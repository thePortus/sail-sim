import {
  Effect, Scene, ShaderMaterial, Texture, Vector3,
} from '@babylonjs/core';

/**
 * Grass blade material — Simon-Dev-style instanced grass with wind sway + a base→tip colour
 * gradient. Ported from Barthélemy Paléologue's "AssetScattering" (MIT); `remap` inlined and the
 * glslify pragma dropped (we register raw GLSL into Babylon's ShaderStore).
 *
 * NOTE: a custom GLSL ShaderMaterial on our WebGPU engine compiles via the GLSL→SPIR-V path — the
 * same path that's finicky about varying locations / shader includes. This is the P0 smoke-test risk.
 */
const GRASS_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;

uniform mat4 view;
uniform mat4 projection;
uniform float time;
uniform sampler2D perlinNoise;

varying vec3 vPosition;
varying vec3 vNormalW;

vec3 rotateAround(vec3 v, vec3 axis, float theta) {
    return cos(theta) * v + cross(axis, v) * sin(theta) + axis * dot(axis, v) * (1.0 - cos(theta));
}
float easeIn(float t, float a) { return pow(t, a); }
float remap(float value, float low1, float high1, float low2, float high2) {
    return low2 + (value - low1) * (high2 - low2) / (high1 - low1);
}

#include<instancesDeclaration>

void main() {
    #include<instancesVertex>

    // Wind-only sway (no player interaction — our "player" is a boat). Perlin scroll drives the
    // lean strength + direction; the blade also curves along its length.
    vec3 objectWorld = world3.xyz;
    float windStrength = texture2D(perlinNoise, objectWorld.xz * 0.007 + 0.1 * time).r;
    float windDir      = texture2D(perlinNoise, objectWorld.xz * 0.005 + 0.05 * time).r * 2.0 * 3.14159;

    float windLeanAngle = easeIn(remap(windStrength, 0.0, 1.0, 0.25, 1.0), 2.0) * 0.75;
    float curveAmount = 0.3 * position.y + windLeanAngle;

    // A horizontal lean axis in the XZ plane — never zero, so normalize() is always safe.
    vec3 leanAxis = rotateAround(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), windDir);

    vec3 leaningPosition = rotateAround(position, leanAxis, curveAmount);
    vec3 leaningNormal   = rotateAround(normal,   leanAxis, curveAmount);

    vec4 worldPosition = finalWorld * vec4(leaningPosition, 1.0);
    gl_Position = projection * view * worldPosition;

    vPosition = position;
    // Transform the normal to world space HERE (not via a mat4 varying). A "varying mat4" can't be
    // assigned a layout location on WebGPU's GLSL->SPIR-V path (a matrix needs 4 locations), which
    // made the shader fail to compile. Grass blades are uniformly scaled, so the world matrix's
    // upper-3x3 transforms normals correctly — no transpose(inverse) needed.
    vNormalW = normalize((finalWorld * vec4(leaningNormal, 0.0)).xyz);
}
`;

const GRASS_FRAGMENT = `
precision highp float;

uniform vec3 lightDirection;

varying vec3 vPosition;
varying vec3 vNormalW;

void main() {
    vec3 baseColor = vec3(0.05, 0.2, 0.01);
    vec3 tipColor  = vec3(0.5, 0.5, 0.1);
    vec3 finalColor = mix(baseColor, tipColor, pow(vPosition.y, 4.0));

    vec3 normalW = normalize(vNormalW);
    float ndl = max(dot(normalW, lightDirection), 0.0) + max(dot(-normalW, lightDirection), 0.0);
    ndl = clamp(ndl + 0.1, 0.0, 1.0);

    float ao = mix(mix(1.0, 0.25, 0.2), 1.0, pow(vPosition.y, 2.0));
    gl_FragColor = vec4(finalColor * ndl * ao, 1.0);
}
`;

let registered = false;

/** Creates the grass ShaderMaterial. `getSunDir` returns the unit vector toward the sun (for NdL). */
export function createGrassMaterial(scene: Scene, perlin: Texture, getSunDir: () => Vector3): ShaderMaterial {
  const name = 'scatterGrass';
  if (!registered) {
    Effect.ShadersStore[`${name}VertexShader`] = GRASS_VERTEX;
    Effect.ShadersStore[`${name}FragmentShader`] = GRASS_FRAGMENT;
    registered = true;
  }

  const mat = new ShaderMaterial(name, scene, name, {
    attributes: ['position', 'normal'],
    uniforms: ['view', 'projection', 'time', 'lightDirection'],
    defines: ['#define INSTANCES'],
    samplers: ['perlinNoise'],
  });
  mat.backFaceCulling = false;
  mat.setTexture('perlinNoise', perlin);

  let elapsed = 0;
  scene.onBeforeRenderObservable.add(() => {
    elapsed += scene.getEngine().getDeltaTime() / 1000;
    mat.setFloat('time', elapsed);
    mat.setVector3('lightDirection', getSunDir());
  });

  return mat;
}
