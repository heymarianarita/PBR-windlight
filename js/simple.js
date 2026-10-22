// The few controls shown by default, named for what you see. Each one reads and writes
// the real Firestorm settings from params.js (all of which stay under "Advanced"), so
// the two always agree and the export is unchanged.
//
// Same shape as params.js entries, plus get(values) / set(values, v).

import { WATER_PARAMS } from './params.js';
import { fitSkyColors, renderSkyColors } from './fit.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap360 = (d) => ((d % 360) + 360) % 360;
const linear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// ---------- Sky colour, as rendered ----------
// What the sky model draws overhead and at the horizon, in display colours. Both share
// one brightness scale, so a darker zenith stays darker than its horizon. The fit only
// sets colour and that ratio (overall brightness comes from sunlight and ambient), so the
// scale is kept from the last pick: the swatch then shows what was picked, not a jump.
const displayScale = new WeakMap(); // sky values → scale

function renderedShown(values) {
  const r = renderSkyColors(values);
  return { zenith: r.zenith.map((c) => srgb(Math.max(c, 0))), horizon: r.horizon.map((c) => srgb(Math.max(c, 0))) };
}

function shownSkyColors(values) {
  const s = renderedShown(values);
  const k = displayScale.get(values) ?? 1 / Math.max(...s.zenith, ...s.horizon, 1e-4);
  const fit = (c) => clamp(c * k, 0, 1);
  return { zenith: s.zenith.map(fit), horizon: s.horizon.map(fit) };
}

// Pick a colour you want to see; the fit finds the Blue density, Blue horizon and ambient
// tint that render it (the same fit "Generate from an image" uses).
function setSkyColor(values, which, color) {
  const now = shownSkyColors(values);
  now[which] = color;
  const fit = fitSkyColors(values, { zenith: now.zenith.map(linear), horizon: now.horizon.map(linear) }, 40);
  Object.assign(values, { blueDensity: fit.values.blueDensity, blueHorizon: fit.values.blueHorizon, ambient: fit.values.ambient });
  const picked = renderedShown(values)[which];
  displayScale.set(values, Math.max(...color, 1e-4) / Math.max(...picked, 1e-4));
}

// ---------- Sun as elevation and compass bearing ----------
// Legacy WindLight stores a position along the sun's arc (sun_angle) and a turn of that
// arc (east_angle). The viewer's sun vector, y up and north = −z, is
// (cos e · cos a, sin a, sin e · cos a) for east angle e and sun angle a.
function sunVector(v) {
  const e = v.eastAngle * DEG, a = v.sunAngle * DEG;
  return [Math.cos(e) * Math.cos(a), Math.sin(a), Math.sin(e) * Math.cos(a)];
}
const elevationOf = (v) => Math.asin(clamp(sunVector(v)[1], -1, 1)) / DEG;
const bearingOf = (v) => {
  const [x, , z] = sunVector(v);
  return Math.hypot(x, z) < 1e-6 ? wrap360(v.eastAngle + 90) : wrap360(Math.atan2(x, -z) / DEG);
};
// Rising half of the arc: sun angle = elevation, and the arc turns so the sun faces the bearing.
function setSun(v, elevation, bearing) {
  v.sunAngle = wrap360(elevation);
  v.eastAngle = wrap360(bearing - 90);
}

export const SKY_SIMPLE = [
  { id: 'skyColor', label: 'Sky colour', type: 'color',
    hint: 'Overhead. Sets Blue density and Blue horizon.',
    get: (v) => shownSkyColors(v).zenith, set: (v, c) => setSkyColor(v, 'zenith', c) },
  { id: 'horizonColor', label: 'Horizon colour', type: 'color',
    hint: 'WindLight ties this to the sky colour, so it may shift a little. Warm horizons also need warm sunlight.',
    get: (v) => shownSkyColors(v).horizon, set: (v, c) => setSkyColor(v, 'horizon', c) },
  { id: 'sunHeight', label: 'Sun height', type: 'range', min: -20, max: 90, step: 1, unit: '°',
    hint: '0° is on the horizon, 90° straight overhead, below 0° is night.',
    get: (v) => elevationOf(v), set: (v, x) => setSun(v, x, bearingOf(v)) },
  { id: 'sunDirection', label: 'Sun direction', type: 'range', min: 0, max: 359, step: 1, unit: '°',
    hint: 'Compass bearing: 90° east, 180° south, 270° west.',
    get: (v) => bearingOf(v), set: (v, x) => setSun(v, elevationOf(v), x) },
  { id: 'sunlight', label: 'Sunlight', type: 'color',
    hint: 'Colour and strength of the sun (and of the moon at night).',
    get: (v) => v.sunlight, set: (v, c) => { v.sunlight = c; } },
  { id: 'haze', label: 'Haze', type: 'range', min: 0, max: 100, step: 1, unit: '%',
    get: (v) => clamp(((v.hazeDensity - 0.3) / 2.2) * 100, 0, 100),
    set: (v, x) => { v.hazeDensity = 0.3 + 2.2 * (x / 100); v.hazeHorizon = 0.1 + 0.5 * (x / 100); } },
  { id: 'clouds', label: 'Clouds', type: 'range', min: 0, max: 100, step: 1, unit: '%',
    get: (v) => v.cloudCoverage * 100, set: (v, x) => { v.cloudCoverage = x / 100; } },
  { id: 'ambiance', label: 'Ambiance', type: 'range', min: 0, max: 10, step: 0.05,
    hint: 'Reflection Probe Ambiance: how much the sky lights the scene under PBR. 2 suits most open places. It isn’t in the file, so you type it in after import.',
    get: (v) => v.probeAmbiance, set: (v, x) => { v.probeAmbiance = x; } },
];

// Water: clarity is the inverse of fog density, on a log scale (0.5 clear to 64 murky).
const FOG = WATER_PARAMS.find((p) => p.id === 'fogDensity');
const CLEAR = 0.5, MURKY = 64;

export const WATER_SIMPLE = [
  { id: 'waterColor', label: 'Water colour', type: 'color',
    get: (v) => v.fogColor, set: (v, c) => { v.fogColor = c; } },
  { id: 'clarity', label: 'Clarity', type: 'range', min: 0, max: 100, step: 1, unit: '%',
    hint: 'How far you can see into the water. Sets Fog density.',
    get: (v) => clamp((Math.log(v.fogDensity / MURKY) / Math.log(CLEAR / MURKY)) * 100, 0, 100),
    set: (v, x) => { v.fogDensity = clamp(MURKY * Math.pow(CLEAR / MURKY, x / 100), FOG.min, FOG.max); } },
  { id: 'waves', label: 'Waves', type: 'range', min: 0, max: 100, step: 1, unit: '%',
    get: (v) => clamp(((v.normScaleX + v.normScaleY + v.normScaleZ) / 3 / 6) * 100, 0, 100),
    set: (v, x) => { v.normScaleX = v.normScaleY = v.normScaleZ = (x / 100) * 6; } },
  { id: 'reflections', label: 'Reflections', type: 'range', min: 0, max: 100, step: 1, unit: '%',
    hint: 'How much the water mirrors the sky. Sets the Fresnel scale and offset.',
    get: (v) => clamp(((v.fresnelOffset - 0.2) / 0.6) * 100, 0, 100),
    set: (v, x) => { v.fresnelOffset = 0.2 + 0.6 * (x / 100); v.fresnelScale = 0.2 + 0.6 * (x / 100); } },
];
