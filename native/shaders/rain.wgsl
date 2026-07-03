// Rain streaks (cloud.service Layer E port): one camera-facing quad per falling
// streak, alpha-TESTED so it writes depth and the cloud raymarch occludes BEHIND
// the rain (the client's SPS trick — its volumetric clouds were a post-process,
// exactly like ours). The whole lifecycle is stateless in the vertex shader:
// spawn box (±200 m around the camera, 110–155 m up), fall speeds 70–100 m/s,
// streak sizes 3–9 m × 0.05–0.16 m, wind lean + screen-space roll — the client's
// exact numbers; each recycle re-hashes the XZ spawn like the SPS respawn did.
// Active count (instanceCount) scales with precip intensity + the gust pulse.

struct RainU {
    mvp   : mat4x4<f32>,
    cam   : vec4<f32>,   // xyz = camera pos; w = time (s)
    axisR : vec4<f32>,   // xyz = billboard right, rolled by the wind lean; w = windX * tilt
    axisU : vec4<f32>,   // xyz = billboard up, rolled;                    w = windZ * tilt
};
@group(0) @binding(0) var<uniform> u : RainU;
@group(0) @binding(1) var tex  : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       uv       : vec2<f32>,
};

fn rh(n : f32) -> f32 { return fract(sin(n) * 43758.5453); }

@vertex
fn vs_main(@builtin(vertex_index) vid : u32, @builtin(instance_index) iid : u32) -> VSOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
        vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5));
    let c = corners[vid];
    let fi = f32(iid);
    let r1 = rh(fi * 12.9898 + 4.1414);
    let r2 = rh(fi * 78.233 + 1.313);
    let r3 = rh(fi * 37.719 + 9.151);
    let r4 = rh(fi * 93.989 + 2.369);
    let r5 = rh(fi * 53.371 + 7.793);

    let y0 = 110.0 + r1 * 45.0;          // spawn height above the camera
    let span = y0 + 55.0;                // fall distance until recycle (55 m below cam)
    let fall = 70.0 + r2 * 30.0;         // fall speed (m/s)
    let tot = fall * u.cam.w + r3 * span * 7.0;
    let k = fract(tot / span);
    let cyc = floor(tot / span);         // re-hash XZ each recycle (SPS respawn)
    let ox = (rh(fi * 3.7 + cyc * 17.131 + 0.123) * 2.0 - 1.0) * 200.0;
    let oz = (rh(fi * 9.31 + cyc * 23.719 + 5.7) * 2.0 - 1.0) * 200.0;
    let fallen = k * span;
    let len = 3.0 + r4 * 6.0;            // streak length (world m)
    let wid = 0.05 + r5 * 0.11;          // streak width (world m)

    // Fall + lean with the wind (drift per unit fall), then the rolled billboard.
    var wp = u.cam.xyz + vec3<f32>(ox + u.axisR.w * fallen, y0 - fallen, oz + u.axisU.w * fallen);
    wp += u.axisR.xyz * (c.x * wid) + u.axisU.xyz * (c.y * len);

    var o : VSOut;
    o.position = u.mvp * vec4<f32>(wp, 1.0);
    // v=1 (texture's long taper) at the TOP of the quad — the tail trails the fall.
    o.uv = vec2<f32>(c.x + 0.5, c.y + 0.5);
    return o;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    let s = textureSample(tex, samp, in.uv);
    if (s.a < 0.2) { discard; }   // client alphaCutOff 0.2 — keeps a hint of soft edge
    return vec4<f32>(s.rgb, 1.0);
}
