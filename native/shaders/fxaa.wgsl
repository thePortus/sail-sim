// Resolve pass: samples the graded LDR scene and (optionally) FXAAs it onto the
// sRGB swapchain. FXAA is Timothy Lottes' classic edge-blur, run in PERCEPTUAL
// (gamma) space on the luma — the graded scene is linear, so we gamma-encode for
// the luma/blend and linear-decode the result for the sRGB target. When AA is
// off (u.params.x < 0.5) it's a straight passthrough (still needed to move the
// LDR intermediate to the swapchain so ImGui can draw on top).

struct U {
    params : vec4<f32>,   // x = AA enabled; yz = 1/resolution (texel size); w unused
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var ldrTex : texture_2d<f32>;
@group(0) @binding(2) var samp   : sampler;

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

fn toGamma(c : vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)); }
fn toLinear(c : vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(2.2)); }
fn luma(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }

// Classic FXAA (Lottes) tuned to standard quality: edge threshold + a directional
// blur along the detected edge, span-clamped so it doesn't smear texture detail.
const EDGE_MIN : f32 = 0.0312;   // ignore near-flat regions
const EDGE_MAX : f32 = 0.125;    // full strength at this local contrast
const SPAN_MAX : f32 = 8.0;

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let px = u.params.yz;
    let center = textureSampleLevel(ldrTex, samp, in.uv, 0.0).rgb;
    if (u.params.x < 0.5) {
        return vec4<f32>(center, 1.0);   // passthrough (AA off) — sRGB target encodes
    }
    // Gamma-space luma of the 4 diagonal neighbours + centre.
    let gC  = toGamma(center);
    let lC  = luma(gC);
    let lNW = luma(toGamma(textureSampleLevel(ldrTex, samp, in.uv + vec2<f32>(-px.x, -px.y), 0.0).rgb));
    let lNE = luma(toGamma(textureSampleLevel(ldrTex, samp, in.uv + vec2<f32>( px.x, -px.y), 0.0).rgb));
    let lSW = luma(toGamma(textureSampleLevel(ldrTex, samp, in.uv + vec2<f32>(-px.x,  px.y), 0.0).rgb));
    let lSE = luma(toGamma(textureSampleLevel(ldrTex, samp, in.uv + vec2<f32>( px.x,  px.y), 0.0).rgb));

    let lMin = min(lC, min(min(lNW, lNE), min(lSW, lSE)));
    let lMax = max(lC, max(max(lNW, lNE), max(lSW, lSE)));
    let range = lMax - lMin;
    if (range < max(EDGE_MIN, lMax * EDGE_MAX)) {
        return vec4<f32>(center, 1.0);   // flat area — leave it crisp
    }

    // Edge direction from the diagonal luma gradient.
    var dir = vec2<f32>(-((lNW + lNE) - (lSW + lSE)),
                         ((lNW + lSW) - (lNE + lSE)));
    let dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.25, 1.0 / 128.0);
    let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, vec2<f32>(-SPAN_MAX), vec2<f32>(SPAN_MAX)) * px;

    // Two-tap and four-tap averages along the edge; pick the sharper that stays
    // within the local luma range (avoids over-blurring high-contrast detail).
    let rgbA = 0.5 * (textureSampleLevel(ldrTex, samp, in.uv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb
                    + textureSampleLevel(ldrTex, samp, in.uv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
    let rgbB = rgbA * 0.5 + 0.25 * (textureSampleLevel(ldrTex, samp, in.uv + dir * -0.5, 0.0).rgb
                                  + textureSampleLevel(ldrTex, samp, in.uv + dir * 0.5, 0.0).rgb);
    let lB = luma(toGamma(rgbB));
    let outRGB = select(rgbA, rgbB, lB >= lMin && lB <= lMax);
    return vec4<f32>(outRGB, 1.0);   // linear -> sRGB target
}
