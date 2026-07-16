// Physically-styled day/night sky, drawn as a full-screen triangle behind
// everything. Reconstructs a world ray per pixel from the inverse view-proj,
// then computes single-scattering Rayleigh/Mie atmosphere (port of the client's
// procedural-sky.ts BitOfGold scatter), plus a warm sun disc, a textured moon at
// the anti-solar point, and a star field — all faded by the sun's elevation so
// the sky eases from blue day → orange dusk → dark starry night.

struct SkyU {
    invViewProj : mat4x4<f32>,
    eye         : vec4<f32>,   // xyz camera position
    sun         : vec4<f32>,   // xyz = unit vector TOWARD the sun
    moon        : vec4<f32>,   // xyz = unit vector TOWARD the moon; w = moon fade [0..1]
    params      : vec4<f32>,   // x = star fade [0..1]; y = stars available; z = moon tex available; w unused
};
@group(0) @binding(0) var<uniform> u : SkyU;
@group(0) @binding(1) var moonTex  : texture_2d<f32>;
@group(0) @binding(2) var starsTex : texture_2d<f32>;
@group(0) @binding(3) var samp     : sampler;

// ── Scatter constants (from procedural-sky.ts) ──────────────────────────────
const M_PI:   f32 = 3.1415926535;
const HR:     f32 = 8000.0;        // Rayleigh scale height
const HM:     f32 = 1000.0;        // Mie scale height
const R0:     f32 = 6360000.0;     // planet radius
const RA:     f32 = 6380000.0;     // atmosphere radius
const HEIGHT: f32 = 500.0;         // viewer height above surface
const HAZE:   f32 = 0.0;           // aerosol floor (0 = clean blue)
const I_SUN:  f32 = 10.0;          // sun light power
const G:      f32 = 0.45;          // Mie phase asymmetry
const ENV:    f32 = 1.0;           // output gain
// Fewer march steps than the client's LUT bake (24/6): this runs per-pixel, and
// with clouds off the integral is smooth enough that 16/4 is visually identical.
const STEPS:  i32 = 16;
const STEPSS: i32 = 4;
const BR: vec3<f32> = vec3<f32>(5.8e-6, 13.5e-6, 33.1e-6);  // Rayleigh coefficients
const BM: vec3<f32> = vec3<f32>(21e-6, 21e-6, 21e-6);       // Mie coefficient
const C:  vec3<f32> = vec3<f32>(0.0, -6360000.0, 0.0);      // planet centre (0,-R0,0)

fn densities(pos : vec3<f32>) -> vec2<f32> {
    let h = length(pos - C) - R0;
    return vec2<f32>(exp(-h / HR), exp(-h / HM) + HAZE);
}

fn escape(p : vec3<f32>, d : vec3<f32>, R : f32) -> f32 {
    let v = p - C;
    let b = dot(v, d);
    let det2 = b * b - (dot(v, v) - R * R);
    if (det2 < 0.0) { return -1.0; }
    let det = sqrt(det2);
    let t1 = -b - det;
    let t2 = -b + det;
    if (t1 >= 0.0) { return t1; }
    return t2;
}

fn scatter(o : vec3<f32>, d : vec3<f32>, Ds : vec3<f32>) -> vec3<f32> {
    let L = escape(o, d, RA);
    let mu = dot(d, Ds);
    let g2 = G * G;
    let opmu2 = 1.0 + mu * mu;
    let phaseR = 0.0596831 * opmu2;
    let phaseM = 0.1193662 * (1.0 - g2) * opmu2 / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * G * mu, 1e-4), 1.5));

    var depthR = 0.0;
    var depthM = 0.0;
    var R = vec3<f32>(0.0);
    var M = vec3<f32>(0.0);
    let dl = L / f32(STEPS);
    for (var i : i32 = 0; i < STEPS; i = i + 1) {
        let p = o + d * (f32(i) * dl);
        let dens = densities(p);
        let dR = dens.x * dl;
        let dM = dens.y * dl;
        depthR = depthR + dR;
        depthM = depthM + dM;
        let Ls = escape(p, Ds, RA);
        if (Ls > 0.0) {
            let dls = Ls / f32(STEPSS);
            var depthRs = 0.0;
            var depthMs = 0.0;
            for (var j : i32 = 0; j < STEPSS; j = j + 1) {
                let ps = p + Ds * (f32(j) * dls);
                let densS = densities(ps);
                depthRs = depthRs + densS.x * dls;
                depthMs = depthMs + densS.y * dls;
            }
            let A = exp(-(BR * (depthRs + depthR) + BM * (depthMs + depthM)));
            R = R + A * dR;
            M = M + A * dM;
        }
    }
    return I_SUN * (R * BR * phaseR + M * BM * phaseM);
}

