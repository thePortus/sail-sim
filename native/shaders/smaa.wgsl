// SMAA 1x (Enhanced Subpixel Morphological Antialiasing), ported from Jorge
// Jimenez's reference SMAA.hlsl (v2.8), orthogonal path with corner rounding.
// Diagonal search is omitted — the largest cost for the least visible gain.
// Three passes, run in order; each is an entry-point pair here:
//   1. edge detection    (vs_edge  / fs_edge)   colorTex        -> edges  (RG8)
//   2. blend weights      (vs_weight/ fs_weight) edges+area+srch -> weights(RGBA8)
//   3. neighborhood blend (vs_blend / fs_blend)  colorTex+weights-> swapchain
// Edge/weight passes run at the LDR render resolution (rtMetrics = source res);
// the blend pass may output at swapchain res, folding the SSAA downsample into
// the same bilinear tap — so "SMAA + SSAA" is just SMAA evaluated at hi-res.

const SMAA_THRESHOLD : f32 = 0.1;
const SMAA_MAX_SEARCH_STEPS : i32 = 16;
const SMAA_CORNER_ROUNDING_NORM : f32 = 0.25;   // SMAA_CORNER_ROUNDING(25)/100
const SMAA_LOCAL_CONTRAST_ADAPTATION_FACTOR : f32 = 2.0;

const SMAA_AREATEX_MAX_DISTANCE : f32 = 16.0;
const SMAA_AREATEX_PIXEL_SIZE : vec2<f32> = vec2<f32>(1.0 / 160.0, 1.0 / 560.0);
const SMAA_AREATEX_SUBTEX_SIZE : f32 = 1.0 / 7.0;
const SMAA_SEARCHTEX_SIZE : vec2<f32> = vec2<f32>(66.0, 33.0);
const SMAA_SEARCHTEX_PACKED_SIZE : vec2<f32> = vec2<f32>(64.0, 16.0);

// rtMetrics = (1/w, 1/h, w, h) of the EDGE/WEIGHT targets (the source resolution).
struct U { rtMetrics : vec4<f32> };
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var texA : texture_2d<f32>;   // color (p1/p3) or edges (p2)
@group(0) @binding(2) var linSamp : sampler;        // linear, clamp-to-edge
@group(0) @binding(3) var areaTex   : texture_2d<f32>;   // pass 2
@group(0) @binding(4) var searchTex : texture_2d<f32>;   // pass 2
@group(0) @binding(5) var blendTex  : texture_2d<f32>;   // pass 3

