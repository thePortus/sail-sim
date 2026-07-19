// Phase 1: textured metallic-roughness PBR. Base-colour, normal, and
// metallic-roughness maps come from the glTF material (KTX2). Tangent frame is
// derived from screen-space derivatives (no TANGENT attribute needed).

struct Uniforms {
    mvp    : mat4x4<f32>,
    model  : mat4x4<f32>,
    eye    : vec4<f32>,     // world-space camera position (xyz)
    sun    : vec4<f32>,     // xyz = light dir (sun by day, moon by night); w = daylight [0..1]
    misc   : vec4<f32>,     // x = hull-local mask floor Y (used by the stencil stamp, not here)
    mvpCur : mat4x4<f32>,   // UNJITTERED current-frame clip (this ship) — TAA velocity only
    mvpPrev: mat4x4<f32>,   // UNJITTERED previous-frame clip (this ship's prev model) — TAA velocity only
    wet0   : vec4<f32>,     // hull wetness: x = waterline world Y ; y = wet-reach world Y (high-water mark) ; z = bow-spray boost ; w = rain wetness [0,1]
    wet1   : vec4<f32>,     // xy = ship centre world XZ ; zw = ship forward dir world XZ (for bow-spray localisation)
    wet2   : vec4<f32>,     // deck puddle map: x = hull half-length ; y = hull half-beam ; z = deck-map enabled (player ship) ; w unused
};
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var baseColorTex  : texture_2d<f32>;
@group(0) @binding(2) var normalTex     : texture_2d<f32>;
@group(0) @binding(3) var metalRoughTex : texture_2d<f32>;
@group(0) @binding(4) var texSamp       : sampler;
// Unified matrix palette (gltf_rig): node worlds first, then skin joint
// matrices, then the morph-target weights — one 9216-byte block per vessel
// INSTANCE (dynamic offset), so every ship animates independently.
struct Palette {
    m : array<mat4x4<f32>, 128>,
    w : array<vec4<f32>, 64>,   // morph weights, indexed by RigMorph slot
};
@group(0) @binding(5) var<uniform> pal : Palette;
// Morph machinery (static per mesh): per-submesh {count, tableBase, vertexBase, kit}.
// .w (kit) is 0 for ships; for crew garments it packs a per-instance tint slot in
// bits 0-3 (0 = none, else slot+1 -> pal.w[31+slot]) and a depth-bias LEVEL in bits
// 4-7 (layers an outer garment in front of the shirt without z-fighting).
struct SubInfoU { info : vec4<u32>, emissive : vec4<f32> };   // emissive = factor x KHR strength (lanterns)
@group(0) @binding(6) var<uniform> subInfo : SubInfoU;
@group(0) @binding(7) var<storage, read> morphDeltas : array<f32>;
@group(0) @binding(8) var<storage, read> morphTable : array<vec2<u32>>;

// ── Sun shadow (cascade 0: a tight orthographic box around the player vessel).
//    vs_shadow renders the casters into the depth-only map (layout binds just the
//    uniform); fs_main compares against it so masts, rigging and sails shadow the
//    deck. ──
struct ShadowU {
    vp     : mat4x4<f32>,   // world -> shadow clip
    params : vec4<f32>,     // x = enabled, y = depth bias, z = texel size (uv), w unused
};
@group(1) @binding(0) var<uniform> shadowU : ShadowU;
@group(1) @binding(1) var shadowT : texture_depth_2d;
@group(1) @binding(2) var shadowS : sampler_comparison;
@group(1) @binding(3) var deckMap : texture_2d<f32>;   // hull-local top-down puddle map (player ship)
@group(1) @binding(4) var deckSamp : sampler;
@group(1) @binding(5) var seaMap : texture_2d<f32>;    // hull-local FFT sea-height map (real waterline)
@group(1) @binding(6) var reflTex : texture_2d<f32>;   // planar sky/cloud reflection (deck puddles mirror it)

