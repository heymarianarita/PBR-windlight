// Port of the Second Life viewer's legacy (WindLight) atmosphere to WebGL.
//
// Adapted from the Second Life Viewer source, Copyright (C) Linden Research, Inc.,
// licensed under the GNU Lesser General Public License, version 2.1:
//   app_settings/shaders/class1/deferred/skyF.glsl       sky colour
//   app_settings/shaders/class1/deferred/cloudsF.glsl    cloud layer
//   app_settings/shaders/class1/windlight/atmosphericsFuncs.glsl  calcAtmosphericVars
//   llinventory/llsettingssky.cpp                        sun direction, light settings
// https://github.com/secondlife/viewer — kept in its own file so the LGPL code stays separate.
//
// Changes: GLSL ES for three.js, y-up world, procedural cloud noise instead of the
// cloud texture, no rainbow/halo, plus a JS copy of the sky colour for CPU sampling.

import { toStored, SKY_PARAMS } from './params.js';

const byId = Object.fromEntries(SKY_PARAMS.map((p) => [p.id, p]));
const stored = (values, id) => {
  const p = byId[id];
  const v = values[id];
  return Array.isArray(v) ? v.map((x) => toStored(p, x)) : toStored(p, v);
};

// Shown slider values → the uniforms the viewer's shaders see.
export function skyUniforms(values) {
  const deg = Math.PI / 180;
  const east = values.eastAngle * deg;
  const alt = values.sunAngle * deg;
  // convert_azimuth_and_altitude_to_quat(azimuth = −east, altitude): +x east, +y north, +z up.
  // In three.js y is up and north is −z, so the SL vector (x, y, z) becomes (x, z, −y).
  const sun = [Math.cos(east) * Math.cos(alt), Math.sin(alt), Math.sin(east) * Math.cos(alt)];
  const moon = sun.map((c) => -c); // legacy moon is opposite the sun
  const sunUp = sun[1] >= 0;
  const moonUp = moon[1] >= 0;
  const moonBrightness = 0.5; // EEP default; not in the legacy format
  const glow = stored(values, 'glowSize');
  return {
    sunDir: sun,
    moonDir: moon,
    lightnorm: sunUp ? sun : moonUp ? moon : [0, -1, 0],
    sunUp,
    sunMoonGlowFactor: sunUp ? 1 : moonUp ? moonBrightness * 0.25 : 0,
    moonBrightness,
    sunlight: stored(values, 'sunlight'),
    // calculateLightSettings: moon diffuse = sunlight colour × moon brightness (transmittance left out)
    moonlight: stored(values, 'sunlight').map((c) => c * moonBrightness),
    ambient: stored(values, 'ambient'),
    blueHorizon: stored(values, 'blueHorizon'),
    blueDensity: stored(values, 'blueDensity'),
    hazeHorizon: stored(values, 'hazeHorizon'),
    hazeDensity: stored(values, 'hazeDensity'),
    densityMultiplier: stored(values, 'densityMultiplier'),
    distanceMultiplier: stored(values, 'distanceMultiplier'),
    maxY: stored(values, 'maxAltitude'),
    gamma: stored(values, 'gamma'),
    glow: [glow, 0.001, stored(values, 'glowFocus')],
    cloudShadow: stored(values, 'cloudCoverage'),
    cloudColor: stored(values, 'cloudColor'),
    cloudScale: stored(values, 'cloudScale'),
    cloudPosDensity1: [values.cloudDensityX, values.cloudDensityY, values.cloudDensityD],
    cloudPosDensity2: [values.cloudDetailX, values.cloudDetailY, values.cloudDetailD],
    cloudScroll: [values.cloudScrollX, values.cloudScrollY],
    starBrightness: values.starBrightness / 250, // 0–2, as the legacy shaders used it
    probeAmbiance: values.probeAmbiance,
  };
}

// ---------- GLSL ----------

