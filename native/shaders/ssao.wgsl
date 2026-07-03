// SSAO (client SSAO2RenderingPipeline port) — contact shadows in corners and
// crevices of nearby geometry. The client dialed strength to 0.45/base 0.55 only
// because its rigged vessel was excluded from the prePass G-buffer (WebGPU varying
// budget) and SSAO painted the ocean-behind-the-boat's AO onto the hull. Our depth
// buffer holds the real hull, so this runs at proper strength. Two entry points:
// fs_ao (half-res hemisphere occlusion from the scene depth) and fs_blur (separable
// depth-aware bilateral, H then V — the client's bilateralSamples pass).

struct SsaoU {
    pmat   : vec4<f32>,   // x = proj[0][0], y = proj[1][1], z = proj[2][2], w = proj[3][2]
    params : vec4<f32>,   // x = radius (m), y = totalStrength, z = base, w = maxZ (m)
    misc   : vec4<f32>,   // x,y = output resolution; z,w = blur direction (px)
};
@group(0) @binding(0) var<uniform> u : SsaoU;
@group(0) @binding(1) var depthT : texture_depth_2d;
@group(0) @binding(2) var aoSrc  : texture_2d<f32>;   // blur passes only
@group(0) @binding(3) var samp   : sampler;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       uv       : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
    var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var o : VSOut;
    o.position = vec4<f32>(pts[vid], 0.0, 1.0);
    o.uv = vec2<f32>((pts[vid].x + 1.0) * 0.5, (1.0 - pts[vid].y) * 0.5);
    return o;
}

// View-space z (negative forward) from the hardware depth at a screen uv.
fn viewZ(uv : vec2<f32>) -> f32 {
    let dims = vec2<f32>(textureDimensions(depthT));
    let p = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.9995)) * dims);
    let d = textureLoad(depthT, p, 0);
    return -u.pmat.w / (d + u.pmat.z);
}

fn viewPos(uv : vec2<f32>) -> vec3<f32> {
    let z = viewZ(uv);
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y);
    return vec3<f32>(ndc.x * (-z) / u.pmat.x, ndc.y * (-z) / u.pmat.y, z);
}

fn hash12(p : vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// Cosine-ish hemisphere kernel (tangent-space, +Z out of the surface), sample
// lengths ramped quadratically so most taps probe close to the point. Copied
// into a function-local var before the loop — naga can't dynamically index a
// module-scope const array.
fn kernelAt(i : i32) -> vec3<f32> {
    var k = array<vec3<f32>, 16>(
    vec3<f32>(-0.0878, 0.0074, 0.0473), vec3<f32>(-0.1019, 0.0017, 0.0210),
    vec3<f32>(-0.0171, -0.1109, 0.0293), vec3<f32>(-0.0286, 0.1239, 0.0484),
    vec3<f32>(0.0631, -0.0580, 0.1398), vec3<f32>(0.1266, -0.0508, 0.1463),
    vec3<f32>(0.0929, -0.0508, 0.2198), vec3<f32>(0.2191, 0.1481, 0.1330),
    vec3<f32>(0.0584, 0.0198, 0.3506), vec3<f32>(-0.4098, -0.0130, 0.1079),
    vec3<f32>(0.1882, 0.2960, 0.3563), vec3<f32>(0.1862, 0.1577, 0.5306),
    vec3<f32>(-0.3354, -0.1778, 0.5593), vec3<f32>(0.5708, -0.3475, 0.3944),
    vec3<f32>(-0.5600, -0.0316, 0.6833), vec3<f32>(0.4912, 0.0399, 0.8701),
    );
    return k[i];
}

@fragment
fn fs_ao(in : VSOut) -> @location(0) vec4<f32> {
    let P = viewPos(in.uv);
    let dist = -P.z;
    // Beyond maxZ the AO fades to nothing (client ssao.maxZ = 100 — excludes
    // islands / far terrain, where half-res AO would just shimmer).
    let zfade = 1.0 - smoothstep(u.params.w * 0.8, u.params.w, dist);
    if (zfade <= 0.001) { return vec4<f32>(1.0); }

    // Normal from depth: central differences, picking the smaller-delta side so
    // silhouette edges don't produce garbage normals.
    let dims = vec2<f32>(textureDimensions(depthT));
    let e = 2.0 / dims;
    let Pr = viewPos(in.uv + vec2<f32>(e.x, 0.0));
    let Pl = viewPos(in.uv - vec2<f32>(e.x, 0.0));
    let Pb = viewPos(in.uv + vec2<f32>(0.0, e.y));
    let Pt = viewPos(in.uv - vec2<f32>(0.0, e.y));
    var dxv = Pr - P;
    if (length(Pl - P) < length(dxv)) { dxv = P - Pl; }
    var dyv = Pb - P;
    if (length(Pt - P) < length(dyv)) { dyv = P - Pt; }
    var n = normalize(cross(dyv, dxv));
    if (n.z < 0.0) { n = -n; }   // camera looks down -Z; keep normals camera-facing

    // Random per-pixel kernel rotation (replaces the client's tiled noise texture).
    let ang = hash12(in.uv * u.misc.xy) * 6.2831853;
    let ca = cos(ang);
    let sa = sin(ang);
    var up = vec3<f32>(0.0, 0.0, 1.0);
    if (abs(n.z) > 0.99) { up = vec3<f32>(1.0, 0.0, 0.0); }
    var tang = normalize(cross(up, n));
    tang = tang * ca + cross(n, tang) * sa;
    let bit = cross(n, tang);

    let radius = u.params.x;
    let bias = 0.03;
    var occ = 0.0;
    for (var i = 0; i < 16; i = i + 1) {
        let k = kernelAt(i);
        let sp = P + (tang * k.x + bit * k.y + n * k.z) * radius;
        let sndc = vec2<f32>(u.pmat.x * sp.x, u.pmat.y * sp.y) / max(0.001, -sp.z);
        let suv = vec2<f32>(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { continue; }
        let sz = viewZ(suv);
        // Occluded when real geometry sits in front of the hemisphere sample
        // (view z is negative forward: nearer = greater). Range check keeps far
        // silhouettes (ship against distant water) from haloing.
        let rangeCheck = smoothstep(0.0, 1.0, radius / max(0.0001, abs(P.z - sz)));
        occ = occ + select(0.0, 1.0, sz >= sp.z + bias) * rangeCheck;
    }
    occ = occ / 16.0;
    let ao = clamp(1.0 - occ * u.params.y * zfade + u.params.z, 0.0, 1.0);
    return vec4<f32>(ao, ao, ao, 1.0);
}

// Depth-aware separable blur (direction in misc.zw, half-res px): Gaussian falloff
// weighted down across depth discontinuities so AO doesn't bleed over silhouettes.
@fragment
fn fs_blur(in : VSOut) -> @location(0) vec4<f32> {
    let px = u.misc.zw / u.misc.xy;
    let dc = -viewZ(in.uv);
    var acc = 0.0;
    var wsum = 0.0;
    for (var i = -4; i <= 4; i = i + 1) {
        let uv = in.uv + px * f32(i);
        let g = exp(-f32(i * i) * 0.18);
        let dt = -viewZ(uv);
        let w = g / (1.0 + abs(dt - dc) * 1.5);
        acc = acc + textureSampleLevel(aoSrc, samp, uv, 0.0).r * w;
        wsum = wsum + w;
    }
    let ao = acc / max(wsum, 1e-4);
    return vec4<f32>(ao, ao, ao, 1.0);
}
