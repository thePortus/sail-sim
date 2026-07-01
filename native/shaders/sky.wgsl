// Procedural gradient sky drawn as a full-screen triangle behind everything.
// Reconstructs a world ray per pixel from the inverse view-projection.

struct SkyU {
    invViewProj : mat4x4<f32>,
    eye         : vec4<f32>,
    sun         : vec4<f32>,   // xyz = sun direction
};
@group(0) @binding(0) var<uniform> u : SkyU;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       ndc      : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
    var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var out : VSOut;
    out.position = vec4<f32>(pts[vid], 1.0, 1.0);   // z=1 (far)
    out.ndc = pts[vid];
    return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let far = u.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
    let world = far.xyz / far.w;
    let dir = normalize(world - u.eye.xyz);

    let t = clamp(dir.y, 0.0, 1.0);
    let horizon = vec3<f32>(0.80, 0.86, 0.92);
    let zenith  = vec3<f32>(0.20, 0.42, 0.72);
    var col = mix(horizon, zenith, pow(t, 0.45));

    let sd = max(dot(dir, normalize(u.sun.xyz)), 0.0);
    col += vec3<f32>(1.0, 0.95, 0.85) * pow(sd, 1400.0) * 2.0;    // sun disk
    col += vec3<f32>(1.0, 0.90, 0.75) * pow(sd, 12.0) * 0.12;     // sun glow

    col = pow(col, vec3<f32>(1.0 / 2.2));
    return vec4<f32>(col, 1.0);
}
