// Guess starting slider values from a sky image (equirectangular HDRI or a plain
// photo). Simple, readable heuristics: the user is expected to tweak the result.
//
// Equirect layout: top row = zenith, bottom row = nadir, centre column looks north,
// and moving right turns clockwise (east at 3/4 width, west at 1/4).
//
// Sun mapping: the viewer builds the sun from azimuth = −east_angle, altitude =
// sun_angle, so with east_angle 0 the sun rises due east and passes overhead to the
// west. A point on that arc at sun_angle a, turned by e, points horizontally along
// compass bearing 90° + e. We always use the morning half of the arc:
// sunAngle = elevation, eastAngle = bearing − 90°.

import { SKY_PARAMS } from './params.js';
import { decodeHdr } from './hdr.js';
import { decodeExr } from './exr.js';

const PARAMS = Object.fromEntries(SKY_PARAMS.map((p) => [p.id, p]));
const MAX_WIDTH = 1024;
const SUN_EXCLUDE = 12; // degrees around the sun left out of sky colours

export function analyzeSky(pixels, { kind = 'auto' } = {}) {
  if (!pixels || !pixels.width || !pixels.height || !pixels.data) throw new Error('No image to analyse');
  if (kind === 'auto') kind = Math.abs(pixels.width / pixels.height / 2 - 1) <= 0.05 ? 'hdri' : 'photo';
  const out = kind === 'hdri' ? analyzeHdri(pixels) : analyzePhoto(pixels);
  return { kind, ...out, values: clampValues(out.values) };
}

// ---------- HDRI ----------

function analyzeHdri(px) {
  const notes = [];
  const sun = findSun(px);
  const away = (x, y) => angleBetween(dirAt(px, x, y), sun.dir) > SUN_EXCLUDE;

  const zenith = bandStats(px, 0, Math.round(px.height * 0.15), away, true);
  const horizon = bandStats(px, rowAt(px, 10), rowAt(px, 0), away, true);
  const sky = bandStats(px, 0, rowAt(px, 0), away, true);

  const sunAngle = round1(sun.elevation);
  const eastAngle = round1(wrap360(sun.bearing - 90));
  if (sun.strength < 0.15) notes.push('No clear sun disc found; the sun was put at the brightest spot. Check it by hand.');
  else notes.push(`Sun found ${sunAngle}° above the horizon, ${Math.round(sun.bearing)}° clockwise from the image centre.`);
  if (sun.elevation < 2) notes.push('The sun is at or below the horizon, so lighting may look dark.');
  if (!px.hdr) notes.push('Not an HDR image, so the sun is probably clipped; its colour is a rough guess.');

  const values = commonSky(zenith, horizon, sky, notes);
  values.sunlight = scaleTo(sun.color, 0.25 + 0.35 * sun.strength);
  values.sunAngle = sunAngle;
  values.eastAngle = eastAngle;
  return { values, sun: { sunAngle, eastAngle }, notes, targets: { zenith: zenith.mean, horizon: horizon.mean, clouds: sky.cloudColor } };
}

// Brightest spot above the horizon, after averaging into ~2° cells.
function findSun(px) {
  const { width, height, data } = px;
  const cell = Math.max(1, Math.round(width / 180));
  const top = rowAt(px, 0);
  let best = -1;
  let bx = 0;
  let by = 0;
  for (let cy = 0; cy + cell <= top; cy += cell) {
    for (let cx = 0; cx + cell <= width; cx += cell) {
      let sum = 0;
      for (let y = cy; y < cy + cell; y++) for (let x = cx; x < cx + cell; x++) sum += lum(data, (y * width + x) * 3);
      if (sum > best) { best = sum; bx = cx; by = cy; }
    }
  }
  // Centroid of the bright pixels near that cell, weighted by luminance.
  const r = cell * 3;
  let peak = 0;
  for (let y = Math.max(0, by - r); y < Math.min(height, by + cell + r); y++) {
    for (let x = bx - r; x < bx + cell + r; x++) peak = Math.max(peak, lum(data, idx(px, x, y)));
  }
  let w = 0;
  let sx = 0;
  let sy = 0;
  const color = [0, 0, 0];
  for (let y = Math.max(0, by - r); y < Math.min(height, by + cell + r); y++) {
    for (let x = bx - r; x < bx + cell + r; x++) {
      const i = idx(px, x, y);
      const l = lum(data, i);
      if (l < peak * 0.5) continue;
      w += l; sx += x * l; sy += y * l;
      for (let c = 0; c < 3; c++) color[c] += data[i + c];
    }
  }
  const x = sx / w;
  const y = sy / w;
  const dir = dirAt(px, x, y);
  const elevation = 90 - ((y + 0.5) / height) * 180;
  const bearing = wrap360(((x + 0.5) / width - 0.5) * 360);

  // How much the sun stands out from the median sky: 0 = no disc, 1 = strong sun.
  const median = medianLum(px, top);
  const ratio = peak / Math.max(median, 1e-6);
  const strength = clamp(Math.log10(ratio) / (px.hdr ? 3 : 0.6), 0, 1);
  return { dir, elevation, bearing, color, strength };
}

