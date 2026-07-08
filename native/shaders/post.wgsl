// Final post-process: the client's DefaultRenderingPipeline "pretty" pass.
// Reads the linear HDR scene, applies (in order) the rain-on-the-lens refraction
// (Martijn Steinrucken's "Heartfelt", as adapted in rain-lens.ts), a light
// sharpen, then Babylon's exact imageProcessing chain: exposure, vignette,
// KHR PBR Neutral tonemapping, gamma-space contrast, bloom composite, and
// animated film grain — all driven by the same time-of-day / weather curves
// scene.service's tickTimeOfDay used.

struct PostU {
    misc  : vec4<f32>,   // x,y = resolution; z = time (s); w = rain amount [0..1]
    grade : vec4<f32>,   // x = exposure; y = contrast; z = bloom weight; w = grade enabled
    fx    : vec4<f32>,   // x = grain intensity (/255); y = grain animated; z = vignette weight; w = sharpen
    dof   : vec4<f32>,   // x = focus distance (m); y = CoC scale; z unused; w = DOF enabled
    zp    : vec4<f32>,   // x = proj[2][2]; y = proj[3][2]; z = SSAO enabled; w unused
    tele  : vec4<f32>,   // telescope lens: xy = centre (uv); z = radius, Y-normalized (0 = off); w = zoom
    ae    : vec4<f32>,   // auto-exposure/grade: x = AE enabled; y = key (mid-grey target); z = min mul; w = max mul
};
@group(0) @binding(0) var<uniform> u : PostU;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var bloomTex : texture_2d<f32>;
@group(0) @binding(3) var samp     : sampler;
@group(0) @binding(4) var aoTex    : texture_2d<f32>;   // half-res blurred SSAO
@group(0) @binding(5) var dofTex   : texture_2d<f32>;   // half-res CoC-blurred scene
@group(0) @binding(6) var depthT   : texture_depth_2d;  // scene depth (read-only bound)
@group(0) @binding(7) var lumTex   : texture_2d<f32>;   // 1x1 adapted luminance (auto-exposure)

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

// ── Second lens layer (cloud.service LENS_RAIN port): large, slow-sliding
//    droplets that refract the scene. The browser stacked BOTH passes — this one
//    (always attached, early-out when dry) and the Heartfelt drops above. ──
fn h21(pIn : vec2<f32>) -> f32 {
    var p = fract(pIn * vec2<f32>(123.34, 345.45));
    p += dot(p, p + vec2<f32>(34.345));
    return fract(p.x * p.y);
}

fn dropLayerBig(uv : vec2<f32>, scl : f32, seed : f32, t : f32) -> vec4<f32> {
    let gv = uv * scl;
    let id = floor(gv);
    let f = fract(gv) - vec2<f32>(0.5);
    let r1 = h21(id + vec2<f32>(seed));
    let r2 = h21(id + vec2<f32>(seed + 7.7));
    if (h21(id + vec2<f32>(seed + 3.1)) < 0.5) { return vec4<f32>(0.0); }
    let period = mix(3.5, 7.5, r2);
    let life = fract((t + r1 * 90.0) / period);
    var c = (vec2<f32>(r1, r2) - vec2<f32>(0.5)) * 0.55;
    c.y -= life * 0.30;
    let rad = mix(0.10, 0.34, smoothstep(0.0, 0.12, life)) * (0.65 + 0.35 * r2);
    let d = length(f - c);
    var m = smoothstep(rad, rad * 0.45, d);
    m *= 1.0 - smoothstep(0.72, 1.0, life);
    let offset = -(f - c) * m * (0.05 / scl);
    let rim = (1.0 - smoothstep(rad * 0.45, rad, d)) * smoothstep(rad * 0.55, rad, d) * m;
    return vec4<f32>(offset, m, rim);
}

// ── KHR PBR Neutral tonemap — Babylon toneMappingType 2. The client's comment
//    said "ACES" but in Babylon 2 = TONEMAPPING_KHR_PBR_NEUTRAL (ACES is 1), so
//    the browser actually renders through this hue-preserving Khronos curve:
//    skies keep their saturated blue instead of the warmer, desaturated wash
//    the Narkowicz ACES fit gave. Verbatim port of Babylon's
//    PBRNeutralToneMapping (imageProcessingFunctions.wgsl). ──
fn pbrNeutral(colorIn : vec3<f32>) -> vec3<f32> {
    let startCompression = 0.8 - 0.04;
    let desaturation = 0.15;
    let x = min(colorIn.r, min(colorIn.g, colorIn.b));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    var result = colorIn - offset;
    let peak = max(result.r, max(result.g, result.b));
    if (peak < startCompression) { return result; }
    let d = 1.0 - startCompression;
    let newPeak = 1.0 - d * d / (peak + d - startCompression);
    result *= newPeak / peak;
    let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(result, vec3<f32>(newPeak), g);
}

