// Analytic Gerstner ocean surface (interim — the real FFT ocean is Phase 2).
// The wave set MUST match kWaves in src/wave.hpp so the ship, placed on the CPU
// height field, sits on the visible surface.

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
    @location(2)       crest    : f32,       // 0..1 height toward crest (for foam)
};

// var<private> (not const) so the loop can index dynamically (naga v0.19).
// dirX, dirZ, wavelength, amplitude   (keep in sync with wave.hpp)
const NW : i32 = 6;
var<private> gWaves : array<vec4<f32>, 6> = array<vec4<f32>, 6>(
    vec4<f32>( 1.0,  0.0, 60.0, 0.60),
    vec4<f32>( 0.7,  0.7, 31.0, 0.32),
    vec4<f32>(-0.6,  0.8, 18.0, 0.16),
    vec4<f32>( 0.2, -1.0,  9.0, 0.08),
    vec4<f32>(-0.8, -0.4,  5.5, 0.05),
    vec4<f32>( 0.5,  0.9,  3.2, 0.03),
);
var<private> gSteep : array<f32, 6> = array<f32, 6>(0.55, 0.55, 0.45, 0.35, 0.30, 0.25);
const G : f32 = 9.81;
const SUM_A : f32 = 1.24;   // sum of amplitudes

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
    let t = cam.params.x;
    var pos = vec3<f32>(inXZ.x, 0.0, inXZ.y);
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
    out.crest = clamp(pos.y / SUM_A, -1.0, 1.0);
    return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let N = normalize(in.normal);
    let V = normalize(cam.eye.xyz - in.worldPos);
    let L = normalize(vec3<f32>(0.5, 1.0, 0.4));
    let sunColor = vec3<f32>(1.0, 0.96, 0.86);

    let deep    = vec3<f32>(0.010, 0.055, 0.090);
    let shallow = vec3<f32>(0.06, 0.26, 0.32);
    let sky     = vec3<f32>(0.52, 0.70, 0.86);

    let facing = clamp(dot(N, V), 0.0, 1.0);
    // Fresnel (Schlick, F0 ~0.02 for water).
    let fres = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

    // Depth-ish tint: steeper view into troughs reads darker/greener.
    var water = mix(deep, shallow, facing);
    // Cheap subsurface glow on the sun side of crests.
    let sss = pow(max(dot(V, -L), 0.0), 3.0) * clamp(in.crest, 0.0, 1.0);
    water += vec3<f32>(0.03, 0.16, 0.14) * sss;

    var color = mix(water, sky, fres);

    // Sharp sun glint.
    let H = normalize(V + L);
    color += sunColor * pow(max(dot(N, H), 0.0), 300.0) * 1.5;

    // Foam on the crests and on steep wave faces.
    let steep = 1.0 - N.y;   // 0 = flat, larger on wave faces
    let foam = smoothstep(0.55, 0.90, in.crest) + 0.4 * smoothstep(0.35, 0.75, steep);
    color = mix(color, vec3<f32>(0.92, 0.96, 0.99), clamp(foam, 0.0, 0.65));

    color = pow(color, vec3<f32>(1.0 / 2.2));
    return vec4<f32>(color, 1.0);
}
