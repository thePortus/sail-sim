// FFT ocean surface — 3 cascades summed (250/17/5 m tiles), shaded with the
// client's ocean-material math: derivative-map normals, Jacobian/turbulence foam,
// subsurface-scatter glow on wave backs, Fresnel sky reflection.

struct Camera {
    viewProj : mat4x4<f32>,
    eye      : vec4<f32>,   // xyz camera position
    params   : vec4<f32>,   // xyz = lengthScale0/1/2 (metres per tile); w = slope (wave-normal) amp
    screen   : vec4<f32>,   // xy = framebuffer size (px); zw = ocean origin (ship)
    lod      : vec4<f32>,   // x = vertex displacement amp; y = inner discard radius (far ring);
                            // z = rain intensity [0..1]; w = time (s) for the rain ripples
    sun      : vec4<f32>,   // xyz = light dir (sun by day, moon by night); w = daylight [0..1]
    tbounds  : vec4<f32>,   // terrain heightfield world bounds: minX, maxX, minZ, maxZ
    tmisc    : vec4<f32>,   // x,y = heightfield texel size; z = field ready; w = see-depth (m)
    proj     : vec4<f32>,   // x = proj[0][0], y = proj[1][1], z = proj[2][2], w = proj[3][2]
    cloud0   : vec4<f32>,   // x = coverage, y = cloud type, z = slab base (m), w = slab top (m)
    cloud1   : vec4<f32>,   // x,y = weather drift; z = flash count; w = wake boat count
    shadow0  : mat4x4<f32>, // world -> sun-shadow clip, tight ship cascade
    shadow1  : mat4x4<f32>, // world -> sun-shadow clip, wide landscape cascade
    shadowP  : vec4<f32>,   // x = enabled, y = bias 0, z = bias 1, w = shadow texel (uv)
    flash    : array<vec4<f32>, 6>,   // cannon glow pool: x, z, age, beam angle (count = cloud1.z)
    wakeMeta : array<vec4<f32>, 4>,   // per wake boat: x, z, point count, live speed
    wakePaths : array<vec4<f32>, 160>, // per point: x, z, age (s), speed-at-laydown (40/boat)
};

// Ship wake along each boat's actual (curved) CPU track (client _wakeCV): find
// the nearest point on the breadcrumb polyline, then build a turbulent core + a
// pair of diverging bow-wave edges that spread as the wake ages. Following the
// track means the wake bends through turns. Returns (core, edge); both fade
// with the track point's age.
fn wakeCV(wxz : vec2<f32>) -> vec2<f32> {
    var res = vec2<f32>(0.0);
    let nBoats = cam.cloud1.w;
    for (var b = 0; b < 4; b = b + 1) {
        if (f32(b) >= nBoats) { break; }
        let bmeta = cam.wakeMeta[b];                                  // x, z, count, speed
        let toBoat = wxz - bmeta.xy;
        if (dot(toBoat, toBoat) > 45000.0) { continue; }              // ~210 m cull per ship
        if (bmeta.z < 1.0) { continue; }
        let base = b * 40;
        var bestD = 1.0e9;
        var bestAge = 0.0;
        var bestSpd = 0.0;
        for (var i = 0; i < 39; i = i + 1) {
            if (f32(i) >= bmeta.z - 1.0) { break; }
            let a = cam.wakePaths[base + i].xy;
            let c = cam.wakePaths[base + i + 1].xy;
            let ab = c - a;
            let L2 = max(dot(ab, ab), 1.0e-3);
            let t = clamp(dot(wxz - a, ab) / L2, 0.0, 1.0);
            let d = length(wxz - (a + ab * t));
            if (d < bestD) {
                bestD = d;
                bestAge = mix(cam.wakePaths[base + i].z, cam.wakePaths[base + i + 1].z, t);
                bestSpd = mix(cam.wakePaths[base + i].w, cam.wakePaths[base + i + 1].w, t);
            }
        }
        // LIVE HEAD segment: newest laid point -> the ship's CURRENT position
        // (bmeta.xy/.w), age blending to 0 and speed to the live speed. The wake
        // head grows continuously with the hull, so a new breadcrumb landing
        // (exactly at the head's end) changes nothing visually — this removes
        // the 3 m chunk-pop each laid point used to cause. Gated on the same
        // live-speed threshold the tracker lays points with (|speed|x4 > 0.2),
        // so a stopped ship's trail still ages out completely.
        if (bmeta.w > 0.2) {
            let lastP = cam.wakePaths[base + i32(bmeta.z) - 1];
            let ab = bmeta.xy - lastP.xy;
            let L2 = max(dot(ab, ab), 1.0e-3);
            let t = clamp(dot(wxz - lastP.xy, ab) / L2, 0.0, 1.0);
            let d = length(wxz - (lastP.xy + ab * t));
            if (d < bestD) {
                bestD = d;
                bestAge = mix(lastP.z, 0.0, t);
                bestSpd = mix(lastP.w, bmeta.w, t);
            }
        }
        let ageFade = 1.0 - smoothstep(0.0, 11.0, bestAge);
        if (ageFade <= 0.001) { continue; }
        // Strength + width scale with how fast the ship was when it laid this
        // segment (bestSpd = abs speed x4): a crawling ship leaves a faint,
        // narrow trail; one at speed a broad, bright one. Old fast wakes stay
        // strong even after the ship slows.
        let speedFac = mix(0.08, 1.0, smoothstep(3.0, 16.0, bestSpd));
        let width = 1.6 + min(9.0, bestAge * 1.1) + min(6.0, bestSpd * 0.30);
        let coreW = max(1.5, width * 0.40);
        let core = exp(-(bestD * bestD) / (coreW * coreW)) * ageFade * speedFac;
        let edge = exp(-((bestD - width) * (bestD - width)) / 5.0) * ageFade * speedFac;
        res = max(res, vec2<f32>(core, edge));
    }
    return res;
}

