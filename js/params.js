// Every sky and water parameter, defined once. The sliders, preview, presets and
// XML writer all read from here, so a legacy key can't be misspelled in one place
// and silently dropped on import.
//
// Slider values use the same units the Firestorm editor shows after import, so
// what you see here is what you see there. `toXml` / `fromXml` convert between
// those units and what the legacy file stores (see llpaneleditsky.cpp and
// translateLegacySettings in llsettingssky.cpp).
//
//   type    'range' (one number) or 'color' (three 0–1 numbers)
//   xml     legacy key; `index` is the slot when several sliders share one array
//   scale   stored = shown × scale (default 1); `offset` is added after scaling
//   toXml / fromXml   for conversions that aren't a plain scale

const DEG = Math.PI / 180;

// Shape of each legacy key in the file. Arrays are written at full length; slots
// that no slider fills keep the value from `fill`.
export const SKY_XML = {
  ambient:             { len: 4, fill: [0, 0, 0, 1] },
  blue_density:        { len: 4, fill: [0, 0, 0, 1] },
  blue_horizon:        { len: 4, fill: [0, 0, 0, 1] },
  sunlight_color:      { len: 4, fill: [0, 0, 0, 1] },
  haze_density:        { len: 4, fill: [0, 0, 0, 1] },
  haze_horizon:        { len: 4, fill: [0, 0, 0, 1] },
  density_multiplier:  { len: 4, fill: [0, 0, 0, 1] },
  distance_multiplier: { len: 4, fill: [0, 0, 0, 1] },
  max_y:               { len: 4, fill: [0, 0, 0, 1] },
  gamma:               { len: 4, fill: [0, 0, 0, 1] },
  glow:                { len: 4, fill: [0, 0.001, 0, 1] },
  cloud_color:         { len: 4, fill: [0, 0, 0, 1] },
  cloud_pos_density1:  { len: 4, fill: [0, 0, 0, 1] },
  cloud_pos_density2:  { len: 4, fill: [0, 0, 0, 1] },
  cloud_scale:         { len: 4, fill: [0, 0, 0, 1] },
  cloud_shadow:        { len: 4, fill: [0, 0, 0, 1] },
  cloud_scroll_rate:   { len: 2, fill: [10, 10] },
  star_brightness:     { len: 0 },
  sun_angle:           { len: 0 },
  east_angle:          { len: 0 },
};

export const SKY_GROUPS = ['Atmosphere', 'Lighting', 'Sun & Moon', 'Clouds'];

