// Phase 1: metallic-roughness PBR (Cook-Torrance) with one directional light.
// Per-vertex material (albedo + metallic + roughness) comes from the glTF
// material factors, so a multi-material model shows its distinct surfaces. Image
// textures modulate these next.

struct Uniforms {
    mvp   : mat4x4<f32>,
    model : mat4x4<f32>,
    eye   : vec4<f32>,      // world-space camera position (xyz)
};
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var baseColorTex  : texture_2d<f32>;
@group(0) @binding(2) var baseColorSamp : sampler;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       worldPos : vec3<f32>,
    @location(1)       normal   : vec3<f32>,
    @location(2)       albedo   : vec3<f32>,
    @location(3)       mr       : vec2<f32>,   // metallic, roughness
    @location(4)       uv       : vec2<f32>,
};

@vertex
fn vs_main(@location(0) inPos    : vec3<f32>,
           @location(1) inNormal : vec3<f32>,
           @location(2) inUV     : vec2<f32>,
           @location(3) inAlbedo : vec3<f32>,
           @location(4) inMR     : vec2<f32>) -> VSOut {
    var out : VSOut;
    out.position = u.mvp * vec4<f32>(inPos, 1.0);
    out.worldPos = (u.model * vec4<f32>(inPos, 1.0)).xyz;
    out.normal   = normalize((u.model * vec4<f32>(inNormal, 0.0)).xyz);
    out.albedo   = inAlbedo;
    out.mr       = inMR;
    out.uv       = inUV;
    return out;
}

const PI : f32 = 3.14159265359;

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
    let texel = textureSample(baseColorTex, baseColorSamp, in.uv);
    let albedo = in.albedo * texel.rgb;     // material factor × base-colour map
    let metallic = clamp(in.mr.x, 0.0, 1.0);
    let roughness = clamp(in.mr.y, 0.05, 1.0);

    let N = normalize(in.normal);
    let V = normalize(u.eye.xyz - in.worldPos);
    let L = normalize(vec3<f32>(0.5, 1.0, 0.4));   // sun
    let H = normalize(V + L);

    let F0 = mix(vec3<f32>(0.04), albedo, metallic);
    let radiance = vec3<f32>(3.0);                 // sun intensity

    let NDF = distributionGGX(N, H, roughness);
    let G = geometrySmith(N, V, L, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    let numerator = NDF * G * F;
    let denom = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;
    let specular = numerator / denom;

    let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
    let NdotL = max(dot(N, L), 0.0);
    let Lo = (kD * albedo / PI + specular) * radiance * NdotL;

    let ambient = vec3<f32>(0.18) * albedo;
    var color = ambient + Lo;
    color = color / (color + vec3<f32>(1.0));       // Reinhard tonemap
    color = pow(color, vec3<f32>(1.0 / 2.2));        // gamma
    return vec4<f32>(color, 1.0);
}
