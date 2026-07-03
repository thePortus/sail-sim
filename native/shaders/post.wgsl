// Final post-process: the client's DefaultRenderingPipeline "pretty" pass.
// Reads the linear HDR scene, applies (in order) the rain-on-the-lens refraction
// (Martijn Steinrucken's "Heartfelt", as adapted in rain-lens.ts), a light
// sharpen, exposure, ACES filmic tonemapping, contrast, bloom composite,
// vignette, and animated film grain — all driven by the same time-of-day /
// weather curves scene.service's tickTimeOfDay used.

struct PostU {
    misc  : vec4<f32>,   // x,y = resolution; z = time (s); w = rain amount [0..1]
    grade : vec4<f32>,   // x = exposure; y = contrast; z = bloom weight; w = grade enabled
    fx    : vec4<f32>,   // x = grain intensity (/255); y = grain animated; z = vignette weight; w = sharpen
};
@group(0) @binding(0) var<uniform> u : PostU;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var bloomTex : texture_2d<f32>;
@group(0) @binding(3) var samp     : sampler;

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

// ── Rain-on-the-lens (rain-lens.ts / "Heartfelt" port) ──────────────────────
fn S(a : f32, b : f32, t : f32) -> f32 { return smoothstep(a, b, t); }
fn N13(p : f32) -> vec3<f32> {
    var p3 = fract(vec3<f32>(p) * vec3<f32>(0.1031, 0.11369, 0.13787));
    p3 += dot(p3, p3.yzx + 19.19);
    return fract(vec3<f32>((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
}
fn N1(t : f32) -> f32 { return fract(sin(t * 12345.564) * 7658.76); }
fn Saw(b : f32, t : f32) -> f32 { return S(0.0, b, t) * S(1.0, b, t); }

fn DropLayer2(uvIn : vec2<f32>, t : f32) -> vec2<f32> {
    let UV = uvIn;
    var uv = uvIn;
    uv.y += t * 0.75;
    let a = vec2<f32>(6.0, 1.0);
    let grid = a * 2.0;
    var id = floor(uv * grid);
    let colShift = N1(id.x);
    uv.y += colShift;
    id = floor(uv * grid);
    let n = N13(id.x * 35.2 + id.y * 2376.1);
    let st = fract(uv * grid) - vec2<f32>(0.5, 0.0);
    var x = n.x - 0.5;
    var y = UV.y * 20.0;
    let wiggle = sin(y + sin(y));
    x += wiggle * (0.5 - abs(x)) * (n.z - 0.5);
    x *= 0.7;
    let ti = fract(t + n.z);
    y = (Saw(0.85, ti) - 0.5) * 0.9 + 0.5;
    let p = vec2<f32>(x, y);
    let d = length((st - p) * a.yx);
    let mainDrop = S(0.4, 0.0, d);
    let r = sqrt(S(1.0, y, st.y));
    let cd = abs(st.x - x);
    var trail = S(0.23 * r, 0.15 * r * r, cd);
    let trailFront = S(-0.02, 0.02, st.y - y);
    trail *= trailFront * r * r;
    y = UV.y;
    let trail2 = S(0.2 * r, 0.0, cd);
    var droplets = max(0.0, (sin(y * (1.0 - y) * 120.0) - st.y)) * trail2 * trailFront * n.z;
    y = fract(y * 10.0) + (st.y - 0.5);
    let dd = length(st - vec2<f32>(x, y));
    droplets = S(0.3, 0.0, dd);
    let m = mainDrop + droplets * r * trailFront;
    return vec2<f32>(m, trail);
}

fn StaticDrops(uvIn : vec2<f32>, t : f32) -> f32 {
    var uv = uvIn * 40.0;
    let id = floor(uv);
    uv = fract(uv) - 0.5;
    let n = N13(id.x * 107.45 + id.y * 3543.654);
    let p = (n.xy - 0.5) * 0.7;
    let d = length(uv - p);
    let fade = Saw(0.025, fract(t + n.z));
    return S(0.3, 0.0, d) * fract(n.z * 10.0) * fade;
}

fn Drops(uv : vec2<f32>, t : f32, l0 : f32, l1 : f32, l2 : f32) -> vec2<f32> {
    let s = StaticDrops(uv, t) * l0;
    let m1 = DropLayer2(uv, t) * l1;
    let m2 = DropLayer2(uv * 1.85, t) * l2;
    var c = s + m1.x + m2.x;
    c = S(0.3, 1.0, c);
    return vec2<f32>(c, max(m1.y * l0, m2.y * l1));
}

// ── ACES filmic tonemap (Babylon toneMappingType 2) ─────────────────────────
fn aces(x : vec3<f32>) -> vec3<f32> {
    let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn grainHash(p : vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let res = u.misc.xy;
    var uv = in.uv;

    // ── Rain lens: drops + trails refract the scene under them. ──
    let rainAmount = clamp(u.misc.w, 0.0, 1.0);
    if (rainAmount > 0.02) {
        let fragCoord = in.uv * res;
        let ruv = (fragCoord - 0.5 * res) / res.y;
        let t = u.misc.z * 0.2;
        let fade = S(0.0, 0.08, rainAmount);
        let rd = pow(rainAmount, 0.55) * (1.0 - 0.2 * rainAmount);
        let staticDrops = S(-0.5, 1.0, rd) * 1.3 * fade;
        let layer1 = S(0.25, 0.75, rd) * fade;
        let layer2 = S(0.0, 0.5, rd) * fade;
        let c = Drops(ruv, t, staticDrops, layer1, layer2);
        let e = vec2<f32>(0.001, 0.0);
        let cx = Drops(ruv + e, t, staticDrops, layer1, layer2).x;
        let cy = Drops(ruv + e.yx, t, staticDrops, layer1, layer2).x;
        uv += vec2<f32>(cx - c.x, cy - c.x);   // refraction normal — the drops lens the scene
    }

    var col = textureSampleLevel(sceneTex, samp, uv, 0.0).rgb;

    // ── Sharpen (pipeline.sharpen edgeAmount) — restores rigging/deck crispness. ──
    if (u.fx.w > 0.001) {
        let px = 1.0 / res;
        var nb = textureSampleLevel(sceneTex, samp, uv + vec2<f32>(px.x, 0.0), 0.0).rgb;
        nb += textureSampleLevel(sceneTex, samp, uv - vec2<f32>(px.x, 0.0), 0.0).rgb;
        nb += textureSampleLevel(sceneTex, samp, uv + vec2<f32>(0.0, px.y), 0.0).rgb;
        nb += textureSampleLevel(sceneTex, samp, uv - vec2<f32>(0.0, px.y), 0.0).rgb;
        col = max(vec3<f32>(0.0), col + (col - nb * 0.25) * u.fx.w);
    }

    if (u.grade.w > 0.5) {
        // ── Bloom composite (thresholded half-res blur, additive by weight). ──
        col += textureSampleLevel(bloomTex, samp, uv, 0.0).rgb * u.grade.z;
        // ── Exposure -> ACES tonemap -> contrast (imageProcessing order). ──
        col *= u.grade.x;
        col = aces(col);
        col = clamp((col - 0.5) * u.grade.y + 0.5, vec3<f32>(0.0), vec3<f32>(1.0));
        // ── Vignette (weight 0.40 — light corner falloff). ──
        let d2 = dot(in.uv - 0.5, in.uv - 0.5);
        col *= 1.0 - u.fx.z * smoothstep(0.12, 0.55, d2);
        // ── Film grain: animated when fx.y > 0.5, static otherwise. ──
        let gseed = select(vec2<f32>(0.0), vec2<f32>(fract(u.misc.z * 13.7), fract(u.misc.z * 7.3)), u.fx.y > 0.5);
        let g = grainHash(in.uv * res * 0.5 + gseed) - 0.5;
        col += g * u.fx.x;
    }
    return vec4<f32>(col, 1.0);
}
