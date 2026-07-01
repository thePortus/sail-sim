// Phase 1: draw a loaded glTF mesh with simple directional (Lambert) shading.
// Two matrices: `mvp` places the vertex in clip space; `model` transforms the
// normal into world space for lighting. No textures yet — that's next.

struct Uniforms {
    mvp   : mat4x4<f32>,
    model : mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       normal   : vec3<f32>,
};

@vertex
fn vs_main(@location(0) inPos : vec3<f32>, @location(1) inNormal : vec3<f32>) -> VSOut {
    var out : VSOut;
    out.position = u.mvp * vec4<f32>(inPos, 1.0);
    out.normal = normalize((u.model * vec4<f32>(inNormal, 0.0)).xyz);
    return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let N = normalize(in.normal);
    let L = normalize(vec3<f32>(0.4, 1.0, 0.35));
    let diffuse = max(dot(N, L), 0.0);
    let shade = 0.25 + 0.85 * diffuse;          // ambient + diffuse
    let base = vec3<f32>(0.72, 0.68, 0.62);      // weathered stone
    return vec4<f32>(base * shade, 1.0);
}