fn fullscreen(vid : u32) -> vec4<f32> {
    var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    let p = pts[vid];
    return vec4<f32>(p.x, p.y, (p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
}
fn sat2(v : vec2<f32>) -> vec2<f32> { return clamp(v, vec2<f32>(0.0), vec2<f32>(1.0)); }

// ── Pass 1: luma edge detection ──────────────────────────────────────────────
struct EdgeVSOut {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
    @location(1) o0 : vec4<f32>,
    @location(2) o1 : vec4<f32>,
    @location(3) o2 : vec4<f32>,
};

@vertex
fn vs_edge(@builtin(vertex_index) vid : u32) -> EdgeVSOut {
    let f = fullscreen(vid);
    let m = u.rtMetrics;
    var o : EdgeVSOut;
    o.position = vec4<f32>(f.xy, 0.0, 1.0);
    o.uv = f.zw;
    o.o0 = m.xyxy * vec4<f32>(-1.0, 0.0, 0.0, -1.0) + o.uv.xyxy;
    o.o1 = m.xyxy * vec4<f32>( 1.0, 0.0, 0.0,  1.0) + o.uv.xyxy;
    o.o2 = m.xyxy * vec4<f32>(-2.0, 0.0, 0.0, -2.0) + o.uv.xyxy;
    return o;
}

// The LDR intermediate is LINEAR (the sRGB swapchain encodes on write). SMAA's
// threshold is calibrated for perceptual space, so gamma-encode before luma —
// matching the FXAA path's toGamma(). Edge-detection space only decides WHERE
// edges are; the blend pass still blends linear colour, so output is unaffected.
fn lumaOf(c : vec3<f32>) -> f32 {
    let g = pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
    return dot(g, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_edge(in : EdgeVSOut) -> @location(0) vec4<f32> {
    let threshold = vec2<f32>(SMAA_THRESHOLD, SMAA_THRESHOLD);
    let L      = lumaOf(textureSampleLevel(texA, linSamp, in.uv,    0.0).rgb);
    let Lleft  = lumaOf(textureSampleLevel(texA, linSamp, in.o0.xy, 0.0).rgb);
    let Ltop   = lumaOf(textureSampleLevel(texA, linSamp, in.o0.zw, 0.0).rgb);

    var delta = abs(vec2<f32>(L, L) - vec2<f32>(Lleft, Ltop));
    var edges = step(threshold, delta);
    if (edges.x + edges.y == 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }

    let Lright  = lumaOf(textureSampleLevel(texA, linSamp, in.o1.xy, 0.0).rgb);
    let Lbottom = lumaOf(textureSampleLevel(texA, linSamp, in.o1.zw, 0.0).rgb);
    var maxDelta = max(delta, abs(vec2<f32>(L, L) - vec2<f32>(Lright, Lbottom)));

    let Lleftleft = lumaOf(textureSampleLevel(texA, linSamp, in.o2.xy, 0.0).rgb);
    let Ltoptop   = lumaOf(textureSampleLevel(texA, linSamp, in.o2.zw, 0.0).rgb);
    maxDelta = max(maxDelta, abs(vec2<f32>(Lleft, Ltop) - vec2<f32>(Lleftleft, Ltoptop)));

    let finalDelta = max(maxDelta.x, maxDelta.y);
    edges = edges * step(vec2<f32>(finalDelta, finalDelta), SMAA_LOCAL_CONTRAST_ADAPTATION_FACTOR * delta);
    return vec4<f32>(edges, 0.0, 1.0);
}

// ── Pass 2: blend-weight calculation (orthogonal + corner) ───────────────────
struct WeightVSOut {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
    @location(1) pixcoord : vec2<f32>,
    @location(2) o0 : vec4<f32>,
    @location(3) o1 : vec4<f32>,
    @location(4) o2 : vec4<f32>,
};

@vertex
fn vs_weight(@builtin(vertex_index) vid : u32) -> WeightVSOut {
    let f = fullscreen(vid);
    let m = u.rtMetrics;
    var o : WeightVSOut;
    o.position = vec4<f32>(f.xy, 0.0, 1.0);
    o.uv = f.zw;
    o.pixcoord = o.uv * m.zw;
    o.o0 = m.xyxy * vec4<f32>(-0.25, -0.125,  1.25, -0.125) + o.uv.xyxy;
    o.o1 = m.xyxy * vec4<f32>(-0.125, -0.25, -0.125,  1.25) + o.uv.xyxy;
    o.o2 = m.xxyy * (vec4<f32>(-2.0, 2.0, -2.0, 2.0) * f32(SMAA_MAX_SEARCH_STEPS))
         + vec4<f32>(o.o0.x, o.o0.z, o.o1.y, o.o1.w);
    return o;
}

// point-ish edge fetch at (coord + (ox,oy) texels); edges tex is in texA for pass 2
fn edgeAt(coord : vec2<f32>, ox : f32, oy : f32) -> vec2<f32> {
    let m = u.rtMetrics;
    return textureSampleLevel(texA, linSamp, coord + vec2<f32>(ox, oy) * m.xy, 0.0).rg;
}

fn SMAASearchLength(e : vec2<f32>, offset : f32) -> f32 {
    var scale = SMAA_SEARCHTEX_SIZE * vec2<f32>(0.5, -1.0) + vec2<f32>(-1.0, 1.0);
    var bias  = SMAA_SEARCHTEX_SIZE * vec2<f32>(offset, 1.0) + vec2<f32>(0.5, -0.5);
    scale = scale * (1.0 / SMAA_SEARCHTEX_PACKED_SIZE);
    bias  = bias  * (1.0 / SMAA_SEARCHTEX_PACKED_SIZE);
    return textureSampleLevel(searchTex, linSamp, scale * e + bias, 0.0).r;
}

fn SMAASearchXLeft(tc0 : vec2<f32>, end : f32) -> f32 {
    let m = u.rtMetrics;
    var tc = tc0;
    var e = vec2<f32>(0.0, 1.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        if (!(tc.x > end && e.y > 0.8281 && e.x == 0.0)) { break; }
        e = textureSampleLevel(texA, linSamp, tc, 0.0).rg;
        tc = tc + vec2<f32>(-2.0, 0.0) * m.xy;
    }
    let offset = -(255.0 / 127.0) * SMAASearchLength(e, 0.0) + 3.25;
    return m.x * offset + tc.x;
}
fn SMAASearchXRight(tc0 : vec2<f32>, end : f32) -> f32 {
    let m = u.rtMetrics;
    var tc = tc0;
    var e = vec2<f32>(0.0, 1.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        if (!(tc.x < end && e.y > 0.8281 && e.x == 0.0)) { break; }
        e = textureSampleLevel(texA, linSamp, tc, 0.0).rg;
        tc = tc + vec2<f32>(2.0, 0.0) * m.xy;
    }
    let offset = -(255.0 / 127.0) * SMAASearchLength(e, 0.5) + 3.25;
    return -m.x * offset + tc.x;
}
fn SMAASearchYUp(tc0 : vec2<f32>, end : f32) -> f32 {
    let m = u.rtMetrics;
    var tc = tc0;
    var e = vec2<f32>(1.0, 0.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        if (!(tc.y > end && e.x > 0.8281 && e.y == 0.0)) { break; }
        e = textureSampleLevel(texA, linSamp, tc, 0.0).rg;
        tc = tc + vec2<f32>(0.0, -2.0) * m.xy;
    }
    let offset = -(255.0 / 127.0) * SMAASearchLength(vec2<f32>(e.y, e.x), 0.0) + 3.25;
    return m.y * offset + tc.y;
}
fn SMAASearchYDown(tc0 : vec2<f32>, end : f32) -> f32 {
    let m = u.rtMetrics;
    var tc = tc0;
    var e = vec2<f32>(1.0, 0.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        if (!(tc.y < end && e.x > 0.8281 && e.y == 0.0)) { break; }
        e = textureSampleLevel(texA, linSamp, tc, 0.0).rg;
        tc = tc + vec2<f32>(0.0, 2.0) * m.xy;
    }
    let offset = -(255.0 / 127.0) * SMAASearchLength(vec2<f32>(e.y, e.x), 0.5) + 3.25;
    return -m.y * offset + tc.y;
}

fn SMAAArea(dist : vec2<f32>, e1 : f32, e2 : f32, offset : f32) -> vec2<f32> {
    var tc = SMAA_AREATEX_MAX_DISTANCE * round(4.0 * vec2<f32>(e1, e2)) + dist;
    tc = SMAA_AREATEX_PIXEL_SIZE * tc + (0.5 * SMAA_AREATEX_PIXEL_SIZE);
    tc.y = SMAA_AREATEX_SUBTEX_SIZE * offset + tc.y;
    return textureSampleLevel(areaTex, linSamp, tc, 0.0).rg;
}

// coordsL = (left, y, right, y);  d = (leftDist, rightDist)
fn cornerH(weights : vec2<f32>, coordsL : vec4<f32>, d : vec2<f32>) -> vec2<f32> {
    let leftRight = step(d.xy, d.yx);
    let rounding = ((1.0 - SMAA_CORNER_ROUNDING_NORM) * leftRight) / max(leftRight.x + leftRight.y, 1e-4);
    var factor = vec2<f32>(1.0, 1.0);
    factor.x = factor.x - rounding.x * edgeAt(coordsL.xy, 0.0,  1.0).r;
    factor.x = factor.x - rounding.y * edgeAt(coordsL.zw, 1.0,  1.0).r;
    factor.y = factor.y - rounding.x * edgeAt(coordsL.xy, 0.0, -2.0).r;
    factor.y = factor.y - rounding.y * edgeAt(coordsL.zw, 1.0, -2.0).r;
    return weights * sat2(factor);
}
// coordsT = (x, top, x, bottom);  d = (upDist, downDist)
fn cornerV(weights : vec2<f32>, coordsT : vec4<f32>, d : vec2<f32>) -> vec2<f32> {
    let leftRight = step(d.xy, d.yx);
    let rounding = ((1.0 - SMAA_CORNER_ROUNDING_NORM) * leftRight) / max(leftRight.x + leftRight.y, 1e-4);
    var factor = vec2<f32>(1.0, 1.0);
    factor.x = factor.x - rounding.x * edgeAt(coordsT.xy,  1.0, 0.0).g;
    factor.x = factor.x - rounding.y * edgeAt(coordsT.zw,  1.0, 1.0).g;
    factor.y = factor.y - rounding.x * edgeAt(coordsT.xy, -2.0, 0.0).g;
    factor.y = factor.y - rounding.y * edgeAt(coordsT.zw, -2.0, 1.0).g;
    return weights * sat2(factor);
}

@fragment
fn fs_weight(in : WeightVSOut) -> @location(0) vec4<f32> {
    let m = u.rtMetrics;
    var weights = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    let e = textureSampleLevel(texA, linSamp, in.uv, 0.0).rg;

    if (e.y > 0.0) {   // edge at north -> horizontal search
        var d : vec2<f32>;
        let cxLeft  = SMAASearchXLeft(in.o0.xy, in.o2.x);
        let cy      = in.o1.y;
        d.x = cxLeft;
        let e1 = textureSampleLevel(texA, linSamp, vec2<f32>(cxLeft, cy), 0.0).r;
        let cxRight = SMAASearchXRight(in.o0.zw, in.o2.y);
        d.y = cxRight;
        d = abs(round(m.zz * d - in.pixcoord.xx));
        let sqrtd = sqrt(d);
        let e2 = edgeAt(vec2<f32>(cxRight, cy), 1.0, 0.0).r;
        let w = SMAAArea(sqrtd, e1, e2, 0.0);
        weights = vec4<f32>(cornerH(w, vec4<f32>(cxLeft, in.uv.y, cxRight, in.uv.y), d), weights.z, weights.w);
    }

    if (e.x > 0.0) {   // edge at west -> vertical search
        var d : vec2<f32>;
        let cyUp    = SMAASearchYUp(in.o1.xy, in.o2.z);
        let cx      = in.o0.x;
        d.x = cyUp;
        let e1 = textureSampleLevel(texA, linSamp, vec2<f32>(cx, cyUp), 0.0).g;
        let cyDown  = SMAASearchYDown(in.o1.zw, in.o2.w);
        d.y = cyDown;
        d = abs(round(m.ww * d - in.pixcoord.yy));
        let sqrtd = sqrt(d);
        let e2 = edgeAt(vec2<f32>(cx, cyDown), 0.0, 1.0).g;
        let w = SMAAArea(sqrtd, e1, e2, 0.0);
        weights = vec4<f32>(weights.x, weights.y, cornerV(w, vec4<f32>(in.uv.x, cyUp, in.uv.x, cyDown), d));
    }
    return weights;
}

// ── Pass 3: neighborhood blending ────────────────────────────────────────────
struct BlendVSOut {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
    @location(1) o0 : vec4<f32>,
};

@vertex
fn vs_blend(@builtin(vertex_index) vid : u32) -> BlendVSOut {
    let f = fullscreen(vid);
    let m = u.rtMetrics;
    var o : BlendVSOut;
    o.position = vec4<f32>(f.xy, 0.0, 1.0);
    o.uv = f.zw;
    o.o0 = m.xyxy * vec4<f32>(1.0, 0.0, 0.0, 1.0) + o.uv.xyxy;
    return o;
}

@fragment
fn fs_blend(in : BlendVSOut) -> @location(0) vec4<f32> {
    let m = u.rtMetrics;
    let selfW = textureSampleLevel(blendTex, linSamp, in.uv, 0.0);
    var a : vec4<f32>;
    a.x = textureSampleLevel(blendTex, linSamp, in.o0.xy, 0.0).a;  // right
    a.y = textureSampleLevel(blendTex, linSamp, in.o0.zw, 0.0).g;  // top
    a.z = selfW.b;   // left
    a.w = selfW.r;   // bottom

    if (dot(a, vec4<f32>(1.0)) < 1e-5) {
        return textureSampleLevel(texA, linSamp, in.uv, 0.0);
    }
    let h = max(a.x, a.z) > max(a.y, a.w);
    var blendingOffset = vec4<f32>(0.0, a.y, 0.0, a.w);
    var bw = vec2<f32>(a.y, a.w);
    if (h) {
        blendingOffset = vec4<f32>(a.x, 0.0, a.z, 0.0);
        bw = vec2<f32>(a.x, a.z);
    }
    bw = bw / (bw.x + bw.y);
    let coord = blendingOffset * vec4<f32>(m.x, m.y, -m.x, -m.y) + in.uv.xyxy;
    var color  = bw.x * textureSampleLevel(texA, linSamp, coord.xy, 0.0);
    color     += bw.y * textureSampleLevel(texA, linSamp, coord.zw, 0.0);
    return color;
}
