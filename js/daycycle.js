// Day cycle: sky keyframes on a 0–1 timeline (0 = midnight, 0.5 = noon),
// blending between them, and "generate from one sky".

import { SKY_PARAMS } from './params.js';

const ANGLES = new Set(['sunAngle', 'eastAngle']);
const lerp = (a, b, t) => a + (b - a) * t;

// Shortest way round the circle, so 350° → 10° passes through 0°.
function lerpAngle(a, b, t) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

export function blendSky(a, b, t) {
  const out = {};
  for (const p of SKY_PARAMS) {
    const x = a[p.id], y = b[p.id];
    if (p.type === 'color') out[p.id] = x.map((v, i) => lerp(v, y[i], t));
    else if (ANGLES.has(p.id)) out[p.id] = lerpAngle(x, y, t);
    else out[p.id] = lerp(x, y, t);
  }
  return out;
}

// Sky values at time t, given keys [{ time, sky }] and a lookup skyId → values.
export function skyAt(keys, skies, t) {
  const ks = keys.filter((k) => skies[k.sky]).sort((a, b) => a.time - b.time);
  if (!ks.length) return null;
  if (ks.length === 1) return skies[ks[0].sky];
  let i = ks.findIndex((k) => k.time > t);
  if (i === -1) i = 0;
  const next = ks[i];
  const prev = ks[(i - 1 + ks.length) % ks.length];
  const span = ((next.time - prev.time + 1) % 1) || 1;
  const into = ((t - prev.time + 1) % 1) / span;
  return blendSky(skies[prev.sky], skies[next.sky], into);
}

const tint = (c, m) => c.map((v, i) => Math.min(1, Math.max(0, v * m[i])));
const scale = (c, k) => c.map((v) => Math.min(1, Math.max(0, v * k)));

// Four variants of one sky. Sun positions follow the legacy arc
// (0° rises, 90° overhead, 180° sets, 270° midnight).
export function generateVariants(base) {
  const v = (patch) => ({ ...structuredClone(base), ...patch });
  return [
    {
      name: 'Night', time: 0,
      values: v({
        sunAngle: 270,
        sunlight: tint(base.sunlight, [0.45, 0.55, 0.9]),
        ambient: tint(scale(base.ambient, 0.35), [0.8, 0.9, 1.3]),
        blueDensity: scale(base.blueDensity, 0.25),
        blueHorizon: scale(base.blueHorizon, 0.3),
        hazeHorizon: base.hazeHorizon * 0.6,
        starBrightness: Math.max(base.starBrightness, 250),
        cloudColor: scale(base.cloudColor, 0.5),
      }),
    },
    {
      name: 'Sunrise', time: 0.25,
      values: v({
        sunAngle: 6,
        sunlight: tint(base.sunlight, [1.35, 1.0, 0.7]),
        ambient: tint(scale(base.ambient, 0.8), [1.1, 1.0, 0.95]),
        blueHorizon: tint(base.blueHorizon, [1.6, 1.15, 0.8]),
        hazeHorizon: Math.min(5, base.hazeHorizon * 1.6),
        hazeDensity: Math.min(5, base.hazeDensity * 1.2),
        cloudColor: tint(base.cloudColor, [1.2, 1.0, 0.85]),
        starBrightness: 0,
      }),
    },
    { name: 'Noon', time: 0.5, values: v({ sunAngle: 75, starBrightness: 0 }) },
    {
      name: 'Sunset', time: 0.75,
      values: v({
        sunAngle: 174,
        sunlight: tint(base.sunlight, [1.5, 0.9, 0.55]),
        ambient: tint(scale(base.ambient, 0.75), [1.15, 0.95, 0.9]),
        blueHorizon: tint(base.blueHorizon, [1.9, 1.1, 0.7]),
        hazeHorizon: Math.min(5, base.hazeHorizon * 1.9),
        hazeDensity: Math.min(5, base.hazeDensity * 1.3),
        cloudColor: tint(base.cloudColor, [1.3, 0.95, 0.8]),
        starBrightness: 0,
      }),
    },
  ];
}

export function formatTime(t) {
  const mins = Math.round(t * 24 * 60) % (24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return (+m[1] * 60 + +m[2]) / (24 * 60);
}