export const ATMOS_UNIFORMS = /* glsl */ `
uniform vec3 lightnorm;
uniform vec3 sun_dir;
uniform vec3 moon_dir;
uniform int sun_up_factor;
uniform vec3 sunlight_color;
uniform vec3 moonlight_color;
uniform vec3 ambient_color;
uniform vec3 blue_horizon;
uniform vec3 blue_density;
uniform float haze_horizon;
uniform float haze_density;
uniform float cloud_shadow;
uniform float density_multiplier;
uniform float distance_multiplier;
uniform float max_y;
uniform vec3 glow;
uniform float sun_moon_glow_factor;
uniform vec3 cloud_color;
uniform vec3 cloud_pos_density1;
uniform vec3 cloud_pos_density2;
uniform float cloud_scale;
uniform vec2 cloud_offset;
uniform float star_brightness;
uniform float moon_brightness;
uniform sampler2D cloud_noise;
`;

export const ATMOS_FUNCS = /* glsl */ `
vec3 srgb_to_linear(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

// skyF.glsl: colour of the sky dome in direction dir (unit, y up).
vec3 skyColor(vec3 dir) {
  vec3 rel_pos = dir * 15000.0 + vec3(0.0, 50.0, 0.0);
  if (rel_pos.y > 0.0) rel_pos *= (max_y / rel_pos.y);
  if (rel_pos.y < 0.0) rel_pos *= (-32000.0 / rel_pos.y);

  vec3 rel_pos_norm = normalize(rel_pos);
  float rel_pos_len = length(rel_pos);
  float rel_pos_lightnorm_dot = dot(rel_pos_norm, lightnorm);

  vec3 sunlight = (sun_up_factor == 1) ? sunlight_color : moonlight_color * 0.7;
  vec3 light_atten = (blue_density + vec3(haze_density * 0.25)) * (density_multiplier * max_y);
  vec3 combined_haze = max(abs(blue_density) + vec3(abs(haze_density)), vec3(1e-6));
  vec3 blue_weight = blue_density / combined_haze;
  vec3 haze_weight = haze_density / combined_haze;

  float off_axis = 1.0 / max(1e-6, max(0.0, rel_pos_norm.y) + lightnorm.y);
  sunlight *= exp(-light_atten * off_axis);

  float density_dist = rel_pos_len * density_multiplier;
  combined_haze = exp(-combined_haze * density_dist);

  float haze_glow = 1.0 - rel_pos_lightnorm_dot;
  haze_glow = max(haze_glow, 0.001);
  haze_glow *= glow.x;
  haze_glow = pow(haze_glow, glow.z);
  haze_glow = (sun_moon_glow_factor < 1.0) ? 0.0 : (sun_moon_glow_factor * (haze_glow + 0.25));

  vec3 color = blue_horizon * blue_weight * (sunlight + ambient_color)
             + (haze_horizon * haze_weight) * (sunlight * haze_glow + ambient_color);
  color *= (1.0 - combined_haze);

  vec3 ambient = ambient_color + max(vec3(0.0), (1.0 - ambient_color)) * cloud_shadow * 0.5;
  sunlight *= max(0.0, 1.0 - cloud_shadow);
  vec3 add_below_cloud = blue_horizon * blue_weight * (sunlight + ambient)
                       + (haze_horizon * haze_weight) * (sunlight * haze_glow + ambient);
  combined_haze = sqrt(combined_haze);
  color += (add_below_cloud - color) * (1.0 - sqrt(combined_haze));

  color *= 2.0;
  return clamp(color, vec3(0.0), vec3(5.0));
}

// Cloud noise, computed here instead of read from the viewer's tiling noise texture:
// fBm gradient noise that never repeats. Octaves smaller than a pixel fade out, as a
// mipmapped texture would. Contrast is low (about 0.35–0.65) because cloudsF.glsl
// multiplies (noise − 0.5) by 10.
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0)), f - vec2(1.0)), u.x), u.y);
}
float cloudNoise(vec2 uv) {
  vec2 p = uv * 4.0;
  float footprint = length(fwidth(p));
  float v = 0.0, amp = 0.5, freq = 1.0;
  for (int o = 0; o < 6; o++) {
    v += amp * gnoise(p * freq + float(o) * 17.13) * (1.0 - smoothstep(0.3, 0.7, footprint * freq));
    freq *= 2.03;
    amp *= 0.5;
  }
  return 0.5 + v * 0.45;
}

// cloudsF.glsl: cloud colour and opacity in direction dir. The viewer maps the
// noise onto its dome mesh; here it is projected onto a flat layer overhead.
vec4 cloudLayer(vec3 dir) {
  if (cloud_scale < 0.001 || dir.y <= 0.0) return vec4(0.0);
  vec2 tc = dir.xz / (dir.y + 0.12) * 0.12 + 0.5;
  vec2 uv1 = (vec2(-tc.x, tc.y) - 0.5) / cloud_scale + 0.5 + cloud_offset;
  vec2 uv2 = uv1 + vec2(lightnorm.x, lightnorm.z) * 0.0125;
  // The detail layer repeats 16×; turning it keeps its tiles from lining up into a grid.
  const mat2 DETAIL_TURN = mat2(0.799, 0.602, -0.602, 0.799);
  vec2 uv3 = DETAIL_TURN * uv1 * 16.0;
  vec2 uv4 = DETAIL_TURN * uv2 * 16.0;
  float altitude_blend_factor = clamp((dir.y * 15000.0 + 512.0) / max_y, 0.0, 1.0);

  vec3 rel_pos = dir * 15000.0 + vec3(0.0, 50.0, 0.0);
  rel_pos *= (max_y / max(rel_pos.y, 1e-3));
  vec3 rel_pos_norm = normalize(rel_pos);
  float rel_pos_len = length(rel_pos);

  vec3 sunlight = sunlight_color;
  vec3 light_atten = (blue_density + vec3(haze_density * 0.25)) * (density_multiplier * max_y);
  vec3 combined_haze = max(abs(blue_density) + vec3(abs(haze_density)), vec3(1e-6));
  vec3 blue_weight = blue_density / combined_haze;
  vec3 haze_weight = haze_density / combined_haze;
  float off_axis = 1.0 / max(1e-6, max(0.0, rel_pos_norm.y) + lightnorm.y);
  sunlight *= exp(-light_atten * off_axis);
  combined_haze = exp(-combined_haze * rel_pos_len * density_multiplier);

  float haze_glow = 1.0 - dot(rel_pos_norm, lightnorm);
  haze_glow = max(haze_glow, 0.001);
  haze_glow *= glow.x;
  haze_glow = pow(haze_glow, glow.z);
  haze_glow *= sun_moon_glow_factor;
  haze_glow = (sun_moon_glow_factor < 1.0) ? 0.0 : (haze_glow + 0.25);

  vec3 tmpAmbient = ambient_color + (1.0 - ambient_color) * cloud_shadow * 0.5;
  sunlight *= (1.0 - cloud_shadow);
  vec3 below = blue_horizon * blue_weight * (sunlight + tmpAmbient)
             + (haze_horizon * haze_weight) * (sunlight * haze_glow + tmpAmbient);

  sunlight = sunlight_color;
  off_axis = 1.0 / max(1e-6, lightnorm.y * 2.0);
  sunlight *= exp(-light_atten * off_axis);
  vec3 cloudColorSun = (sunlight * haze_glow) * cloud_color;
  vec3 cloudColorAmbient = tmpAmbient * cloud_color;
  combined_haze = sqrt(combined_haze);
  cloudColorSun *= combined_haze;
  cloudColorAmbient *= combined_haze;
  cloudColorAmbient += below * (1.0 - combined_haze);

  float cloudDensity = 2.0 * (cloud_shadow - 0.25);
  uv1 += cloud_pos_density1.xy;
  uv2 += cloud_pos_density1.xy;
  uv3 += cloud_pos_density2.xy;
  uv4 += cloud_pos_density2.xy;

  // Fine detail fades out toward the horizon, where it would alias into dots.
  float detail = cloud_pos_density2.z * smoothstep(0.04, 0.3, dir.y);
  float alpha1 = (cloudNoise(uv1) - 0.5) + (cloudNoise(uv3) - 0.5) * detail;
  alpha1 = min(max(alpha1 + cloudDensity, 0.0) * 10.0 * cloud_pos_density1.z, 1.0);
  alpha1 = 1.0 - alpha1 * alpha1;
  alpha1 = 1.0 - alpha1 * alpha1;
  alpha1 = clamp(alpha1 * altitude_blend_factor, 0.0, 1.0);

  float alpha2 = cloudNoise(uv2) - 0.5;
  alpha2 = min(max(alpha2 + cloudDensity, 0.0) * 2.5 * cloud_pos_density1.z, 1.0);
  alpha2 = 1.0 - alpha2;
  alpha2 = 1.0 - alpha2 * alpha2;

  vec3 color = cloudColorSun * (1.0 - alpha2) + cloudColorAmbient;
  color = clamp(color, vec3(0.0), vec3(1.0)) * 2.0;
  // Fade out toward the horizon, where the flat projection stretches.
  return vec4(color, alpha1 * smoothstep(0.0, 0.15, dir.y));
}

// Sun and moon discs and stars (the viewer draws these as textured sprites).
vec3 heavenlyBodies(vec3 dir, vec3 sky) {
  vec3 c = vec3(0.0);
  float sd = dot(dir, sun_dir);
  if (sun_dir.y > -0.05) c += sunlight_color * 4.0 * smoothstep(0.99994, 0.99997, sd);
  float md = dot(dir, moon_dir);
  if (moon_dir.y > -0.05) c += vec3(0.85, 0.85, 0.95) * moon_brightness * 2.0 * smoothstep(0.99990, 0.99994, md);
  if (star_brightness > 0.0 && dir.y > 0.0) {
    vec3 cell = floor(dir * 420.0);
    float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float star = step(0.9975, h) * (h - 0.9975) * 400.0;
    float dark = clamp(1.0 - dot(sky, vec3(0.3333)) * 2.5, 0.0, 1.0);
    c += vec3(star) * star_brightness * dark * smoothstep(0.0, 0.15, dir.y);
  }
  return c;
}

// atmosphericsFuncs.glsl: lighting for a surface at eye-relative position pos.
void calcAtmosphericVars(vec3 pos, vec3 light_dir, out vec3 sunlit, out vec3 amblit, out vec3 additive, out vec3 atten) {
  vec3 rel_pos = pos;
  if (abs(rel_pos.y) > max_y) rel_pos *= (max_y / rel_pos.y);
  vec3 rel_pos_norm = normalize(rel_pos);
  float rel_pos_len = length(rel_pos);
  vec3 sunlight = (sun_up_factor == 1) ? sunlight_color : moonlight_color;

  vec3 light_atten = (blue_density + vec3(haze_density * 0.25)) * (density_multiplier * max_y);
  vec3 combined_haze = max(blue_density + vec3(haze_density), vec3(1e-6));
  vec3 blue_weight = blue_density / combined_haze;
  vec3 haze_weight = vec3(haze_density) / combined_haze;
  float above_horizon_factor = 1.0 / max(1e-6, lightnorm.y);
  sunlight *= exp(-light_atten * above_horizon_factor);

  float density_dist = rel_pos_len * density_multiplier;
  combined_haze = exp(-combined_haze * density_dist * distance_multiplier);
  atten = combined_haze;

  float haze_glow = dot(rel_pos_norm, lightnorm);
  haze_glow *= max(0.0, dot(light_dir, rel_pos_norm));
  haze_glow = 1.0 - haze_glow;
  haze_glow = max(haze_glow, 0.001);
  haze_glow *= glow.x;
  haze_glow = clamp(pow(haze_glow, glow.z), -100000.0, 100000.0);
  haze_glow += 0.25;
  haze_glow *= sun_moon_glow_factor;

  vec3 tmpAmbient = ambient_color + (vec3(1.0) - ambient_color) * cloud_shadow * 0.5;
  vec3 cs = sunlight * (1.0 - cloud_shadow);
  additive = (blue_horizon * blue_weight) * (cs + tmpAmbient) + (haze_horizon * haze_weight) * (cs * haze_glow + tmpAmbient);
  sunlit = sunlight;
  amblit = pow(tmpAmbient, vec3(0.9)) * 0.57;
  additive *= vec3(1.0 - combined_haze);
  additive = min(additive, vec3(10.0));
}
`;