// ---------- Photo ----------

function analyzePhoto(px) {
  const skyRows = Math.max(1, Math.round(px.height * 0.4));
  const all = () => true;
  const zenith = bandStats(px, 0, Math.max(1, Math.round(skyRows * 0.25)), all, false);
  const horizon = bandStats(px, Math.round(skyRows * 0.75), skyRows, all, false);
  const sky = bandStats(px, 0, skyRows, all, false);
  const notes = ['Treated the top 40% of the photo as sky.', 'Photos don’t show where the sun is: set Sun position and East angle by hand.'];

  const values = commonSky(zenith, horizon, sky, notes);
  // Brightest sky pixels, pulled halfway to neutral.
  const bright = scaleTo(sky.brightColor, 1);
  values.sunlight = scaleTo(bright.map((c) => 0.5 + 0.5 * c), 0.45);
  return { values, sun: null, notes, targets: { zenith: zenith.mean, horizon: horizon.mean, clouds: sky.cloudColor } };
}

// ---------- Shared ----------

function commonSky(zenith, horizon, sky, notes) {
  // One scale for both colours keeps their relative brightness; then lift the dimmer.
  const k = 0.5 / Math.max(maxOf(zenith.mean), maxOf(horizon.mean), 1e-6);
  const blueDensity = liftTo(zenith.mean.map((c) => c * k), 0.3);
  const blueHorizon = liftTo(horizon.mean.map((c) => c * k), 0.3);

  // Haze: a pale horizon and a flat, low-contrast sky.
  const pale = 1 - clamp(saturation(horizon.mean) / 0.5, 0, 1);
  const flat = 1 - clamp(sky.cv / 0.5, 0, 1);
  const haze = 0.7 * pale + 0.3 * flat;

  // Clouds: share of sky pixels that are bright and nearly grey, or (for tinted clouds
  // at sunrise and sunset) how patchy the sky is side to side.
  const cloudy = Math.max(sky.cloudy, clamp((sky.texture - 0.03) * 4, 0, 1));
  const cloudCoverage = round2(clamp(cloudy * 0.95 + 0.03, 0, 1));
  const ambient = scaleTo(sky.mean.map((c, i, a) => 0.5 * c + 0.5 * avg(a)), 0.18 + 0.12 * haze);

  if (haze > 0.6) notes.push('The sky looks hazy or washed out, so haze is set high.');
  if (cloudCoverage > 0.6) notes.push('Lots of bright grey sky, so cloud coverage is high.');
  notes.push('These are starting values: adjust to taste.');
  return {
    blueDensity, blueHorizon, ambient,
    hazeHorizon: round2(0.1 + 0.5 * haze),
    hazeDensity: round2(0.3 + 2.2 * haze),
    cloudCoverage,
  };
}

// Mean colour, luminance spread, cloudy share and brightest colour of rows [y0, y1).
// Equirect rows are weighted by cos(latitude) so the stretched zenith doesn't dominate.
function bandStats(px, y0, y1, keep, sphere) {
  const { width, height, data } = px;
  y1 = Math.max(y1, y0 + 1);
  const mean = [0, 0, 0];
  const samples = [];
  let w = 0;
  for (let y = y0; y < Math.min(y1, height); y++) {
    const wy = sphere ? Math.max(0.02, Math.cos((0.5 - (y + 0.5) / height) * Math.PI)) : 1;
    for (let x = 0; x < width; x++) {
      if (!keep(x, y)) continue;
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) mean[c] += data[i + c] * wy;
      w += wy;
      samples.push([lum(data, i), saturation([data[i], data[i + 1], data[i + 2]]), wy, i]);
    }
  }
  if (!w) return { mean: [0, 0, 0], cv: 0, cloudy: 0, brightColor: [1, 1, 1], texture: 0, cloudColor: [1, 1, 1] };
  for (let c = 0; c < 3; c++) mean[c] /= w;

  let m = 0;
  for (const [l, , wy] of samples) m += l * wy;
  m /= w;
  let v = 0;
  for (const [l, , wy] of samples) v += (l - m) ** 2 * wy;
  const cv = Math.sqrt(v / w) / Math.max(m, 1e-6);

  const sorted = samples.map((s) => s[0]).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p98 = sorted[Math.floor(sorted.length * 0.98)];
  let cw = 0;
  const brightColor = [0, 0, 0];
  for (const [l, s, wy, i] of samples) {
    if (s < 0.2 && l >= p90 * 0.6) cw += wy;
    if (l >= p98) for (let c = 0; c < 3; c++) brightColor[c] += data[i + c];
  }
  // Texture: mean luminance change to a neighbour ~3° to the side, relative to the mean.
  // A row is a band of equal elevation, so the sky's vertical gradient doesn't count.
  const d = Math.max(1, Math.round(width / 120));
  let tex = 0;
  let tw = 0;
  for (const [l, , wy, i] of samples) {
    const x = (i / 3) % width;
    const j = i - x * 3 + ((x + d) % width) * 3;
    tex += Math.abs(l - lum(data, j)) * wy;
    tw += wy;
  }
  const texture = tw ? tex / tw / Math.max(m, 1e-6) : 0;
  // Cloud colour: the bright patches (88th–98th percentile), which in a cloudy sky are clouds.
  const p88 = sorted[Math.floor(sorted.length * 0.88)];
  const cloudColor = [0, 0, 0];
  let ccw = 0;
  for (const [l, , wy, i] of samples) {
    if (l < p88 || l > p98) continue;
    for (let c = 0; c < 3; c++) cloudColor[c] += data[i + c] * wy;
    ccw += wy;
  }
  if (ccw) for (let c = 0; c < 3; c++) cloudColor[c] /= ccw;
  return { mean, cv, cloudy: cw / w, brightColor, texture, cloudColor };
}