// Morph + skin a vertex to model-local space (shared by both vertex entries).
fn skinLocal(vid : u32, inPos : vec3<f32>, inJoints : vec4<f32>, inWeights : vec4<f32>) -> vec4<f32> {
    var p = inPos;
    for (var mi = 0u; mi < subInfo.info.x; mi = mi + 1u) {
        let e = morphTable[subInfo.info.y + mi];
        let wgt = pal.w[e.y >> 2u][e.y & 3u];
        // abs(): the synthetic sail-BILLOW morph takes NEGATIVE weights (belly flips to the other
        // tack); real furl/lid morphs only ever go 0..1 so they are unaffected.
        if (abs(wgt) > 0.0001) {
            let di = (e.x + (vid - subInfo.info.z)) * 3u;
            p += vec3<f32>(morphDeltas[di], morphDeltas[di + 1u], morphDeltas[di + 2u]) * wgt;
        }
    }
    let skinM = inWeights.x * pal.m[u32(inJoints.x)] + inWeights.y * pal.m[u32(inJoints.y)]
              + inWeights.z * pal.m[u32(inJoints.z)] + inWeights.w * pal.m[u32(inJoints.w)];
    return skinM * vec4<f32>(p, 1.0);
}

@vertex
fn vs_shadow(@builtin(vertex_index) vid : u32,
             @location(0) inPos     : vec3<f32>,
             @location(5) inJoints  : vec4<f32>,
             @location(6) inWeights : vec4<f32>) -> @builtin(position) vec4<f32> {
    return shadowU.vp * (u.model * skinLocal(vid, inPos, inJoints, inWeights));
}

// 3x3 PCF visibility at a world point. Geometric-normal offset + a small constant
// bias fight acne on the sunlit deck; out-of-map points count as lit.
fn sunShadow(worldPos : vec3<f32>, N : vec3<f32>) -> f32 {
    if (shadowU.params.x < 0.5) { return 1.0; }
    let sp = shadowU.vp * vec4<f32>(worldPos + N * 0.05, 1.0);
    let uv = vec2<f32>(sp.x * 0.5 + 0.5, 0.5 - sp.y * 0.5);
    if (uv.x <= 0.001 || uv.x >= 0.999 || uv.y <= 0.001 || uv.y >= 0.999 ||
        sp.z <= 0.0 || sp.z >= 1.0) { return 1.0; }
    let cmpZ = sp.z - shadowU.params.y;
    // Soft penumbra: 5x5 PCF whose per-tap step is FLOORED to a fixed UV radius, so
    // the ship's shadow stays soft at every shadow-quality level — a higher-res map
    // (Ultra 8192) samples the occluder more accurately without razor-sharpening the
    // edge. params.z is the shadow texel (1/res).
    let step = max(shadowU.params.z, 1.5 / 2048.0);
    var s = 0.0;
    for (var dy = -2; dy <= 2; dy = dy + 1) {
        for (var dx = -2; dx <= 2; dx = dx + 1) {
            s += textureSampleCompareLevel(shadowT, shadowS, uv + vec2<f32>(f32(dx), f32(dy)) * step, cmpZ);
        }
    }
    return s / 25.0;
}

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       worldPos : vec3<f32>,
    @location(1)       normal   : vec3<f32>,
    @location(2)       albedo   : vec3<f32>,
    @location(3)       mr       : vec2<f32>,   // metallic, roughness factors
    @location(4)       uv       : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32,
           @location(0) inPos     : vec3<f32>,
           @location(1) inNormal  : vec3<f32>,
           @location(2) inUV      : vec2<f32>,
           @location(3) inAlbedo  : vec3<f32>,
           @location(4) inMR      : vec2<f32>,
           @location(5) inJoints  : vec4<f32>,
           @location(6) inWeights : vec4<f32>) -> VSOut {
    // Morph targets (sail furl etc.) + skinning, shared with vs_shadow.
    let lp = skinLocal(vid, inPos, inJoints, inWeights);
    let skinM = inWeights.x * pal.m[u32(inJoints.x)] + inWeights.y * pal.m[u32(inJoints.y)]
              + inWeights.z * pal.m[u32(inJoints.z)] + inWeights.w * pal.m[u32(inJoints.w)];
    let ln = skinM * vec4<f32>(inNormal, 0.0);
    var out : VSOut;
    out.position = u.mvp * lp;
    // Crew garment layering: pull an outer layer slightly toward the camera (in
    // perspective-correct NDC) so it wins the depth test over the shirt beneath
    // instead of z-fighting it. Ships have subInfo.w = 0 -> no change.
    let cbias = f32((subInfo.info.w >> 4u) & 0xFu);
    out.position.z -= cbias * 0.00006 * out.position.w;
    out.worldPos = (u.model * lp).xyz;
    out.normal   = normalize((u.model * ln).xyz);
    out.albedo   = inAlbedo;
    out.mr       = inMR;
    out.uv       = inUV;
    return out;
}