// Cannon muzzle-flash glow (client _cannonFlashGlow): a brief warm pool of
// light on the sea under a firing muzzle, masked to the firing side of the
// keel so a port cannonade never lights the starboard water.
fn cannonFlashGlow(wxz : vec2<f32>) -> vec3<f32> {
    let n = cam.cloud1.z;
    if (n < 0.5) { return vec3<f32>(0.0); }
    var sum = vec3<f32>(0.0);
    for (var i = 0; i < 6; i = i + 1) {
        if (f32(i) >= n) { break; }
        let c = cam.flash[i].xy;
        let t01 = cam.flash[i].z / 0.45;
        if (t01 >= 1.0) { continue; }
        let env = (1.0 - t01) * (1.0 - t01);
        let r = length(wxz - c);
        let fall = exp(-(r * r) / 110.0);
        let D = vec2<f32>(cos(cam.flash[i].w), sin(cam.flash[i].w));
        let sFrag = dot(wxz - c, D) + 2.5;
        let sideMask = mix(0.08, 1.0, smoothstep(-1.5, 1.5, sFrag));
        sum += vec3<f32>(1.0, 0.52, 0.18) * env * fall * sideMask;
    }
    return sum;
}
@group(0) @binding(0)  var<uniform> cam : Camera;
@group(0) @binding(11) var reflTex : texture_2d<f32>;   // planar reflection RTT
@group(0) @binding(1)  var disp0  : texture_2d<f32>;
@group(0) @binding(2)  var deriv0 : texture_2d<f32>;
@group(0) @binding(3)  var turb0  : texture_2d<f32>;
@group(0) @binding(4)  var disp1  : texture_2d<f32>;
@group(0) @binding(5)  var deriv1 : texture_2d<f32>;
@group(0) @binding(6)  var turb1  : texture_2d<f32>;
@group(0) @binding(7)  var disp2  : texture_2d<f32>;
@group(0) @binding(8)  var deriv2 : texture_2d<f32>;
@group(0) @binding(9)  var turb2  : texture_2d<f32>;
@group(0) @binding(10) var samp   : sampler;
@group(0) @binding(12) var terrainH : texture_2d<f32>;   // R32F signed elevation (shallows)
@group(0) @binding(13) var sceneDepth : texture_depth_2d;   // pre-ocean depth snapshot
@group(0) @binding(14) var weatherT : texture_2d<f32>;      // cloud weather map (R8, tiling)
@group(0) @binding(15) var shadowT0 : texture_depth_2d;     // sun shadow, ship cascade
@group(0) @binding(16) var shadowT1 : texture_depth_2d;     // sun shadow, landscape cascade
@group(0) @binding(17) var shadowS : sampler_comparison;
@group(0) @binding(18) var foamTex : texture_2d<f32>;       // tiling foam blobs (wake froth break-up)

