// Fit Blue horizon and Blue density so the WindLight sky model reproduces the zenith
// and horizon colours measured from an image. Copying the image colours straight in
// doesn't work: WindLight multiplies them by the sunlight and ambient colours, so a
// warm sun would tint the whole sky twice.

import { skyUniforms, skyColorCpu, cloudColorCpu, srgbToLinear } from './atmosphere.js';

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function render(values) {
  const u = skyUniforms(values);
  const lin = (d) => skyColorCpu(u, d).map(srgbToLinear);
  const zenith = lin([0, 1, 0]);
  // Horizon band away from the sun, to match how the analyser leaves out the sun.
  const sunAz = Math.atan2(u.sunDir[2], u.sunDir[0]);
  const horizon = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < 16; i++) {
    const az = (i / 16) * Math.PI * 2;
    if (Math.abs(((az - sunAz + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.35) continue;
    const el = 5 * Math.PI / 180;
    const c = lin([Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]);
    for (let k = 0; k < 3; k++) horizon[k] += c[k];
    n++;
  }
  return { zenith, horizon: horizon.map((c) => c / n) };
}

// Zenith and horizon (away from the sun) as the sky model renders them, in linear RGB.
export const renderSkyColors = render;

// Error between rendered and target colours, in log space so dark and bright channels
// count equally. Brightness is normalised: only colour and the zenith/horizon ratio matter.
// keepAmbient: ambient also lights the scene, so its brightness is held near the
// measured level and only its tint is free.
function error(values, tz, th, keepAmbient) {
  const r = render(values);
  const s = (lum(r.zenith) + lum(r.horizon)) / (lum(tz) + lum(th));
  let e = 0;
  for (let c = 0; c < 3; c++) {
    e += Math.log(Math.max(r.zenith[c], 1e-5) / (tz[c] * s)) ** 2;
    e += Math.log(Math.max(r.horizon[c], 1e-5) / (th[c] * s)) ** 2;
  }
  e += 4 * Math.log(Math.max(lum(values.ambient), 1e-4) / keepAmbient) ** 2;
  return e;
}

// targets: { zenith, horizon } in linear RGB, any brightness. Pattern search over the
// Blue horizon, Blue density and Ambient channels: Blue density changes both colour and
// air density, so no channel has a simple one-step correction. Ambient is included because
// with a warm sun it's the only way WindLight can make a blue zenith (it is the skylight).
export function fitSkyColors(values, targets, iterations = 80) {
  const v = structuredClone(values);
  const tz = targets.zenith.map((c) => Math.max(c, 1e-5));
  const th = targets.horizon.map((c) => Math.max(c, 1e-5));
  const slots = [0, 1, 2].flatMap((c) => [['blueHorizon', c], ['blueDensity', c], ['ambient', c]]);
  const max = { blueHorizon: 1, blueDensity: 1, ambient: 0.5 }; // brighter ambient washes the scene out
  const keepAmbient = Math.max(lum(values.ambient), 1e-4);
  const score = () => error(v, tz, th, keepAmbient);
  let best = score();
  let step = 1.3;
  for (let it = 0; it < iterations && step > 1.005; it++) {
    let improved = false;
    for (const [id, c] of slots) {
      for (const f of [step, 1 / step]) {
        const old = v[id][c];
        v[id][c] = clamp(old * f, 0.005, max[id]);
        const e = score();
        if (e < best - 1e-9) { best = e; improved = true; } else v[id][c] = old;
      }
    }
    if (!improved) step = Math.sqrt(step);
  }
  // Typical colour error (relative), for the note shown to the user.
  const r = render(v);
  const sc = (lum(r.zenith) + lum(r.horizon)) / (lum(tz) + lum(th));
  let e = 0;
  for (let c = 0; c < 3; c++) e += Math.log(r.zenith[c] / (tz[c] * sc)) ** 2 + Math.log(r.horizon[c] / (th[c] * sc)) ** 2;
  if (targets.clouds) fitCloudColor(v, targets, sc);
  return { values: v, error: Math.expm1(Math.sqrt(e / 6)) };
}

// Cloud colour scales the cloud linearly before the sRGB curve, so a few multiplicative
// steps converge. s is the brightness factor from the sky fit, so clouds and sky keep
// the image's brightness relative to each other.
function fitCloudColor(v, targets, s) {
  const target = targets.clouds.map((c) => Math.max(c, 1e-5) * s);
  const dirs = [0, 1, 2, 3].map((i) => {
    const az = (i / 4) * Math.PI * 2;
    const el = 35 * Math.PI / 180;
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  });
  for (let it = 0; it < 12; it++) {
    const u = skyUniforms(v);
    const r = [0, 0, 0];
    for (const d of dirs) cloudColorCpu(u, d).forEach((c, k) => { r[k] += srgbToLinear(c) / dirs.length; });
    for (let c = 0; c < 3; c++) v.cloudColor[c] = clamp(v.cloudColor[c] * Math.pow(target[c] / Math.max(r[c], 1e-5), 0.45), 0.02, 1);
  }
}