// ── TAA motion vectors: re-draw the ship into the velocity buffer with its previous-frame model,
//    outputting per-pixel screen-UV motion so the TAA resolve reprojects the moving ship correctly
//    (camera-only depth reprojection can't — that's what ghosts the sails). Skinned identically to
//    vs_main so depths match the main pass (depth-test LessEqual, no write → only visible surface). ──
struct VelOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       curClip  : vec4<f32>,
    @location(1)       prevClip : vec4<f32>,
};
@vertex
fn vs_velocity(@builtin(vertex_index) vid : u32,
              @location(0) inPos     : vec3<f32>,
              @location(5) inJoints  : vec4<f32>,
              @location(6) inWeights : vec4<f32>) -> VelOut {
    let lp = skinLocal(vid, inPos, inJoints, inWeights);
    var o : VelOut;
    o.position = u.mvp * lp;        // JITTERED clip — matches the main pass so the depth test lines up
    o.curClip  = u.mvpCur * lp;     // unjittered current
    o.prevClip = u.mvpPrev * lp;    // unjittered previous (this ship's previous-frame model)
    return o;
}
@fragment
fn fs_velocity(in : VelOut) -> @location(0) vec4<f32> {
    let cur  = in.curClip.xy / in.curClip.w;
    let prev = in.prevClip.xy / in.prevClip.w;
    let velUV = (cur - prev) * vec2<f32>(0.5, -0.5);   // NDC delta → screen-UV delta (y flipped)
    return vec4<f32>(velUV, 0.0, 1.0);
}

const PI : f32 = 3.14159265359;

// Cotangent frame from screen-space derivatives (Christian Schüler). Perturbs the
// geometric normal N by a tangent-space normal-map sample without vertex tangents.
fn perturbNormal(N : vec3<f32>, worldPos : vec3<f32>, uv : vec2<f32>, texN : vec3<f32>) -> vec3<f32> {
    let dp1 = dpdx(worldPos);
    let dp2 = dpdy(worldPos);
    let duv1 = dpdx(uv);
    let duv2 = dpdy(uv);
    let dp2perp = cross(dp2, N);
    let dp1perp = cross(N, dp1);
    let T = dp2perp * duv1.x + dp1perp * duv2.x;
    let B = dp2perp * duv1.y + dp1perp * duv2.y;
    let invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
    return normalize(mat3x3<f32>(T * invmax, B * invmax, N) * texN);
}