fn grainHash(p : vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let res = u.misc.xy;
    var uv = in.uv;

    // ── Telescope (telescope.service): while right-held, the frame inside the
    //    lens circle is resampled around the cursor at 1/zoom with a barrel
    //    bulge; the chromatic fringe joins at the scene sample below, the rim
    //    vignette + brass ring at the end of the grade (display space, like
    //    the client's post-tonemap pass). Aspect-corrected distance keeps the
    //    circle round on a wide screen. ──
    let teleR = u.tele.z;
    var teleRR = -1.0;        // 0 centre .. 1 rim inside the lens (-1 = outside)
    var teleDist = 1.0e9;
    if (teleR > 0.001) {
        var td = in.uv - u.tele.xy;
        td.x *= res.x / res.y;
        teleDist = length(td);
        if (teleDist < teleR) {
            teleRR = clamp(teleDist / teleR, 0.0, 1.0);
            let bulge = 1.0 + 0.34 * teleRR * teleRR;   // image compresses toward the rim
            uv = u.tele.xy + (in.uv - u.tele.xy) * (bulge / u.tele.w);
        }
    }

    // ── Rain lens: drops + trails refract the scene under them. The Heartfelt
    //    math assumes ShaderToy's y-up fragCoord — our uv is y-down, so flip into
    //    y-up space (else the drops climb and trails hang above them). ──
    let rainAmount = clamp(u.misc.w, 0.0, 1.0);
    if (rainAmount > 0.02) {
        let fragCoord = in.uv * res;
        let ruv = vec2<f32>(fragCoord.x - 0.5 * res.x, 0.5 * res.y - fragCoord.y) / res.y;
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
        uv += vec2<f32>(cx - c.x, -(cy - c.x));   // refraction normal (y flipped back to y-down uv)
    }

    var col = textureSampleLevel(sceneTex, samp, uv, 0.0).rgb;

    // Telescope chromatic aberration: coloured fringes grow toward the rim
    // (the R/B channels resample at slightly different magnifications).
    if (teleRR >= 0.0) {
        let ca = 0.006 * teleRR;
        let bulge = 1.0 + 0.34 * teleRR * teleRR;
        let off = (in.uv - u.tele.xy) * (bulge / u.tele.w);
        col.r = textureSampleLevel(sceneTex, samp, u.tele.xy + off * (1.0 + ca), 0.0).r;
        col.b = textureSampleLevel(sceneTex, samp, u.tele.xy + off * (1.0 - ca), 0.0).b;
    }

    // ── Big sliding lens drops (the browser's second, stacked lens pass). It ran
    //    BEFORE the Heartfelt pass there, so here it reads through the Heartfelt-
    //    refracted uv — same composition order. The dropLayer math is y-up. ──
    if (rainAmount > 0.02) {
        let aspect = res.x / res.y;
        let dl_uv = vec2<f32>(uv.x * aspect, 1.0 - uv.y);
        let l1 = dropLayerBig(dl_uv, 6.0, 0.0, u.misc.z);
        let l2 = dropLayerBig(dl_uv, 10.0, 23.0, u.misc.z);
        let offset = vec2<f32>(l1.x + l2.x, -(l1.y + l2.y));   // back to y-down uv space
        let cover = max(l1.z, l2.z);
        let rim = l1.w + l2.w;
        let amt = clamp(rainAmount * 1.4, 0.0, 1.0);
        let ruv2 = clamp(uv + offset * amt, vec2<f32>(0.001), vec2<f32>(0.999));
        let refr = textureSampleLevel(sceneTex, samp, ruv2, 0.0).rgb;
        col = mix(col, refr, clamp(cover * amt, 0.0, 1.0));
        col += vec3<f32>(rim * amt * 0.08);
    }

    // ── Depth of field merge: blend toward the half-res CoC-blurred scene by the
    //    full-res CoC (per-pixel from depth, so the ship's silhouette stays crisp
    //    against a soft horizon instead of haloing). ──
    var focusK = 1.0;   // 1 = in focus (gates the sharpen below)
    if (u.dof.w > 0.5) {
        let dp = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.9995)) * res);
        let d = textureLoad(depthT, dp, 0);
        let dist = u.zp.y / (d + u.zp.x);
        let coc = clamp(u.dof.y * abs(dist - u.dof.x) / max(dist, 1.0), 0.0, 1.0);
        let blend = smoothstep(0.02, 0.40, coc);
        col = mix(col, textureSampleLevel(dofTex, samp, uv, 0.0).rgb, blend);
        focusK = 1.0 - blend;
    }

    // ── Sharpen (pipeline.sharpen edgeAmount) — restores rigging/deck crispness
    //    (faded out where DOF blurs, so it doesn't fight the defocus). ──
    if (u.fx.w > 0.001 && focusK > 0.01) {
        let px = 1.0 / res;
        var nb = textureSampleLevel(sceneTex, samp, uv + vec2<f32>(px.x, 0.0), 0.0).rgb;
        nb += textureSampleLevel(sceneTex, samp, uv - vec2<f32>(px.x, 0.0), 0.0).rgb;
        nb += textureSampleLevel(sceneTex, samp, uv + vec2<f32>(0.0, px.y), 0.0).rgb;
        nb += textureSampleLevel(sceneTex, samp, uv - vec2<f32>(0.0, px.y), 0.0).rgb;
        col = max(vec3<f32>(0.0), col + (col - nb * 0.25) * u.fx.w * focusK);
    }

    // ── SSAO multiply (runs before grading, like the client's SSAO2 pipeline
    //    which sat ahead of the DefaultRenderingPipeline). ──
    if (u.zp.z > 0.5) {
        col *= textureSampleLevel(aoTex, samp, uv, 0.0).r;
    }

    if (u.grade.w > 0.5) {
        // ── Bloom composite (thresholded half-res blur, additive by weight). ──
        col += textureSampleLevel(bloomTex, samp, uv, 0.0).rgb * u.grade.z;
        // ── Babylon applyImageProcessing, exact order: exposure (linear) ->
        //    vignette (linear, multiply mode) -> KHR PBR Neutral tonemap ->
        //    toGammaSpace + saturate -> contrast (GAMMA space, smoothstep
        //    curve — Babylon does NOT use a linear pivot) -> grain. ──
        // Exposure: the time-of-day base, optionally scaled by auto-exposure so the image self-levels
        // toward a mid-grey key (metered + eye-adapted in lumadapt.wgsl into the 1x1 lumTex).
        var expo = u.grade.x;
        if (u.ae.x > 0.5) {
            let L = max(textureLoad(lumTex, vec2<i32>(0, 0), 0).r, 1e-3);
            expo *= clamp(u.ae.y / L, u.ae.z, u.ae.w);
        }
        col *= expo;
        // Vignette: viewportXY in NDC, scaleY = tan(vignetteCameraFov/2) with the
        // default fov 0.5, scaleX = scaleY * aspect; term^( -2 * weight ). Black
        // vignette colour in multiply mode => straight multiplier.
        {
            let vXY = in.uv * 2.0 - 1.0;
            let vScaleY = 0.25534192;   // tan(0.25)
            let vScaleX = vScaleY * (res.x / res.y);
            let vXY1 = vec3<f32>(vXY.x * vScaleX, vXY.y * vScaleY, 1.0);
            let vig = pow(dot(vXY1, vXY1), -2.0 * u.fx.z);
            col *= vig;
        }
        col = pbrNeutral(col);
        var rgbG = clamp(pow(max(col, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2)), vec3<f32>(0.0), vec3<f32>(1.0));
        let highContrast = rgbG * rgbG * (3.0 - 2.0 * rgbG);
        if (u.grade.y < 1.0) {
            rgbG = mix(vec3<f32>(0.5), rgbG, u.grade.y);
        } else {
            rgbG = mix(rgbG, highContrast, u.grade.y - 1.0);
        }
        rgbG = max(rgbG, vec3<f32>(0.0));
        // ── Optional cinematic grade: gentle saturation push (zp.w = extra saturation, 0 = neutral),
        //    around the perceptual luma so hues deepen without shifting exposure. ──
        if (u.zp.w > 0.001) {
            let luma = dot(rgbG, vec3<f32>(0.2126, 0.7152, 0.0722));
            rgbG = max(mix(vec3<f32>(luma), rgbG, 1.0 + u.zp.w), vec3<f32>(0.0));
        }
        // ── Film grain (gamma space, like Babylon's grain pass): animated when
        //    fx.y > 0.5, static otherwise. ──
        let gseed = select(vec2<f32>(0.0), vec2<f32>(fract(u.misc.z * 13.7), fract(u.misc.z * 7.3)), u.fx.y > 0.5);
        let g = grainHash(in.uv * res * 0.5 + gseed) - 0.5;
        rgbG += g * u.fx.x;
        // ── Telescope rim: glass vignette + shaded brass ring, composed on the
        //    final display-space image exactly like the client's lens pass. ──
        if (teleR > 0.001) {
            let bw = teleR * 0.11;           // brass ring thickness
            let aa = 1.5 / res.y;            // ~1.5 px edge feather
            if (teleDist <= teleR + bw + aa) {
                // Vignette: darken toward the rim so the glass seats into the ring.
                if (teleRR >= 0.0) {
                    rgbG *= mix(1.0, 0.5, smoothstep(0.55, 1.0, teleRR));
                }
                let brassHi = vec3<f32>(0.58, 0.46, 0.20);
                let brassLo = vec3<f32>(0.22, 0.15, 0.04);
                let ring = clamp((teleDist - teleR) / bw, 0.0, 1.0);   // 0 inner .. 1 outer
                var brass = mix(brassHi, brassLo, ring);
                brass += brassHi * 0.28 * smoothstep(0.16, 0.0, abs(ring - 0.28));   // highlight band
                brass *= 0.9 + 0.1 * cos(ring * 12.0);                              // machined sheen
                let onRing = smoothstep(teleR - aa, teleR + aa, teleDist)
                           * smoothstep(teleR + bw + aa, teleR + bw - aa, teleDist);
                rgbG = mix(rgbG, brass, onRing);
            }
        }
        // Back to linear: the sRGB swapchain re-encodes on write, so the display
        // sees Babylon's gamma-space result (2.2 vs sRGB piecewise ~ identical).
        col = pow(clamp(rgbG, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(2.2));
    }
    return vec4<f32>(col, 1.0);
}
