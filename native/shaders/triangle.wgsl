// Phase 1 "hello triangle": establishes the render-pipeline + vertex-buffer path.
// Per-vertex position (clip space) and colour; the fragment stage returns the
// interpolated colour. This is the machinery every mesh draw will reuse.

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       color    : vec3<f32>,
};

@vertex
fn vs_main(@location(0) inPos : vec2<f32>, @location(1) inColor : vec3<f32>) -> VSOut {
    var out : VSOut;
    out.position = vec4<f32>(inPos, 0.0, 1.0);
    out.color = inColor;
    return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}
