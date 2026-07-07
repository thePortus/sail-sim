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
@group(0) @binding(6) var<uniform> subInfo : vec4<u32>;
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

// Morph + skin a vertex to model-local space (shared by both vertex entries).
fn skinLocal(vid : u32, inPos : vec3<f32>, inJoints : vec4<f32>, inWeights : vec4<f32>) -> vec4<f32> {
    var p = inPos;
    for (var mi = 0u; mi < subInfo.x; mi = mi + 1u) {
        let e = morphTable[subInfo.y + mi];
        let wgt = pal.w[e.y >> 2u][e.y & 3u];
        if (wgt > 0.0001) {
            let di = (e.x + (vid - subInfo.z)) * 3u;
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
    let cbias = f32((subInfo.w >> 4u) & 0xFu);
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

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let baseTex = textureSample(baseColorTex, texSamp, in.uv).rgb;
    // Crew per-member garment tint: bits 0-3 of subInfo.w select a tint colour
    // stored in this instance's palette weight region (pal.w[32..40]). It REPLACES
    // the garment base colour (like the client's albedoColor swap), the texture
    // still modulating it. 0 = no tint (ships + the crew's skin/eyes) -> no-op.
    let tslot = subInfo.w & 0xFu;
    var albedo = in.albedo * baseTex;
    if (tslot != 0u) { albedo = pal.w[31u + tslot].rgb * baseTex; }
    // Per-instance faction stone tint (misc.yzw): a subtle limestone lean toward the owning
    // nation's hue on the harbour forts + walls. 1,1,1 on everything else -> a no-op.
    albedo = albedo * u.misc.yzw;
    let mrTex = textureSample(metalRoughTex, texSamp, in.uv);   // glTF: G=rough, B=metal
    let metallic = clamp(in.mr.x * mrTex.b, 0.0, 1.0);
    let roughness = clamp(in.mr.y * mrTex.g, 0.05, 1.0);

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

    let NDF = distributionGGX(N, H, roughness);
    let G = geometrySmith(N, V, L, roughness);
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
    let ambient = ambientFloor + skyIrr * albedo * 0.32 * (1.0 - metallic);   // additive; metals keep only the floor

    let color = ambient + Lo;
    // Output LINEAR HDR — no per-mesh tonemap. The scene target is RGBA16F and the single post
    // pass (exposure → KHR-Neutral tonemap → gamma) grades the whole frame at once. Reinhard-ing
    // here crushed bright specular/sunlit faces to ≤1 before the HDR buffer, so they double-
    // tonemapped (flat) and never reached the bloom bright-pass; leaving them linear fixes both.
    return vec4<f32>(color, 1.0);
}