fn distributionGGX(N : vec3<f32>, H : vec3<f32>, rough : f32) -> f32 {
    let a = rough * rough;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

fn geometrySchlickGGX(NdotX : f32, rough : f32) -> f32 {
    let r = rough + 1.0;
    let k = (r * r) / 8.0;
    return NdotX / (NdotX * (1.0 - k) + k);
}

fn geometrySmith(N : vec3<f32>, V : vec3<f32>, L : vec3<f32>, rough : f32) -> f32 {
    return geometrySchlickGGX(max(dot(N, V), 0.0), rough)
         * geometrySchlickGGX(max(dot(N, L), 0.0), rough);
}

fn fresnelSchlick(cosT : f32, F0 : vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

// Raindrop impact field — VERBATIM port of the ocean's rainField (ocean_surface.wgsl), so puddle
// droplets are the exact same size, density, and timing as the raindrops on the water: ~0.59 m cells,
// rings expanding to ~0.15-0.40 m radius, 1-3 drops/s per cell.
fn rvHashM(pIn : vec2<f32>) -> f32 {
    let p = pIn - floor(pIn / 512.0) * 512.0;
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn deckRainField(p : vec2<f32>, t : f32) -> f32 {
    let cell = floor(p);
    let f = fract(p);
    let h1 = rvHashM(cell); let h2 = rvHashM(cell + 5.7);
    let h3 = rvHashM(cell + 11.3); let h4 = rvHashM(cell + 19.1);
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

// Water-surface ripple at a hull-local metre position, animated by time. xy = UV distortion (capillary
// shimmer + droplet wavefronts), z = the droplet CREST [0,1] so the caller can light it up. Droplets
// come from deckRainField above — the ocean's rain rings at the ocean's scale.
fn puddleRipple(pm : vec2<f32>, t : f32, rain : f32) -> vec3<f32> {
    var r = vec2<f32>(0.0);
    r += vec2<f32>(sin(pm.x * 3.1 + t * 2.0), cos(pm.y * 2.7 - t * 1.7)) * 0.5;
    r += vec2<f32>(cos(pm.y * 5.3 - t * 2.4), sin(pm.x * 4.6 + t * 3.1)) * 0.28;
    var crest = 0.0;
    if (rain > 0.02) {
        let rp = pm * 1.7;   // same cell density as the ocean (rp = worldUV * 1.7)
        let e = 0.18;
        let n0 = deckRainField(rp, t);
        let grad = vec2<f32>(deckRainField(rp + vec2<f32>(e, 0.0), t) - n0,
                             deckRainField(rp + vec2<f32>(0.0, e), t) - n0) / e;
        r += grad * 0.55 * rain;
        crest = clamp(n0 * 0.8, 0.0, 1.0) * rain;
    }
    return vec3<f32>(r, crest);
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let baseTex = textureSample(baseColorTex, texSamp, in.uv).rgb;
    // Crew per-member garment tint: bits 0-3 of subInfo.info.w select a tint colour
    // stored in this instance's palette weight region (pal.w[32..40]). It REPLACES
    // the garment base colour (like the client's albedoColor swap), the texture
    // still modulating it. 0 = no tint (ships + the crew's skin/eyes) -> no-op.
    let tslot = subInfo.info.w & 0xFu;
    var albedo = in.albedo * baseTex;
    if (tslot != 0u) { albedo = pal.w[31u + tslot].rgb * baseTex; }
    // Per-instance faction stone tint (misc.yzw): a subtle limestone lean toward the owning
    // nation's hue on the harbour forts + walls. 1,1,1 on everything else -> a no-op.
    albedo = albedo * u.misc.yzw;
    let mrTex = textureSample(metalRoughTex, texSamp, in.uv);   // glTF: G=rough, B=metal
    let metallic = clamp(in.mr.x * mrTex.b, 0.0, 1.0);
    let roughness = clamp(in.mr.y * mrTex.g, 0.05, 1.0);

    // ── Hull wetness. The waterline follows the ACTUAL local sea surface: a hull-local map of the FFT
    //    wave height (seaMap) is sampled per fragment, so the wet line rises and falls with the real
    //    waves against each part of the hull — not a flat plane. wet0 = (splash reach, unused, bow-spray
    //    boost, rain) ; wet1 = (centre XZ, forward XZ) ; wet2 = (half-len, half-beam, enabled). ──
    let nUp = normalize(in.normal).y;
    // Hull-local coordinates (horizontal projection): along = bow..stern, across = port..stbd, in [0,1].
    let right = vec2<f32>(u.wet1.w, -u.wet1.z);
    let dxz = vec2<f32>(in.worldPos.x - u.wet1.x, in.worldPos.z - u.wet1.y);
    let along  = dot(dxz, u.wet1.zw) / (2.0 * u.wet2.x) + 0.5;
    let across = dot(dxz, right)     / (2.0 * u.wet2.y) + 0.5;
    let hullUV = clamp(vec2<f32>(across, along), vec2<f32>(0.0), vec2<f32>(1.0));

    var wetWL = 0.0;
    var wetDeck = 0.0;
    var localSea = -1.0e6;
    // Flatness: fwidth(worldY) ~ 0 on a flat horizontal deck (any view angle), large on curved or narrow
    // surfaces (barrel tops, caprails, fittings edges) — puddles only stand on flat deck floor. Computed
    // OUTSIDE the branch (WGSL derivative rules).
    let flatness = 1.0 - smoothstep(0.02, 0.09, fwidth(in.worldPos.y));
    if (u.wet2.z > 0.5) {   // player ship: real wave-following waterline + deck puddles
        localSea = textureSampleLevel(seaMap, deckSamp, hullUV, 0.0).r;   // raw sea height (m)
        // Splash reach (m) above the local sea surface, raised on the forward hull (bow spray).
        let fwdness = clamp(dot(normalize(dxz + vec2<f32>(1e-5, 1e-5)), u.wet1.zw), 0.0, 1.0);
        let reach = u.wet0.x + u.wet0.z * fwdness;
        wetWL = clamp(1.0 - smoothstep(localSea - 0.05, localSea + reach, in.worldPos.y), 0.0, 1.0);
        // Deck puddles: FLAT, truly up-facing deck floor from just above the local sea up to ~4 m — not
        // every up-facing fitting in the hull column (rails/barrels/carriages mirroring the sky read as
        // wrong blue swaths, not water).
        if (nUp > 0.6 && in.worldPos.y > localSea && in.worldPos.y < localSea + 4.0) {
            wetDeck = textureSampleLevel(deckMap, deckSamp, hullUV, 0.0).r * clamp(nUp, 0.0, 1.0) * flatness;
        }
    }
    // Rain wets from ABOVE: strongest on up-facing surfaces, less on the sides, dry underneath.
    let rainUp = clamp(nUp * 0.45 + 0.5, 0.0, 1.0);
    let damp = max(wetWL, u.wet0.w * rainUp);   // waterline band + rain film (material darkening)
    let puddle = wetDeck;                        // standing water pooled on the deck
    // SSR reflectivity mask: waterline band + puddles + rain-damp on UP-facing surfaces only. Rain-damp
    // verticals (bulwark panels, fittings sides) just darken — letting them drive SSR painted big
    // angle-dependent blue smears that read as glow, not water.
    let wet = max(max(wetWL, u.wet0.w * rainUp * clamp(nUp, 0.0, 1.0)), puddle);
    // A wet film darkens the diffuse and drops roughness (sharper highlights); a puddle goes near-mirror.
    // The environment reflection is left to SSR (the real scene) — no flat analytic sky tint.
    albedo = albedo * mix(mix(1.0, 0.68, damp), 0.5, puddle);   // puddle bottom: dark wet wood, grain still visible
    let roughW = mix(mix(roughness, 0.12, damp), 0.04, puddle);

    let Ngeom = normalize(in.normal);
    let texN = normalize(textureSample(normalTex, texSamp, in.uv).xyz * 2.0 - vec3<f32>(1.0));
    let N = perturbNormal(Ngeom, in.worldPos, in.uv, texN);

    let V = normalize(u.eye.xyz - in.worldPos);
    let L = normalize(u.sun.xyz);                  // sun by day, moon by night
    let hv = V + L;
    let H = hv / max(length(hv), 1e-4);            // epsilon: V ~ -L would NaN

    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    // Warm bright sunlight cross-fading to dim cool moonlight (u.sun.w = daylight).
    let dayK = u.sun.w;
    let radiance = mix(vec3<f32>(0.42, 0.50, 0.76), vec3<f32>(3.0), dayK);   // night floor raised with the scene

    let NDF = distributionGGX(N, H, roughW);
    let G = geometrySmith(N, V, L, roughW);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    let numerator = NDF * G * F;
    let denom = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;
    let specular = numerator / denom;

    let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
    let NdotL = max(dot(N, L), 0.0);
    // Cascade-0 sun shadow gates the DIRECT light only (rigging/mast/sail
    // shadows on the deck); ambient sky light is unaffected.
    let shadow = sunShadow(in.worldPos, Ngeom);
    let Lo = (kD * albedo / PI + specular) * radiance * NdotL * shadow;

    // ── Image-based lighting (A1): analytic sky dome from sun elevation (u.sun.y) + daylight (dayK).
    //    STRICTLY ADDITIVE diffuse hemisphere irradiance — the original neutral ambient stays as a
    //    floor (nothing gets darker) and a directional sky tint is added on top, so surfaces pick up
    //    the sky's hue and direction. Metals get only the floor (× (1-metallic)). There is NO specular
    //    sky reflection here: an analytic one blew the ship's smooth brass/metalwork out to white
    //    through the tonemap — proper environment reflection returns with SSR (A2), which is built to
    //    handle smooth surfaces. ──
    let el = max(u.sun.y, 0.0);
    let envAmp = 0.35 + 0.9 * el;
    let skyZenith = mix(vec3<f32>(0.03, 0.04, 0.07),  vec3<f32>(0.20, 0.40, 0.70), dayK) * envAmp;  // blue up
    let skyHoriz  = mix(vec3<f32>(0.05, 0.055, 0.075), vec3<f32>(0.62, 0.68, 0.78), dayK) * envAmp;  // pale horizon
    let up = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
    let skyIrr = mix(skyHoriz, skyZenith, up);
    let ambientFloor = mix(vec3<f32>(0.10, 0.13, 0.20), vec3<f32>(0.18), dayK) * albedo;
    // Sea bounce: the sunlit ocean is a huge reflector throwing light back UP onto the hull's shaded
    // side and underbelly. The sky hemisphere alone leaves exactly those away-from-sun / down-facing
    // faces on weak blue fill, so dark wood collapses to near-black through the tonemap. `down` is 1
    // straight-down, 0.5 horizontal, 0 up — so it lifts the shaded topsides + underbelly, not the deck.
    let down = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    let seaBounce = vec3<f32>(0.20, 0.29, 0.35) * dayK * down;
    let ambient = ambientFloor + (skyIrr * 0.42 + seaBounce) * albedo * (1.0 - metallic);   // additive; metals keep only the floor

    var color = ambient + Lo;
    // Material emissive (lantern glass, cabin windows): unlit HDR add — the bloom bright-pass turns
    // it into the night glow the client's emissive+glow-layer gives these materials.
    color = color + subInfo.emissive.rgb;
    // ── Deck puddles: an actual (shallow) water surface, not just a shiny patch. A pool samples the same
    //    planar sky/cloud reflection the ocean uses, its surface RIPPLING from a capillary shimmer + rain
    //    droplet rings (screen-UV distortion), and the wet wood shows THROUGH the water (refraction) at
    //    steep angles while the sky mirror takes over toward grazing — a real shallow-water look. Gated to
    //    deep puddles so only standing water does this. wet0.y/eye.w = render size ; wet2.w = time. ──
    let puddleDeep = smoothstep(0.25, 0.72, puddle);
    if (puddleDeep > 0.001 && u.wet0.y > 1.0) {
        let pm = (hullUV - 0.5) * vec2<f32>(u.wet2.y, u.wet2.x) * 2.0;   // hull-local metres (across, along)
        let ripC = puddleRipple(pm, u.wet2.w, u.wet0.w);
        // The rippling surface distorts the reflection → a moving water surface, not a flat shiny patch.
        let rip = ripC.xy * (0.55 + u.wet0.w * 0.9);
        let base = in.position.xy / vec2<f32>(u.wet0.y, u.eye.w);
        let screenUV = clamp(base + rip * 0.016, vec2<f32>(0.002), vec2<f32>(0.998));
        let reflC = textureSampleLevel(reflTex, deckSamp, screenUV, 0.0).rgb;
        // TRANSLUCENT water: the base is the wet wood seen THROUGH the puddle (this fragment's own
        // shading, ripple-shimmered), and the sky mirror comes in only by water's real Fresnel — ~3%
        // looking straight down, full mirror toward grazing. From above you see wood through water with
        // moving reflections on top, not a blue-coated deck.
        let cosNV = clamp(dot(N, V), 0.0, 1.0);
        let fresW = 0.03 + 0.97 * pow(1.0 - cosNV, 5.0);
        let bottom = color * (0.88 + 0.12 * ripC.x);                      // refraction shimmer on the wood
        let water = mix(bottom, reflC, clamp(fresW * 1.7, 0.0, 0.9));     // Fresnel-only mirror (mild boost)
        color = mix(color, water, puddleDeep);
        // Raindrop rings: the expanding wavefront crest catches the light — visible droplets in the water.
        color = color + vec3<f32>(1.0, 1.0, 1.0) * ripC.z * puddleDeep * 0.6;
    }
    // Output LINEAR HDR — no per-mesh tonemap. The scene target is RGBA16F and the single post
    // pass (exposure → KHR-Neutral tonemap → gamma) grades the whole frame at once. Reinhard-ing
    // here crushed bright specular/sunlit faces to ≤1 before the HDR buffer, so they double-
    // tonemapped (flat) and never reached the bloom bright-pass; leaving them linear fixes both.
    // Alpha carries the wetness = the SSR reflectivity mask (Phase 0 channel).
    return vec4<f32>(color, wet);
}