// ---------- CPU copy of skyColor, for sampling ambient light and fog colour ----------

const add = (a, b) => a.map((x, i) => x + b[i]);
const mul = (a, b) => a.map((x, i) => x * (Array.isArray(b) ? b[i] : b));

export function skyColorCpu(u, dir) {
  let rel = [dir[0] * 15000, dir[1] * 15000 + 50, dir[2] * 15000];
  if (rel[1] > 0) rel = mul(rel, u.maxY / rel[1]);
  else if (rel[1] < 0) rel = mul(rel, -32000 / rel[1]);
  const len = Math.hypot(...rel);
  const n = rel.map((x) => x / len);
  const ln = u.lightnorm;
  const dotL = n[0] * ln[0] + n[1] * ln[1] + n[2] * ln[2];

  let sunlight = u.sunUp ? u.sunlight : mul(u.moonlight, 0.7);
  const lightAtten = mul(u.blueDensity.map((b) => b + u.hazeDensity * 0.25), u.densityMultiplier * u.maxY);
  let combined = u.blueDensity.map((b) => Math.max(Math.abs(b) + Math.abs(u.hazeDensity), 1e-6));
  const blueW = u.blueDensity.map((b, i) => b / combined[i]);
  const hazeW = combined.map((c) => u.hazeDensity / c);
  const offAxis = 1 / Math.max(1e-6, Math.max(0, n[1]) + ln[1]);
  sunlight = sunlight.map((s, i) => s * Math.exp(-lightAtten[i] * offAxis));
  combined = combined.map((c) => Math.exp(-c * len * u.densityMultiplier));

  let glow = Math.max(1 - dotL, 0.001) * u.glow[0];
  glow = Math.pow(glow, u.glow[2]);
  glow = u.sunMoonGlowFactor < 1 ? 0 : u.sunMoonGlowFactor * (glow + 0.25);

  const term = (sun, amb) => add(
    mul(mul(u.blueHorizon, blueW), add(sun, amb)),
    mul(mul(hazeW, u.hazeHorizon), add(mul(sun, glow), amb)),
  );
  let color = mul(term(sunlight, u.ambient), combined.map((c) => 1 - c));
  const amb = u.ambient.map((a) => a + Math.max(0, 1 - a) * u.cloudShadow * 0.5);
  const below = term(mul(sunlight, Math.max(0, 1 - u.cloudShadow)), amb);
  color = color.map((c, i) => c + (below[i] - c) * (1 - Math.sqrt(Math.sqrt(combined[i]))));
  return color.map((c) => Math.min(5, Math.max(0, c * 2)));
}

