// FFT ocean surface: samples the displacement / derivatives / turbulence textures
// produced by the compute cascade (src/ocean_fft.cpp) and shades the water.

struct Camera {
    viewProj : mat4x4<f32>,
    eye      : vec4<f32>,   // xyz camera position
    params   : vec4<f32>,   // x = lengthScale (metres per tile)
};
@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var dispTex  : texture_2d<f32>;
@group(0) @binding(2) var derivTex : texture_2d<f32>;
@group(0) @binding(3) var turbTex  : texture_2d<f32>;
@group(0) @binding(4) var texSamp  : sampler;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       worldPos : vec3<f32>,
    @location(1)       uv       : vec2<f32>,
};

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
    let uv = inXZ / cam.params.x;
    let disp = textureSampleLevel(dispTex, texSamp, uv, 0.0).xyz;
    let p = vec3<f32>(inXZ.x + disp.x, disp.y, inXZ.y + disp.z);
    var out : VSOut;
    out.position = cam.viewProj * vec4<f32>(p, 1.0);
    out.worldPos = p;
    out.uv = uv;
    return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let slope = textureSample(derivTex, texSamp, in.uv).xy;   // dy/dx, dy/dz
    let N = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
    let V = normalize(cam.eye.xyz - in.worldPos);
    let L = normalize(vec3<f32>(0.5, 1.0, 0.4));

    let deep    = vec3<f32>(0.010, 0.055, 0.090);
    let shallow = vec3<f32>(0.06, 0.26, 0.32);
    let sky     = vec3<f32>(0.52, 0.70, 0.86);
    let facing = clamp(dot(N, V), 0.0, 1.0);
    let fres = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
    var color = mix(mix(deep, shallow, facing), sky, fres);

    // Sun glint.
    let H = normalize(V + L);
    color += vec3<f32>(1.0, 0.96, 0.86) * pow(max(dot(N, H), 0.0), 300.0) * 1.5;

    // Foam where the surface folds (turbulence / Jacobian is low).
    let turb = textureSample(turbTex, texSamp, in.uv).x;
    let foam = clamp((0.5 - turb) * 1.2, 0.0, 1.0);
    color = mix(color, vec3<f32>(0.92, 0.96, 0.99), foam);

    color = pow(color, vec3<f32>(1.0 / 2.2));
    return vec4<f32>(color, 1.0);
}
