// Phase 1: camera + depth. A single MVP matrix places 3D geometry on screen; the
// depth buffer (configured on the pipeline + render pass) makes faces occlude
// correctly. Per-vertex colour so the cube's orientation reads at a glance.

struct Camera {
    mvp : mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera : Camera;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       color    : vec3<f32>,
};

@vertex
fn vs_main(@location(0) inPos : vec3<f32>, @location(1) inColor : vec3<f32>) -> VSOut {
    var out : VSOut;
    out.position = camera.mvp * vec4<f32>(inPos, 1.0);
    out.color = inColor;
    return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}