// CPU copy of cloudLayer's colour (not its shape), with the self-shadow term at its
// average. Used to fit Cloud colour to an image.
export function cloudColorCpu(u, dir) {
  let rel = [dir[0] * 15000, dir[1] * 15000 + 50, dir[2] * 15000];
  rel = mul(rel, u.maxY / Math.max(rel[1], 1e-3));
  const len = Math.hypot(...rel);
  const n = rel.map((x) => x / len);
  const ln = u.lightnorm;
  const lightAtten = mul(u.blueDensity.map((b) => b + u.hazeDensity * 0.25), u.densityMultiplier * u.maxY);
  let combined = u.blueDensity.map((b) => Math.max(Math.abs(b) + Math.abs(u.hazeDensity), 1e-6));
  const blueW = u.blueDensity.map((b, i) => b / combined[i]);
  const hazeW = combined.map((c) => u.hazeDensity / c);
  let offAxis = 1 / Math.max(1e-6, Math.max(0, n[1]) + ln[1]);
  let sunlight = u.sunlight.map((c, i) => c * Math.exp(-lightAtten[i] * offAxis));
  combined = combined.map((c) => Math.exp(-c * len * u.densityMultiplier));

  let glow = Math.max(1 - (n[0] * ln[0] + n[1] * ln[1] + n[2] * ln[2]), 0.001) * u.glow[0];
  glow = Math.pow(glow, u.glow[2]) * u.sunMoonGlowFactor;
  glow = u.sunMoonGlowFactor < 1 ? 0 : glow + 0.25;

  const amb = u.ambient.map((a) => a + (1 - a) * u.cloudShadow * 0.5);
  const cs = mul(sunlight, 1 - u.cloudShadow);
  const below = add(mul(mul(u.blueHorizon, blueW), add(cs, amb)), mul(mul(hazeW, u.hazeHorizon), add(mul(cs, glow), amb)));

  offAxis = 1 / Math.max(1e-6, ln[1] * 2);
  sunlight = u.sunlight.map((c, i) => c * Math.exp(-lightAtten[i] * offAxis));
  const haze = combined.map(Math.sqrt);
  const sun = mul(mul(mul(sunlight, glow), u.cloudColor), haze);
  const ambient = add(mul(mul(amb, u.cloudColor), haze), mul(below, haze.map((h) => 1 - h)));
  const color = add(mul(sun, 0.5), ambient); // alpha2 at its typical 0.5
  return color.map((c) => Math.min(1, Math.max(0, c)) * 2);
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? Math.max(0, c) / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Cosine-weighted average of the upper sky, in linear RGB: what reflection probes
// would pick up as sky irradiance. Clouds blend in by coverage.
export function skyIrradiance(u) {
  let sum = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 6; j++) {
      const az = (i / 12) * Math.PI * 2;
      const el = ((j + 0.5) / 6) * (Math.PI / 2);
      const d = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
      const w = Math.sin(el) * Math.cos(el);
      sum = add(sum, mul(skyColorCpu(u, d).map(srgbToLinear), w));
      wsum += w;
    }
  }
  const sky = mul(sum, 1 / wsum);
  const amb = u.ambient.map((a) => a + (1 - a) * u.cloudShadow * 0.5);
  const cloud = mul(u.cloudColor, amb).map((c) => srgbToLinear(c * 2));
  const k = Math.min(1, u.cloudShadow * 0.8);
  return sky.map((s, i) => s * (1 - k) + cloud[i] * k);
}

