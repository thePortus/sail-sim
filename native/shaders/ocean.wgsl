// Analytic Gerstner ocean surface. The wave set MUST match kWaves in src/wave.hpp
// (so the ship, placed on the CPU height field, sits on the visible surface).

struct Camera {
    viewProj : mat4x4<f32>,
    eye      : vec4<f32>,   // xyz camera position
    params   : vec4<f32>,   // x = time (s)
};
@group(0) @binding(0) var<uniform> cam : Camera;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       worldPos : vec3<f32>,
    @location(1)       normal   : vec3<f32>,
};

// dirX, dirZ, wavelength, amplitude, steepness   (keep in sync with wave.hpp)
// var<private> (not const) so the loop can index them dynamically — naga v0.19
// rejects dynamic indexing of a module-scope const array.
const NW : i32 = 4;
var<private> gWaves : array<vec4<f32>, 4> = array<vec4<f32>, 4>(
    vec4<f32>( 1.0,  0.0, 60.0, 0.60),
    vec4<f32>( 0.7,  0.7, 31.0, 0.32),
    vec4<f32>(-0.6,  0.8, 18.0, 0.16),
    vec4<f32>( 0.2, -1.0,  9.0, 0.08),
);
var<private> gSteep : array<f32, 4> = array<f32, 4>(0.55, 0.55, 0.45, 0.35);
const G : f32 = 9.81;

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
    let t = cam.params.x;
    var pos = vec3<f32>(inXZ.x, 0.0, inXZ.y);

    // Full Gerstner: horizontal pinch + vertical rise, plus analytic normal.
    var tangent = vec3<f32>(1.0, 0.0, 0.0);
    var binormal = vec3<f32>(0.0, 0.0, 1.0);
    for (var i = 0; i < NW; i = i + 1) {
        let w = gWaves[i];
        let dir = normalize(vec2<f32>(w.x, w.y));
        let L = w.z;
        let A = w.w;
        let Q = gSteep[i];
        let k = 6.2831853 / L;
        let omega = sqrt(G * k);
        let phase = k * dot(dir, inXZ) - omega * t;
        let c = cos(phase);
        let s = sin(phase);
        pos.x += Q * A * dir.x * c;
        pos.z += Q * A * dir.y * c;
        pos.y += A * s;
        let WA = omega * A;
        tangent  += vec3<f32>(-Q * dir.x * dir.x * WA * s, dir.x * WA * c, -Q * dir.x * dir.y * WA * s);
        binormal += vec3<f32>(-Q * dir.x * dir.y * WA * s, dir.y * WA * c, -Q * dir.y * dir.y * WA * s);
    }

    var out : VSOut;
    out.position = cam.viewProj * vec4<f32>(pos, 1.0);
    out.worldPos = pos;
    out.normal = normalize(cross(binormal, tangent));
    return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let N = normalize(in.normal);
    let V = normalize(cam.eye.xyz - in.worldPos);
    let L = normalize(vec3<f32>(0.5, 1.0, 0.4));   // sun

    let deep    = vec3<f32>(0.015, 0.07, 0.11);
    let shallow = vec3<f32>(0.10, 0.30, 0.34);
    let sky     = vec3<f32>(0.55, 0.72, 0.86);

    // Fresnel: more sky reflection at grazing angles.
    let fres = 0.02 + 0.98 * pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 5.0);
    let facing = clamp(dot(N, V), 0.0, 1.0);
    let water = mix(deep, shallow, facing);
    var color = mix(water, sky, fres);

    // Sun specular (sharp Blinn-Phong glint).
    let H = normalize(V + L);
    let spec = pow(max(dot(N, H), 0.0), 220.0);
    color += vec3<f32>(1.0, 0.95, 0.8) * spec;

    color = pow(color, vec3<f32>(1.0 / 2.2));   // gamma
    return vec4<f32>(color, 1.0);
}