fn pow5(x : f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }

// Equirectangular lookup: dir -> uv (matches the client's star-dome mapping).
fn equirect(dir : vec3<f32>) -> vec2<f32> {
    let uu = atan2(dir.z, dir.x) / (2.0 * M_PI) + 0.5;
    let vv = acos(clamp(dir.y, -1.0, 1.0)) / M_PI;
    return vec2<f32>(uu, vv);
}

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
    let viewDir = normalize(world - u.eye.xyz);
    let Ds = normalize(u.sun.xyz);

    // Below-horizon fold (reference) so the lower hemisphere isn't pure black in
    // any gap the ocean doesn't cover.
    var D = viewDir;
    if (D.y <= -0.15) { D = normalize(vec3<f32>(D.x, -0.3 - D.y, D.z)); }

    // Sky brightness fades as the sun sinks past the horizon (dusk -> dark night).
    let att = mix(0.02, 1.0, smoothstep(-0.25, 0.06, Ds.y));
    let O = vec3<f32>(0.0, HEIGHT, 0.0);
    var color = scatter(O, D, Ds) * att * ENV;

    // ── Daytime blue: single-scatter over-extinguishes blue on the long horizon
    //    path, so blend toward a clean gradient while the sun is up. ──
    let dayF = smoothstep(0.0, 0.30, Ds.y);
    let DAY_ZENITH  = vec3<f32>(0.07, 0.20, 0.52);
    let DAY_HORIZON = vec3<f32>(0.42, 0.60, 0.85);
    let dayGrad = mix(DAY_HORIZON, DAY_ZENITH, smoothstep(0.0, 0.6, D.y));
    color = mix(color, dayGrad, dayF * 0.78);

    // ── Sundown shaping: warm grade + darken the upper sky into a twilight band. ──
    let warmF = 1.0 - smoothstep(0.0, 0.30, max(Ds.y, 0.0));
    let dusk  = warmF * smoothstep(-0.35, -0.05, Ds.y);
    let SUNSET_GRADE = vec3<f32>(0.98, 0.86, 0.66);
    color = color * mix(vec3<f32>(1.0), SUNSET_GRADE, warmF);
    let upDark = smoothstep(0.03, 0.45, D.y) * dusk;
    color = color * (1.0 - upDark * 0.88);

    // ── Golden-hour horizon glow + sea-mist band (port of the client's beauty pass 3 —
    //    procedural-sky.ts; this is what makes its sunrises/sunsets dramatic). goldenLow is
    //    strong at dawn/dusk (sun low but up), 0 at high noon AND at deep night. ──
    let sunUp     = smoothstep(-0.10, 0.08, Ds.y);
    let goldenLow = warmF * sunUp;
    // (A) Near-sun scattering AUREOLE — a soft deep-orange halo flooding the sky around the
    //     low sun. Additive linear HDR; the post grade tonemaps it downstream.
    let sunMu   = max(dot(D, Ds), 0.0);
    let aureole = pow(sunMu, 6.0);
    color = color + vec3<f32>(1.0, 0.52, 0.22) * (aureole * goldenLow * 0.9);
    // (B) SEA-MIST BAND — pale low haze hugging the horizon line, cool by day-edge and
    //     warming to amber at full sunset; lifts the waterline behind distant islands.
    let mistBand = smoothstep(0.14, 0.0, abs(D.y));
    let mistCol  = mix(vec3<f32>(0.62, 0.66, 0.74), vec3<f32>(0.96, 0.74, 0.52), warmF);
    color = mix(color, mistCol, mistBand * goldenLow * 0.38);

    // ── Stars: real all-sky map, faded in below the horizon-sun, above the sea. ──
    let starFade = u.params.x * u.params.y * smoothstep(-0.03, 0.06, viewDir.y);
    if (starFade > 0.001) {
        let s = textureSampleLevel(starsTex, samp, equirect(viewDir), 0.0).rgb;
        color = color + s * (0.35 + s) * starFade * 2.2;   // lift mids for the Milky Way, keep bright stars punchy
    }

    // ── Moon: textured disc at the anti-solar point, spherically shaded, with a
    //    soft glow halo (emulates the client's glow-layer bloom on the moon disc). ──
    let moonFade = u.moon.w;
    if (moonFade > 0.001) {
        let Dm = normalize(u.moon.xyz);
        let cosM = dot(viewDir, Dm);
        // Halo: a tight inner rim glow plus a wider soft bloom around the disc.
        let halo = (pow(max(cosM, 0.0), 1600.0) * 0.55 + pow(max(cosM, 0.0), 320.0) * 0.16) * moonFade;
        color = color + vec3<f32>(0.60, 0.70, 0.92) * halo;
        let ANG = 0.99977;   // cos of ~1.2 deg radius — matches the client's moon size
        if (cosM > ANG) {
            // Local disc coords in a frame around the moon direction. Pick a reference
            // axis that isn't parallel to Dm (else the cross product degenerates when
            // the moon is near the zenith — e.g. exactly midnight).
            var axisRef = vec3<f32>(0.0, 1.0, 0.0);
            if (abs(Dm.y) > 0.98) { axisRef = vec3<f32>(1.0, 0.0, 0.0); }
            let right = normalize(cross(axisRef, Dm));
            let up    = cross(Dm, right);
            let inv   = 1.0 / sqrt(1.0 - ANG * ANG);
            let lx = dot(viewDir, right) * inv;
            let ly = dot(viewDir, up)    * inv;
            let r2 = lx * lx + ly * ly;
            if (r2 <= 1.0) {
                let lz = sqrt(1.0 - r2);                 // sphere bulge -> limb darkening
                var moonCol = vec3<f32>(1.05, 1.06, 1.10);
                if (u.params.z > 0.5) {
                    let muv = vec2<f32>(0.5 + 0.46 * lx, 0.5 - 0.46 * ly);
                    // The lunar albedo map is dark grey; lift it well above 1.0 so the
                    // disc reads as a bright, self-luminous full moon (it emits the halo).
                    moonCol = textureSampleLevel(moonTex, samp, muv, 0.0).rgb * 3.4 + vec3<f32>(0.10);
                }
                let shade = 0.62 + 0.38 * lz;            // gentle limb darkening (keep the disc bright)
                let edge  = smoothstep(1.0, 0.90, r2);   // soft antialiased rim
                color = mix(color, moonCol * shade, moonFade * edge);
            }
        }
    }

    // ── Sun: warm disc + glow, fading out below the horizon. ──
    let sunAmt  = max(dot(viewDir, Ds), 0.0);
    let sunFade = smoothstep(-0.06, 0.03, Ds.y);
    let sunCol  = mix(vec3<f32>(1.0, 0.42, 0.14), vec3<f32>(1.0, 0.96, 0.86),
                      smoothstep(0.0, 0.32, Ds.y));
    let above   = max(0.0, Ds.y);
    let disc    = pow(sunAmt, mix(1500.0, 4200.0, above));   // bigger low in the sky
    color = color + sunCol * disc * 2.2 * sunFade;
    color = color + sunCol * pow(sunAmt, 12.0) * 0.10 * sunFade;

    return vec4<f32>(color, 1.0);   // sRGB target does gamma
}