export const SKY_PARAMS = [
  // ---- Atmosphere ----
  { id: 'blueHorizon', group: 'Atmosphere', label: 'Blue horizon', type: 'color', xml: 'blue_horizon', scale: 2,
    def: [0.2477, 0.2477, 0.32], hint: 'Sky colour near the horizon.' },
  { id: 'blueDensity', group: 'Atmosphere', label: 'Blue density', type: 'color', xml: 'blue_density', scale: 2,
    def: [0.1224, 0.2244, 0.38], hint: 'Sky colour overhead.' },
  { id: 'hazeHorizon', group: 'Atmosphere', label: 'Haze horizon', type: 'range', xml: 'haze_horizon', index: 0,
    min: 0, max: 5, step: 0.01, def: 0.19 },
  { id: 'hazeDensity', group: 'Atmosphere', label: 'Haze density', type: 'range', xml: 'haze_density', index: 0,
    min: 0, max: 5, step: 0.01, def: 0.7 },
  { id: 'densityMultiplier', group: 'Atmosphere', label: 'Density multiplier', type: 'range', xml: 'density_multiplier', index: 0,
    min: 0.0001, max: 2, step: 0.0001, scale: 0.001, def: 0.18, hint: 'Shown ×1000, as in the editor.' },
  { id: 'distanceMultiplier', group: 'Atmosphere', label: 'Distance multiplier', type: 'range', xml: 'distance_multiplier', index: 0,
    min: 0.05, max: 1000, step: 0.01, def: 0.8, log: true },
  { id: 'maxAltitude', group: 'Atmosphere', label: 'Maximum altitude', type: 'range', xml: 'max_y', index: 0,
    min: 0, max: 10000, step: 1, def: 1605, unit: 'm' },

  // ---- Lighting ----
  { id: 'ambient', group: 'Lighting', label: 'Ambient', type: 'color', xml: 'ambient', scale: 3,
    def: [0.25, 0.25, 0.25], hint: 'Stored ×3 (0–3 scale), as in the editor.' },
  { id: 'gamma', group: 'Lighting', label: 'Scene gamma', type: 'range', xml: 'gamma', index: 0,
    min: 0, max: 20, step: 0.01, def: 1, log: true },
  // Not in the legacy format: the importer leaves it at 0. Goes into README.txt.
  { id: 'probeAmbiance', group: 'Lighting', label: 'Reflection probe ambiance', type: 'range', xml: null,
    min: 0, max: 10, step: 0.01, def: 2,
    hint: 'Not saved in the file. Type it into the sky editor after import. 1.75–3.75 suits open areas; 0 turns auto exposure off.' },

  // ---- Sun & Moon ----
  { id: 'sunlight', group: 'Sun & Moon', label: 'Sun / moon colour', type: 'color', xml: 'sunlight_color', scale: 3,
    def: [0.2447, 0.2605, 0.3], hint: 'Stored ×3 (0–3 scale), as in the editor.' },
  { id: 'sunAngle', group: 'Sun & Moon', label: 'Sun position', type: 'range', xml: 'sun_angle',
    min: 0, max: 360, step: 0.5, def: 60, unit: '°',
    toXml: (v) => v * DEG, fromXml: (s) => wrap360(s / DEG),
    hint: 'Along the sun’s arc: 0° rises, 90° overhead, 180° sets, 270° midnight.' },
  { id: 'eastAngle', group: 'Sun & Moon', label: 'East angle', type: 'range', xml: 'east_angle',
    min: 0, max: 360, step: 0.5, def: 0, unit: '°',
    toXml: (v) => v * DEG, fromXml: (s) => wrap360(s / DEG),
    hint: 'Turns the sun’s path around the compass.' },
  // glow[0] = (2 − size) × 20, glow[2] = focus × −5 (llpaneleditsky.cpp)
  { id: 'glowSize', group: 'Sun & Moon', label: 'Glow size', type: 'range', xml: 'glow', index: 0,
    min: 0, max: 1.99, step: 0.01, def: 1.75, toXml: (v) => (2 - v) * 20, fromXml: (s) => 2 - s / 20 },
  { id: 'glowFocus', group: 'Sun & Moon', label: 'Glow focus', type: 'range', xml: 'glow', index: 2,
    min: -2, max: 2, step: 0.01, def: 0.1, toXml: (v) => v * -5, fromXml: (s) => s / -5 },
  // Legacy stores 0–2; the importer multiplies by 250.
  { id: 'starBrightness', group: 'Sun & Moon', label: 'Star brightness', type: 'range', xml: 'star_brightness',
    min: 0, max: 500, step: 1, scale: 1 / 250, def: 0 },

  // ---- Clouds ----
  { id: 'cloudColor', group: 'Clouds', label: 'Cloud colour', type: 'color', xml: 'cloud_color',
    def: [0.41, 0.41, 0.41] },
  { id: 'cloudCoverage', group: 'Clouds', label: 'Cloud coverage', type: 'range', xml: 'cloud_shadow', index: 0,
    min: 0, max: 1, step: 0.01, def: 0.27 },
  { id: 'cloudScale', group: 'Clouds', label: 'Cloud scale', type: 'range', xml: 'cloud_scale', index: 0,
    min: 0.01, max: 3, step: 0.01, def: 0.42 },
  // Legacy scroll rates are stored +10; the importer subtracts it.
  { id: 'cloudScrollX', group: 'Clouds', label: 'Scroll X', type: 'range', xml: 'cloud_scroll_rate', index: 0,
    min: -30, max: 30, step: 0.01, offset: 10, def: 0.2 },
  { id: 'cloudScrollY', group: 'Clouds', label: 'Scroll Y', type: 'range', xml: 'cloud_scroll_rate', index: 1,
    min: -30, max: 30, step: 0.01, offset: 10, def: 0.01 },
  { id: 'cloudDensityX', group: 'Clouds', label: 'Density X', type: 'range', xml: 'cloud_pos_density1', index: 0,
    min: 0, max: 1, step: 0.01, def: 1 },
  { id: 'cloudDensityY', group: 'Clouds', label: 'Density Y', type: 'range', xml: 'cloud_pos_density1', index: 1,
    min: 0, max: 1, step: 0.01, def: 0.53 },
  { id: 'cloudDensityD', group: 'Clouds', label: 'Density D', type: 'range', xml: 'cloud_pos_density1', index: 2,
    min: 0, max: 3, step: 0.01, def: 1 },
  { id: 'cloudDetailX', group: 'Clouds', label: 'Detail X', type: 'range', xml: 'cloud_pos_density2', index: 0,
    min: 0, max: 1, step: 0.01, def: 1 },
  { id: 'cloudDetailY', group: 'Clouds', label: 'Detail Y', type: 'range', xml: 'cloud_pos_density2', index: 1,
    min: 0, max: 1, step: 0.01, def: 0.53 },
  { id: 'cloudDetailD', group: 'Clouds', label: 'Detail D', type: 'range', xml: 'cloud_pos_density2', index: 2,
    min: 0, max: 1, step: 0.01, def: 1 },
];