// Sun visibility from the shadow cascades: prefer the tight ship cascade when
// the point lands inside it (hull/rigging shadows on the water), else the wide
// one (island shadows). Out of both maps = lit.
fn sunShadowW(worldPos : vec3<f32>) -> f32 {
    if (cam.shadowP.x < 0.5) { return 1.0; }
    let sp0 = cam.shadow0 * vec4<f32>(worldPos, 1.0);
    let uv0 = vec2<f32>(sp0.x * 0.5 + 0.5, 0.5 - sp0.y * 0.5);
    if (uv0.x > 0.01 && uv0.x < 0.99 && uv0.y > 0.01 && uv0.y < 0.99 &&
        sp0.z > 0.0 && sp0.z < 1.0) {
        // Wide 5x5 PCF: water scatters light, so the hull and rigging shadows on the
        // surface read soft, not razor-cut. The per-tap step is FLOORED to a fixed UV
        // radius so higher-res maps (Ultra) don't sharpen the ship's reflection-soft
        // shadow — they just resolve the occluder better. shadowP.w = shadow texel.
        let step = max(cam.shadowP.w * 2.0, 2.0 / 2048.0);
        var s = 0.0;
        for (var dy = -2; dy <= 2; dy = dy + 1) {
            for (var dx = -2; dx <= 2; dx = dx + 1) {
                s += textureSampleCompareLevel(shadowT0, shadowS,
                        uv0 + vec2<f32>(f32(dx), f32(dy)) * step, sp0.z - cam.shadowP.y);
            }
        }
        return s / 25.0;
    }
    let sp1 = cam.shadow1 * vec4<f32>(worldPos, 1.0);
    let uv1 = vec2<f32>(sp1.x * 0.5 + 0.5, 0.5 - sp1.y * 0.5);
    if (uv1.x > 0.005 && uv1.x < 0.995 && uv1.y > 0.005 && uv1.y < 0.995 &&
        sp1.z > 0.0 && sp1.z < 1.0) {
        return textureSampleCompareLevel(shadowT1, shadowS, uv1, sp1.z - cam.shadowP.z);
    }
    return 1.0;
}

// Material constants (from ocean-material.ts).
const _Color       = vec3<f32>(0.015, 0.090, 0.130);
const _SkyColor    = vec3<f32>(0.45, 0.62, 0.82);
const _ReflStrength = 0.9;    // client ocean-material value — islands mirror visibly
const _SSSColor    = vec3<f32>(0.1541919, 0.8857628, 0.990566);
const _SSSStrength = 0.205;
const _SSSBase     = -0.261;
const _SSSScale    = 4.7;
const _FoamScale   = 2.6;
const _FoamBias    = 2.80;   // LOD2 (3 cascades)
const _Choppiness  = 0.3;

