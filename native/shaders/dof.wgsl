// Depth of field (client DepthOfFieldEffect port, blur level Medium): keeps the
// player vessel sharp while softening the horizon and distant ships like a real
// telephoto lens. Babylon's circle-of-confusion formula with the client's optics
// (f/2.8, 85 mm, lens 50 mm) collapses to a far-field CoC of ~0.19; focus tracks
// the actual camera->ship distance instead of the client's hardcoded 8 m rig.
// fs_down: half-res scene downsample with CoC in alpha. fs_blur: CoC-scaled
// spiral gather, taps weighted by their own CoC so in-focus foreground pixels
// don't smear across a blurred background.

struct DofU {
    pmat : vec4<f32>,   // x = proj[0][0], y = proj[1][1], z = proj[2][2], w = proj[3][2]
    dof  : vec4<f32>,   // x = focus distance (m); y = CoC scale; z = max blur radius (half-res px); w = enabled
    misc : vec4<f32>,   // x,y = output resolution
};
@group(0) @binding(0) var<uniform> u : DofU;
@group(0) @binding(1) var depthT : texture_depth_2d;
@group(0) @binding(2) var srcTex : texture_2d<f32>;   // scene (down) / dof buffer (blur)
@group(0) @binding(3) var samp   : sampler;

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

// View-space distance from the hardware depth, then Babylon's CoC curve:
// coc = K * |dist - focus| / dist, clamped to [0,1].
fn cocAt(uv : vec2<f32>) -> f32 {
    let dims = vec2<f32>(textureDimensions(depthT));
    let p = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.9995)) * dims);
    let d = textureLoad(depthT, p, 0);
    let dist = u.pmat.w / (d + u.pmat.z);
    return clamp(u.dof.y * abs(dist - u.dof.x) / max(dist, 1.0), 0.0, 1.0);
}

@fragment
fn fs_down(in : VSOut) -> @location(0) vec4<f32> {
    let c = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb;
    return vec4<f32>(c, cocAt(in.uv));
}

@fragment
fn fs_blur(in : VSOut) -> @location(0) vec4<f32> {
    let center = textureSampleLevel(srcTex, samp, in.uv, 0.0);
    let r = center.a * u.dof.z;
    if (r < 0.5 || u.dof.w < 0.5) { return center; }
    let px = 1.0 / u.misc.xy;
    var acc = center.rgb * 0.35;
    var wsum = 0.35;
    // Golden-angle spiral disc, radius scaled by the centre's CoC.
    for (var i = 0; i < 24; i = i + 1) {
        let th = f32(i) * 2.3999632;
        let rad = sqrt((f32(i) + 0.5) / 24.0) * r;
        let s = textureSampleLevel(srcTex, samp, in.uv + vec2<f32>(cos(th), sin(th)) * rad * px, 0.0);
        let w = 0.10 + s.a;   // own-CoC weight: sharp taps barely contribute
        acc = acc + s.rgb * w;
        wsum = wsum + w;
    }
    return vec4<f32>(acc / wsum, center.a);
}