// Water: legacy keys are camelCase and mostly plain numbers (llsettingswater.cpp).
export const WATER_XML = {
  waterFogColor:    { len: 4, fill: [0, 0, 0, 1] },
  waterFogDensity:  { len: 0 },
  underWaterFogMod: { len: 0 },
  fresnelScale:     { len: 0 },
  fresnelOffset:    { len: 0 },
  scaleAbove:       { len: 0 },
  scaleBelow:       { len: 0 },
  blurMultiplier:   { len: 0 },
  normScale:        { len: 3, fill: [2, 2, 2] },
  wave1Dir:         { len: 2, fill: [0, 0] },
  wave2Dir:         { len: 2, fill: [0, 0] },
};

export const WATER_GROUPS = ['Fog', 'Reflection', 'Waves'];

export const WATER_PARAMS = [
  { id: 'fogColor', group: 'Fog', label: 'Fog colour', type: 'color', xml: 'waterFogColor', def: [0.0156, 0.149, 0.2509] },
  { id: 'fogDensity', group: 'Fog', label: 'Fog density', type: 'range', xml: 'waterFogDensity',
    min: 0.001, max: 100, step: 0.01, def: 2, log: true },
  { id: 'fogMod', group: 'Fog', label: 'Underwater fog modifier', type: 'range', xml: 'underWaterFogMod',
    min: 0, max: 20, step: 0.01, def: 0.25 },
  { id: 'fresnelScale', group: 'Reflection', label: 'Fresnel scale', type: 'range', xml: 'fresnelScale',
    min: 0, max: 1, step: 0.01, def: 0.4 },
  { id: 'fresnelOffset', group: 'Reflection', label: 'Fresnel offset', type: 'range', xml: 'fresnelOffset',
    min: 0, max: 1, step: 0.01, def: 0.5 },
  { id: 'scaleAbove', group: 'Reflection', label: 'Refraction scale above', type: 'range', xml: 'scaleAbove',
    min: 0, max: 3, step: 0.01, def: 0.03 },
  { id: 'scaleBelow', group: 'Reflection', label: 'Refraction scale below', type: 'range', xml: 'scaleBelow',
    min: 0, max: 3, step: 0.01, def: 0.2 },
  { id: 'blur', group: 'Reflection', label: 'Blur multiplier', type: 'range', xml: 'blurMultiplier',
    min: 0, max: 0.5, step: 0.001, def: 0.04 },
  { id: 'wave1X', group: 'Waves', label: 'Wave 1 X', type: 'range', xml: 'wave1Dir', index: 0, min: -20, max: 20, step: 0.01, def: 1.05 },
  { id: 'wave1Y', group: 'Waves', label: 'Wave 1 Y', type: 'range', xml: 'wave1Dir', index: 1, min: -20, max: 20, step: 0.01, def: -0.42 },
  { id: 'wave2X', group: 'Waves', label: 'Wave 2 X', type: 'range', xml: 'wave2Dir', index: 0, min: -20, max: 20, step: 0.01, def: 1.11 },
  { id: 'wave2Y', group: 'Waves', label: 'Wave 2 Y', type: 'range', xml: 'wave2Dir', index: 1, min: -20, max: 20, step: 0.01, def: -1.16 },
  { id: 'normScaleX', group: 'Waves', label: 'Normal scale X', type: 'range', xml: 'normScale', index: 0, min: 0, max: 10, step: 0.01, def: 2 },
  { id: 'normScaleY', group: 'Waves', label: 'Normal scale Y', type: 'range', xml: 'normScale', index: 1, min: 0, max: 10, step: 0.01, def: 2 },
  { id: 'normScaleZ', group: 'Waves', label: 'Normal scale Z', type: 'range', xml: 'normScale', index: 2, min: 0, max: 10, step: 0.01, def: 2 },
];

// The viewer's default water normal map (DEFAULT_WATER_NORMAL in indra_constants.cpp).
export const DEFAULT_WATER_NORMAL = '822ded49-9a6c-f61c-cb89-6df54f42cdf4';

export function defaults(params) {
  return Object.fromEntries(params.map((p) => [p.id, Array.isArray(p.def) ? [...p.def] : p.def]));
}

// Shown value → stored value (and back) for one number.
export function toStored(p, v) {
  if (p.toXml) return p.toXml(v);
  return v * (p.scale ?? 1) + (p.offset ?? 0);
}

export function fromStored(p, s) {
  if (p.fromXml) return p.fromXml(s);
  return (s - (p.offset ?? 0)) / (p.scale ?? 1);
}

function wrap360(d) {
  return ((d % 360) + 360) % 360;
}
