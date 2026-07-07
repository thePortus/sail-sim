// Lightning bolt (lightning-bolt.ts port): a distant Y-billboard quad rendering a
// procedural FBM-displaced bolt, additively blended (black adds nothing), depth-
// TESTED but not written so land in front occludes a far strike. Brightness is the
// same multi-peak flash envelope that drives the scene-wide flash, so the bolt and
// the ambient strobe read as one event. Shader adapted from ShaderToy "lightning"
// (dsXfDn), exactly as the client adapted it.

struct BoltU {
    mvp    : mat4x4<f32>,
    center : vec4<f32>,   // xyz = bolt centre; w = per-strike scale
    right  : vec4<f32>,   // xz = billboard right (yaw-to-camera); w = aspect (W/H)
    anim   : vec4<f32>,   // x = clock; y = flash envelope; z = seed; w unused
};
@group(0) @binding(0) var<uniform> u : BoltU;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       uv       : vec2<f32>,
};

const kBoltW = 320.0;   // billboard size in metres (a tall, distant bolt)
const kBoltH = 560.0;

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
        vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5));
    let c = corners[vid];
    let s = u.center.w;
    let wp = vec3<f32>(u.center.x + u.right.x * c.x * kBoltW * s,
                       u.center.y + c.y * kBoltH * s,
                       u.center.z + u.right.y * c.x * kBoltW * s);
    var o : VSOut;
    o.position = u.mvp * vec4<f32>(wp, 1.0);
    o.uv = vec2<f32>(c.x + 0.5, c.y + 0.5);   // v = 0 at the bottom, like the client's plane
    return o;
}

fn hash11(pIn : f32) -> f32 {
    var p = fract(pIn * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}
fn hash12(p : vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p : vec2<f32>) -> f32 {
    let ip = floor(p);
    let fp = fract(p);
    let a = hash12(ip);
    let b = hash12(ip + vec2<f32>(1.0, 0.0));
    let c = hash12(ip + vec2<f32>(0.0, 1.0));
    let d = hash12(ip + vec2<f32>(1.0, 1.0));
    let t = smoothstep(vec2<f32>(0.0), vec2<f32>(1.0), fp);
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
fn fbm(pIn : vec2<f32>) -> f32 {
    var p = pIn;
    var v = 0.0;
    var amp = 0.5;
    let r = mat2x2<f32>(vec2<f32>(cos(0.45), sin(0.45)), vec2<f32>(-sin(0.45), cos(0.45)));
    for (var i = 0; i < 8; i = i + 1) {
        v += amp * vnoise(p);
        p = r * p * 2.0;
        amp *= 0.5;
    }
    return v;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    // Cheap out once the flash has faded — 8 FBM octaves over a big sky patch for
    // nothing otherwise. (Additive target: black contributes nothing.)
    if (u.anim.y <= 0.002) { return vec4<f32>(0.0); }

    var uv = 2.0 * in.uv - 1.0;
    uv.x *= u.right.w;
    // FBM-displace the domain — the streak wanders + forks like a real bolt.
    uv += 2.0 * fbm(uv + 0.8 * u.anim.x + u.anim.z) - 1.0;

    let dist = abs(uv.x);
    let flick = mix(0.012, 0.07, hash11(u.anim.x + u.anim.z));   // per-frame strobe
    let core = min(flick / max(dist, 0.004), 40.0);              // hot centre, glowing falloff

    var col = vec3<f32>(0.45, 0.6, 1.0) * core;
    // Vertical shaping: land softly near the sea line, feather the top edge.
    let baseFade = smoothstep(0.04, 0.38, in.uv.y);
    let topEdge = smoothstep(1.0, 0.9, in.uv.y);
    col *= mix(0.5, 1.0, in.uv.y) * baseFade * topEdge;
    col *= u.anim.y;

    return vec4<f32>(col, 1.0);
}