// Average horizon colour toward the camera's view, used to fog distant water.
export function horizonColor(u) {
  let sum = [0, 0, 0];
  for (let i = 0; i < 16; i++) {
    const az = (i / 16) * Math.PI * 2;
    sum = add(sum, skyColorCpu(u, [Math.cos(az), 0.01, Math.sin(az)]).map(srgbToLinear));
  }
  return mul(sum, 1 / 16);
}

// Tileable fBm gradient noise, standing in for the viewer's soft cloud noise texture.
// Gradient noise avoids the square, grid-aligned blobs that value noise gives. The clouds
// now compute their noise in the shader; the water still reads this texture for waves.
export function makeCloudNoise(size = 512) {
  const rand = mulberry32(7);
  const octaves = [4, 8, 16, 32];
  const grids = octaves.map((n) => Float32Array.from({ length: n * n }, () => rand() * Math.PI * 2));
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, total = 0;
      octaves.forEach((n, o) => {
        v += amp * gradientNoise(grids[o], n, (x / size) * n, (y / size) * n);
        total += amp;
        amp *= 0.5;
      });
      v = v / total; // about −0.5…0.5
      // cloudsF.glsl multiplies (noise − 0.5) by 10, so it expects a soft, low-contrast
      // texture (about 0.3–0.7). Full-range noise would give hard cut-out edges.
      const b = Math.round(Math.min(1, Math.max(0, v * 0.4 + 0.5)) * 255);
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = b;
      data[k + 3] = 255;
    }
  }
  return { data, size };
}

function gradientNoise(angles, n, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const dot = (i, j) => {
    const a = angles[((j % n + n) % n) * n + ((i % n + n) % n)];
    return Math.cos(a) * (x - i) + Math.sin(a) * (y - j);
  };
  const u = fade(fx), v = fade(fy);
  const a = dot(x0, y0) + (dot(x0 + 1, y0) - dot(x0, y0)) * u;
  const b = dot(x0, y0 + 1) + (dot(x0 + 1, y0 + 1) - dot(x0, y0 + 1)) * u;
  return a + (b - a) * v;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