// Cascade LOD fade (client _LOD_scale): each cascade's contribution dies off
// with view distance — far water keeps only the broad 250 m swell, so it reads
// smooth and mirror-like instead of shimmering with full-strength 5 m chop.
const _LODScale = 7.13;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       worldPos : vec3<f32>,
    @location(1)       worldUV  : vec2<f32>,   // undisplaced grid xz (for texture sampling)
    @location(2)       lods     : vec4<f32>,   // xyz = cascade lod weights; w = SSS height factor
};

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
    let world = inXZ + cam.screen.zw;   // grid follows the ship (cam.screen.zw = ocean origin)
    let uv0 = world / cam.params.x;
    let uv1 = world / cam.params.y;
    let uv2 = world / cam.params.z;
    let viewDist = max(1.0, distance(cam.eye.xyz, vec3<f32>(world.x, 0.0, world.y)));
    let lod0 = min(_LODScale * cam.params.x / viewDist, 1.0);
    let lod1 = min(_LODScale * cam.params.y / viewDist, 1.0);
    let lod2 = min(_LODScale * cam.params.z / viewDist, 1.0);
    var disp = textureSampleLevel(disp0, samp, uv0, 0.0).xyz * lod0;
    let largeWavesBias = disp.y;
    disp += textureSampleLevel(disp1, samp, uv1, 0.0).xyz * lod1;
    disp += textureSampleLevel(disp2, samp, uv2, 0.0).xyz * lod2;
    // Vertex displacement amp (0 on the flat far ring). The hamp cap guards the
    // horizontal displacement against crest fold-over if the amp ever exceeds 1.
    let vamp = cam.lod.x;
    let hamp = min(vamp, 1.0 + max(vamp - 1.0, 0.0) * 0.35);
    disp = vec3<f32>(disp.x * hamp, disp.y * vamp, disp.z * hamp);

    // Wake riding on the swell (client HAS_WAKE vertex block): flatten the FFT
    // chop in the churned core (the boat smooths the water), carve a trough
    // there, and raise the diverging bow-wave crests.
    let wcv = wakeCV(world);
    disp *= (1.0 - 0.65 * wcv.x);
    disp.y += -0.80 * wcv.x + 0.70 * wcv.y;

    // Shoaling (client HAS_SHORE): flatten the swell as it runs into the beach —
    // full height in deep water, tapering to zero at the waterline — so shallows
    // don't chop wildly right against the sand. Reads the true seabed depth from
    // the heightfield (only once it's loaded: cam.tmisc.z = field-ready).
    if (cam.tmisc.z > 0.5) {
        let shoalDz = max(0.0, -tSampleH(world.x, world.y));
        disp *= smoothstep(0.4, 4.6, shoalDz);   // 0 by ~0.4 m deep, full by ~4.6 m
    }

    let p = vec3<f32>(world.x + disp.x, disp.y, world.y + disp.z);
    var out : VSOut;
    out.position = cam.viewProj * vec4<f32>(p, 1.0);
    out.worldPos = p;
    out.worldUV = world;
    out.lods = vec4<f32>(lod0, lod1, lod2,
                         max(disp.y - largeWavesBias * 0.8 - _SSSBase, 0.0) / _SSSScale);
    return out;
}

fn pow5(x : f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }

// ── Raindrop ripples (ocean-material HAS_RAIN port): expanding impact rings
//    dimple the wave normal near the camera while it rains. ──
fn rvHash(pIn : vec2<f32>) -> f32 {
    let p = pIn - floor(pIn / 512.0) * 512.0;
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn rainField(p : vec2<f32>, t : f32) -> f32 {
    let cell = floor(p);
    let f = fract(p);
    let h1 = rvHash(cell); let h2 = rvHash(cell + 5.7);
    let h3 = rvHash(cell + 11.3); let h4 = rvHash(cell + 19.1);
    let center = vec2<f32>(0.2 + h1 * 0.6, 0.2 + h2 * 0.6);
    let rate = mix(1.0, 3.2, h3);
    let life = fract(t * rate + h1 * 7.0);
    let r = length(f - center);
    let sz = mix(0.16, 0.42, h4);
    let impact = (1.0 - smoothstep(0.0, sz * 0.55, r)) * (1.0 - smoothstep(0.0, 0.22, life));
    let ringR = life * sz * 1.6;
    var ring = 1.0 - smoothstep(0.0, sz * 0.34, abs(r - ringR));
    ring *= smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.5, 1.0, life));
    return impact + ring * 0.6;
}

