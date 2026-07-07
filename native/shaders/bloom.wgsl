// Bloom (client DefaultRenderingPipeline: kernel 48 @ 0.33 scale, threshold +
// weight driven live by time of day). Three entry points sharing one module:
// fs_bright thresholds the HDR scene into a half-res buffer; fs_blur runs a
// separable 9-tap Gaussian (direction in the uniform) H then V.

struct BloomU {
    params : vec4<f32>,   // x = threshold; y,z = blur direction (px units); w unused
};
@group(0) @binding(0) var<uniform> u : BloomU;
@group(0) @binding(1) var src  : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       uv       : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
    var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var o : VSOut;
    o.position = vec4<f32>(pts[vid], 0.0, 1.0);
    o.uv = vec2<f32>((pts[vid].x + 1.0) * 0.5, (1.0 - pts[vid].y) * 0.5);
    return o;
}

@fragment
fn fs_bright(in : VSOut) -> @location(0) vec4<f32> {
    let c = textureSampleLevel(src, samp, in.uv, 0.0).rgb;
    let lum = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    let k = max(0.0, lum - u.params.x) / max(lum, 1e-4);
    return vec4<f32>(c * k, 1.0);
}

@fragment
fn fs_blur(in : VSOut) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(src));
    let d = u.params.yz / dims;
    var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb * 0.227027;
    c += textureSampleLevel(src, samp, in.uv + d * 1.3846, 0.0).rgb * 0.316216;
    c += textureSampleLevel(src, samp, in.uv - d * 1.3846, 0.0).rgb * 0.316216;
    c += textureSampleLevel(src, samp, in.uv + d * 3.2308, 0.0).rgb * 0.070270;
    c += textureSampleLevel(src, samp, in.uv - d * 3.2308, 0.0).rgb * 0.070270;
    return vec4<f32>(c, 1.0);
}
