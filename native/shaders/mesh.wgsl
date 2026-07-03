// Phase 1: textured metallic-roughness PBR. Base-colour, normal, and
// metallic-roughness maps come from the glTF material (KTX2). Tangent frame is
// derived from screen-space derivatives (no TANGENT attribute needed).

struct Uniforms {
    mvp   : mat4x4<f32>,
    model : mat4x4<f32>,
    eye   : vec4<f32>,      // world-space camera position (xyz)
    sun   : vec4<f32>,      // xyz = light dir (sun by day, moon by night); w = daylight [0..1]
    misc  : vec4<f32>,      // x = hull-local mask floor Y (used by the stencil stamp, not here)
};
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var baseColorTex  : texture_2d<f32>;
@group(0) @binding(2) var normalTex     : texture_2d<f32>;
@group(0) @binding(3) var metalRoughTex : texture_2d<f32>;
@group(0) @binding(4) var texSamp       : sampler;
// Unified matrix palette (gltf_rig): node worlds first, then skin joint
// matrices. Rigid vertices reference their node slot with weight 1; skinned
// vertices their joint slots — one path for both, animation = palette rewrite.
@group(0) @binding(5) var<uniform> pal : array<mat4x4<f32>, 128>;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       worldPos : vec3<f32>,
    @location(1)       normal   : vec3<f32>,
    @location(2)       albedo   : vec3<f32>,
    @location(3)       mr       : vec2<f32>,   // metallic, roughness factors
    @location(4)       uv       : vec2<f32>,
};

@vertex
fn vs_main(@location(0) inPos     : vec3<f32>,
           @location(1) inNormal  : vec3<f32>,
           @location(2) inUV      : vec2<f32>,
           @location(3) inAlbedo  : vec3<f32>,
           @location(4) inMR      : vec2<f32>,
           @location(5) inJoints  : vec4<f32>,
           @location(6) inWeights : vec4<f32>) -> VSOut {
    let skinM = inWeights.x * pal[u32(inJoints.x)] + inWeights.y * pal[u32(inJoints.y)]
              + inWeights.z * pal[u32(inJoints.z)] + inWeights.w * pal[u32(inJoints.w)];
    let lp = skinM * vec4<f32>(inPos, 1.0);
    let ln = skinM * vec4<f32>(inNormal, 0.0);
    var out : VSOut;
    out.position = u.mvp * lp;
    out.worldPos = (u.model * lp).xyz;
    out.normal   = normalize((u.model * ln).xyz);
    out.albedo   = inAlbedo;
    out.mr       = inMR;
    out.uv       = inUV;
    return out;
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
    let albedo = in.albedo * textureSample(baseColorTex, texSamp, in.uv).rgb;
    let mrTex = textureSample(metalRoughTex, texSamp, in.uv);   // glTF: G=rough, B=metal
    let metallic = clamp(in.mr.x * mrTex.b, 0.0, 1.0);
    let roughness = clamp(in.mr.y * mrTex.g, 0.05, 1.0);

    let Ngeom = normalize(in.normal);
    let texN = normalize(textureSample(normalTex, texSamp, in.uv).xyz * 2.0 - vec3<f32>(1.0));
    let N = perturbNormal(Ngeom, in.worldPos, in.uv, texN);

    let V = normalize(u.eye.xyz - in.worldPos);
    let L = normalize(u.sun.xyz);                  // sun by day, moon by night
    let H = normalize(V + L);

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
    let Lo = (kD * albedo / PI + specular) * radiance * NdotL;

    let ambient = mix(vec3<f32>(0.10, 0.13, 0.20), vec3<f32>(0.18), dayK) * albedo;
    var color = ambient + Lo;
    color = color / (color + vec3<f32>(1.0));       // Reinhard tonemap (sRGB target does gamma)
    return vec4<f32>(color, 1.0);
}