// Bilinear terrain elevation at a world XZ (same mapping as terrain.wgsl) — gives
// the TRUE vertical seabed depth per water fragment for the shallows reveal.
fn tLoadH(ix : i32, iz : i32) -> f32 {
    let w = i32(cam.tmisc.x); let h = i32(cam.tmisc.y);
    return textureLoad(terrainH, vec2<i32>(clamp(ix, 0, w - 1), clamp(iz, 0, h - 1)), 0).r;
}
fn tSampleH(wx : f32, wz : f32) -> f32 {
    let ux = (wx - cam.tbounds.x) / (cam.tbounds.y - cam.tbounds.x);
    let uz = (cam.tbounds.w - wz) / (cam.tbounds.w - cam.tbounds.z);   // +Z is south
    let tc = vec2<f32>(ux * cam.tmisc.x - 0.5, uz * cam.tmisc.y - 0.5);
    let i0 = vec2<i32>(floor(tc));
    let f  = fract(tc);
    let h00 = tLoadH(i0.x, i0.y);     let h10 = tLoadH(i0.x + 1, i0.y);
    let h01 = tLoadH(i0.x, i0.y + 1); let h11 = tLoadH(i0.x + 1, i0.y + 1);
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

// Value noise (matches the terrain shader's _dHash/_dVal) for the shoreline scallop.
fn shHash(p : vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn shVal(p : vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    let uu = f * f * (3.0 - 2.0 * f);
    return mix(mix(shHash(i), shHash(i + vec2<f32>(1.0, 0.0)), uu.x),
               mix(shHash(i + vec2<f32>(0.0, 1.0)), shHash(i + vec2<f32>(1.0, 1.0)), uu.x), uu.y);
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    // Far ring leaves the centre to the detailed near grid (cam.lod.y = 0 on near).
    if (distance(in.worldUV, cam.screen.zw) < cam.lod.y) { discard; }
    let uv0 = in.worldUV / cam.params.x;
    let uv1 = in.worldUV / cam.params.y;
    let uv2 = in.worldUV / cam.params.z;

    // Normal from summed derivative maps, cascades faded with distance like the
    // client (c0 always full; c1/c2 die off so far water reads smooth).
    var derivatives = textureSample(deriv0, samp, uv0);
    derivatives += textureSample(deriv1, samp, uv1) * in.lods.y;
    derivatives += textureSample(deriv2, samp, uv2) * in.lods.z;
    let slope = vec2<f32>(derivatives.x * cam.params.w / (1.0 + derivatives.z),
                          derivatives.y * cam.params.w / (1.0 + derivatives.w));
    var N = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));

    // Rain dimples the surface normal near the camera (client HAS_RAIN block).
    if (cam.lod.z > 0.01) {
        let nearF = 1.0 - smoothstep(25.0, 180.0, distance(cam.eye.xyz, in.worldPos));
        if (nearF > 0.001) {
            // Clock: the client sets _Time = seconds/10 and the shader does *10,
            // so the effective rain clock is PLAIN SECONDS (a raw t*10 here ran
            // the ripples 10x too fast). Density: client cells were worldUV*2.2
            // (~0.45 m); 1.7 spreads the impacts out a touch (~0.59 m cells).
            let rt = cam.lod.w;
            let rp = in.worldUV * 1.7;
            let e = 0.18;
            let n0 = rainField(rp, rt);
            let grad = vec2<f32>(rainField(rp + vec2<f32>(e, 0.0), rt) - n0,
                                 rainField(rp + vec2<f32>(0.0, e), rt) - n0) / e;
            N = normalize(N + vec3<f32>(grad.x, 0.0, grad.y) * (0.65 * cam.lod.z * nearF));
        }
    }

    let V = normalize(cam.eye.xyz - in.worldPos);
    let L = normalize(cam.sun.xyz);   // sun by day, moon by night

    // ── Cloud shadows: project this point along the light up to the cloud slab
    //    and evaluate the SAME 2-D weather coverage the volumetric raymarch
    //    shades with (vc_getDensity's largeWeather x coverage-threshold terms) —
    //    the water darkens exactly under the clouds you see. ──
    var cloudShadow = 1.0;
    if (cam.cloud0.x > 0.02 && L.y > 0.05) {
        let mid = mix(cam.cloud0.z, cam.cloud0.w, 0.35);
        let pc = in.worldPos + L * ((mid - in.worldPos.y) / L.y);
        let pzx = pc.zx + cam.cloud1.yx;
        let storm = smoothstep(0.40, 0.95, cam.cloud0.y);
        let largeW = clamp((textureSampleLevel(weatherT, samp, -0.00005 * pzx, 0.0).r - 0.18) * 5.0, 0.0, 2.0);
        let covThresh = 0.28 - (cam.cloud0.x - 0.5) * 0.5 - storm * 0.05;
        let weather = largeW * max(0.0, textureSampleLevel(weatherT, samp, 0.0002 * pzx, 0.0).r - covThresh) / 0.72;
        // Optical depth ~ 2-D density x slab thickness; the floor keeps full
        // shadow at "overcast sky", not "eclipse".
        let od = weather * mix(0.20, 0.32, storm) * 22.0;
        cloudShadow = max(exp(-od), 0.30);
    }
    // Geometry shadows (ship hull/rigging up close, islands at range) combine
    // with the cloud shadows into one direct-sun visibility factor.
    let sunVis = cloudShadow * sunShadowW(in.worldPos);

    // Foam from summed turbulence (Jacobian): folds/breaks read white.
    let foamChop = 1.0 - _Choppiness * 0.32;
    var jacobian = textureSample(turb0, samp, uv0).x
                 + textureSample(turb1, samp, uv1).x
                 + textureSample(turb2, samp, uv2).x;
    jacobian = min(1.0, max(0.0, (-jacobian + _FoamBias * foamChop) * _FoamScale));

    // Wake foam (client HAS_WAKE fragment block): bright churned core + thin
    // diverging bow-wave lines, broken up by a scrolling foam texture so it
    // reads as turbulent froth rather than a painted band. The client's _Time
    // uniform is seconds/10, hence the 0.1 on our plain-seconds clock.
    {
        let wcvF = wakeCV(in.worldUV);
        var wakeFoam = wcvF.x * 0.95 + wcvF.y * 0.85;
        let t10 = cam.lod.w * 0.1;
        let wfTex = textureSample(foamTex, samp, in.worldUV * 0.09 + t10 * 1.4).r
                  * textureSample(foamTex, samp, in.worldUV * 0.21 - t10 * 0.9).r;
        wakeFoam *= smoothstep(0.05, 0.45, wfTex + 0.18);
        jacobian = max(jacobian, clamp(wakeFoam, 0.0, 1.0));
    }

    // Subsurface scattering — back-lit turquoise glow on wave backs, sun-gated.
    let sunUp = smoothstep(0.0, 0.12, L.y);
    // Epsilon-guarded: on steep storm facets N can align with L, and
    // normalize(0) is NaN — which painted whole wave facets as black polygons.
    let hv = -N + L;
    let H = hv / max(length(hv), 1e-4);
    let viewDotH = pow5(clamp(dot(V, -H), 0.0, 1.0)) * 30.0 * _SSSStrength * sunUp * sunVis;
    // SSS gated by the near cascade's lod (client: mix by vLodScales.z) — the
    // turquoise glow is a close-up effect, distant water keeps the deep body colour.
    let color = mix(_Color,
                    clamp(_Color + _SSSColor * viewDotH * in.lods.w, vec3<f32>(0.0), vec3<f32>(1.0)),
                    in.lods.z);

    // ── Coastal shallows (client ocean-material Phase 4): TRUE vertical seabed
    //    depth from the terrain heightfield. reveal = the sand shows through up
    //    close; shallow = the broad band that suppresses the blue water terms;
    //    shoal = a turquoise water-column ring just past the clear-view depth. ──
    // Visibility falls off with view distance (scattering through the column):
    // full reach up close, opaque by ~400 m — also kills grazing-angle noise.
    let viewDist = distance(cam.eye.xyz, in.worldPos);
    let distFade = 1.0 - smoothstep(150.0, 400.0, viewDist);
    // ── Shoreline scallop + dither offset (metres, centred on 0). Port of the
    //    Angular waterline noise; applied below to BOTH the reveal shallows AND the
    //    Beer-Lambert see-through (the dominant term over sand) so the coastline
    //    reads as an organic, fuzzy line, not a smooth bathymetric contour. Two
    //    octaves (~1.4 m + ~4.6 m) make the scallop; a ~0.17 m octave (faded with
    //    range so it can't shimmer) fuzzes the edge; a ~8 s ±0.15 m wash breathes it.
    let ssp = in.worldPos.xz;
    // Undulation drift — same coefficients + clock (cam.lod.w) as the terrain
    // waterline scallop, so land + water travel together.
    let sDrift = vec2<f32>(cam.lod.w * 0.12, cam.lod.w * 0.05);
    let sScallop = shVal((ssp + sDrift) * 0.70) * 0.75 + shHash(floor((ssp + sDrift) * 2.3)) * 0.25;   // [0,1]
    let sGrain   = 1.0 - smoothstep(60.0, 220.0, viewDist);
    let sDither  = (shVal(ssp * 6.0) - 0.5) * sGrain;                            // ±0.5
    let sEbb = sin(cam.lod.w * 0.8 + ssp.x * 0.13 + ssp.y * 0.09) * 0.10
             + sin(cam.lod.w * 1.3 - ssp.y * 0.18) * 0.05;                       // ±0.15
    // Amplitude knobs (metres): SCALLOP breaks the coastline into ~1.4 m waves,
    // DITHER fuzzes that edge. Restrained so the shelf doesn't read as noise.
    let shoreNoiseM = (sScallop - 0.5) * 2.4 + sDither * 1.0 + sEbb;
    let seeDm = cam.tmisc.w;

    var reveal = 0.0;
    var shallow = 0.0;
    var shoal = 0.0;
    if (cam.tmisc.z > 0.5) {
        let dz0 = max(0.0, -tSampleH(in.worldUV.x, in.worldUV.y));
        // Hold full strength across the halo; fade only in genuinely deep water.
        let dz = max(0.0, dz0 + shoreNoiseM * (1.0 - smoothstep(seeDm * 2.6, seeDm * 4.5, dz0)));
        reveal  = (1.0 - smoothstep(0.0, seeDm, dz)) * distFade;
        shallow = (1.0 - smoothstep(0.0, seeDm * 2.2, dz)) * distFade;
        shoal   = smoothstep(seeDm, seeDm * 1.8, dz)
                * (1.0 - smoothstep(seeDm * 1.8, seeDm * 3.5, dz)) * distFade * (1.0 - reveal);
    }

    // ── Underwater see-through (Beer-Lambert): the pre-ocean depth snapshot holds
    //    whatever was drawn beneath this fragment (hull, seabed, wildlife). The
    //    slant water column between the surface and that point sets extra
    //    transparency — a keel a couple of metres down ghosts through, deep open
    //    water stays opaque (nothing behind but the far plane). ──
    var seeThru = 0.0;
    if (distFade > 0.001) {
        let sdim = vec2<f32>(textureDimensions(sceneDepth));
        let spx = vec2<i32>(clamp(in.position.xy, vec2<f32>(0.0), sdim - vec2<f32>(1.0)));
        let dScene = textureLoad(sceneDepth, spx, 0);
        let zScene = -cam.proj.w / (dScene + cam.proj.z);        // view z, negative forward
        let zSurf  = -cam.proj.w / (in.position.z + cam.proj.z);
        let fwd0 = max(zSurf - zScene, 0.0);                     // metres along the view axis
        // Same shoreline scallop wiggles the water-column depth near shore, so the
        // sand/water line the see-through paints is organic, not a smooth contour.
        let fwd  = max(0.0, fwd0 + shoreNoiseM * (1.0 - smoothstep(seeDm * 2.6, seeDm * 4.5, fwd0)));
        let path = fwd * viewDist / max(-zSurf, 0.001);          // slant path through the column
        seeThru = exp(-path * 0.5) * 0.85 * distFade;
    }

    // Fresnel sky reflection.
    var fresnel = clamp(1.0 - dot(N, V), 0.0, 1.0);
    fresnel = pow5(fresnel);
    var waterCol = color * (1.0 - fresnel);
    // Shoal water-column tint just beyond the clear-view depth (client: 0.10 * sunUp).
    waterCol = mix(waterCol, vec3<f32>(0.10, 0.48, 0.50) * (1.0 - fresnel), shoal * 0.10 * sunUp);
    // Kill the mirror glint across the shallows — transparent water over sand
    // reads as wet sand, never mirroring the sky (client reflCut).
    let reflCut = clamp(1.0 - max(reveal, shallow) * 1.6, 0.0, 1.0);
    // Planar reflection (sky + islands + ship + clouds), rippled by the surface
    // normal, strongest at grazing angles — plus the client's analytic-sky
    // remainder so the fresnel band never reads flat-dark.
    let reflUV = clamp(in.position.xy / cam.screen.xy + slope * 0.05, vec2<f32>(0.001), vec2<f32>(0.999));
    let reflColor = textureSample(reflTex, samp, reflUV).rgb;
    waterCol += reflColor * fresnel * _ReflStrength * reflCut;
    waterCol += _SkyColor * fresnel * (1.0 - _ReflStrength) * reflCut;

    // Sun glint. Epsilon-guarded: V can oppose L on wave facets, and
    // normalize(0) is NaN — the black-wedge artifact (view-dependent).
    // Distance gloss (client _RoughnessScale 0.0044 / _MaxGloss 0.91): the water
    // goes matte with range, so the horizon doesn't fizz with per-pixel sparkle.
    let hs2 = V + L;
    let Hs = hs2 / max(length(hs2), 1e-4);
    let glossK = 1.0 / (1.0 + viewDist * 0.0044);
    let glint = pow(max(dot(N, Hs), 0.0), mix(24.0, 300.0, glossK)) * 1.2 * glossK;
    waterCol += vec3<f32>(1.0, 0.96, 0.86) * glint * reflCut * sunVis;

    // Shadow the water body the way the client did: waterCol *= 1 - shadow*0.8
    // (cloud + geometry shadows read clearly; foam keeps its own sun dimming).
    waterCol *= 1.0 - (1.0 - sunVis) * 0.8;

    // Composite foam (lit white) over water.
    let foamLit = vec3<f32>(1.0) * (0.55 + 0.45 * max(dot(N, L), 0.0) * sunVis);
    var outColor = mix(waterCol, foamLit, jacobian);   // sRGB target does gamma
    // Day/night: darken and cool the sea toward night. The planar reflection (sky +
    // ship in reflTex) is already dark at night, so this only crushes the deep-water
    // body + glint; the surface still catches the moon and its reflection.
    let dayK = cam.sun.w;
    let bright = mix(0.30, 1.0, dayK);   // night floor raised with the land (was 0.10)
    let tint   = mix(vec3<f32>(0.42, 0.54, 0.82), vec3<f32>(1.0), dayK);
    outColor = outColor * bright * tint;
    // Aerial haze — the far water recedes into the same horizon colour as the land.
    let hd = distance(cam.eye.xyz, in.worldPos);
    let haze = 1.0 - exp(-pow(hd * 0.00009, 2.0));
    outColor = mix(outColor, mix(vec3<f32>(0.13, 0.155, 0.21), vec3<f32>(0.66, 0.72, 0.80), dayK), haze);
    outColor += cannonFlashGlow(in.worldUV);   // broadside glow on the water (emissive)
    // REAL transparency over the shallows — the client's exact composite: it mixed
    // the revealed seabed in at reveal * 0.9 (10% water colour always remains), so
    // our alpha is 1 - reveal * 0.9. The Beer-Lambert see-through takes over
    // wherever it opens the water more than the heightfield reveal does (a hull is
    // invisible to the heightfield). Foam stays opaque on top (composited last
    // there too), so breakers read solid white even over sand.
    let alpha = clamp(1.0 - max(reveal * 0.9, seeThru) + jacobian, 0.0, 1.0);
    return vec4<f32>(outColor, alpha);
}