function medianLum(px, rows) {
  const ls = [];
  const step = Math.max(1, Math.floor((px.width * rows) / 20000));
  for (let i = 0; i < px.width * rows; i += step) ls.push(lum(px.data, i * 3));
  ls.sort((a, b) => a - b);
  return ls[Math.floor(ls.length / 2)] ?? 0;
}

// Unit vector (east, north, up) for an equirect pixel.
function dirAt(px, x, y) {
  const el = (90 - ((y + 0.5) / px.height) * 180) * DEG;
  const b = ((x + 0.5) / px.width - 0.5) * 2 * Math.PI;
  return [Math.cos(el) * Math.sin(b), Math.cos(el) * Math.cos(b), Math.sin(el)];
}

const DEG = Math.PI / 180;
const angleBetween = (a, b) => Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) / DEG;
const rowAt = (px, elevation) => Math.round(((90 - elevation) / 180) * px.height);
const idx = (px, x, y) => (y * px.width + (((x % px.width) + px.width) % px.width)) * 3;
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
const maxOf = (c) => Math.max(c[0], c[1], c[2]);
const avg = (c) => (c[0] + c[1] + c[2]) / 3;
const saturation = (c) => (maxOf(c) > 0 ? (maxOf(c) - Math.min(c[0], c[1], c[2])) / maxOf(c) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
const wrap360 = (d) => ((d % 360) + 360) % 360;

// Scale a colour so its brightest channel is `target`.
function scaleTo(c, target) {
  const m = maxOf(c);
  return m > 0 ? c.map((v) => round3(v * target / m)) : [target, target, target];
}

function liftTo(c, min) {
  return maxOf(c) < min ? scaleTo(c, min) : c.map(round3);
}

function clampValues(values) {
  const out = {};
  for (const [id, v] of Object.entries(values)) {
    const p = PARAMS[id];
    if (Array.isArray(v)) out[id] = v.map((c) => clamp(c, 0, 1));
    else out[id] = clamp(v, p.min ?? -Infinity, p.max ?? Infinity);
  }
  return out;
}

// ---------- Loading (browser only) ----------

export async function pixelsFromFile(file) {
  if (/\.hdr$/i.test(file.name)) {
    const img = decodeHdr(await file.arrayBuffer());
    return { ...downscale(img), hdr: true };
  }
  if (/\.exr$/i.test(file.name)) {
    const img = await decodeExr(await file.arrayBuffer());
    return { ...downscale(img), hdr: true };
  }
  const bitmap = await createImageBitmap(file);
  const width = Math.min(MAX_WIDTH, bitmap.width);
  const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) data[j + c] = srgbToLinear(rgba[i + c] / 255);
  }
  return { width, height, data, hdr: false };
}

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// Box-average an HDR image down to at most MAX_WIDTH wide.
function downscale(img) {
  const f = Math.ceil(img.width / MAX_WIDTH);
  if (f <= 1) return img;
  const width = Math.floor(img.width / f);
  const height = Math.floor(img.height / f);
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * img.width + x * f + dx) * 3;
          for (let c = 0; c < 3; c++) data[o + c] += img.data[i + c] / (f * f);
        }
      }
    }
  }
  return { width, height, data };
}
