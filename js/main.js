// App state, UI wiring and event handling. Controls are generated from params.js.
// One shared project state: every input writes into it, the preview redraws from
// it on each change, and the XML writer reads it only on export.

import { SKY_PARAMS, SKY_GROUPS, WATER_PARAMS, WATER_GROUPS, defaults } from './params.js';
import { skyXml, skyFromLegacy, waterFromLegacy, parseXml, legacyFileName, cleanName } from './legacy-xml.js';
import { downloadBlob, downloadZip, bundleFiles } from './export.js';
import { skyAt, generateVariants, formatTime, parseTime } from './daycycle.js';
import { skyUniforms, horizonColor } from './atmosphere.js';

const STORAGE_KEY = 'sky-maker:project:v2';
const OLD_STORAGE_KEY = 'sky-maker:project:v1';
const PROJECT_VERSION = 2;
const MAX_DAY_KEYS = 4; // v1 keeps day cycles small: ambiance is set by hand per sky

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------- Project ----------
// A project is one look, the way Firestorm sees it: either a single sky, or a day cycle
// where every key has its own sky. Sky names come from the project name ("My Look",
// or "My Look Sunset" for a key labelled Sunset), so there is no sky list to manage.
const DEFAULT_NAME = 'My Look';

function freshProject() {
  const id = uid();
  return {
    version: PROJECT_VERSION,
    name: DEFAULT_NAME,
    skies: [{ id, name: DEFAULT_NAME, label: '', values: defaults(SKY_PARAMS) }],
    active: id,
    water: defaults(WATER_PARAMS),
    day: [],
  };
}

// Enforce the model after any change or load:
// no day cycle → exactly one sky; day cycle → one sky per key, and nothing else.
function normalize(p) {
  if (!p.day.length) {
    const keep = p.skies.find((s) => s.id === p.active) ?? p.skies[0];
    p.skies = [keep];
    keep.label = '';
  } else {
    const used = new Set();
    p.day.sort((a, b) => a.time - b.time);
    for (const k of p.day) {
      let sky = p.skies.find((s) => s.id === k.sky);
      if (used.has(k.sky)) {
        // Two keys shared a sky (older projects): give the second its own copy.
        sky = { ...structuredClone(sky), id: uid() };
        p.skies.push(sky);
        k.sky = sky.id;
      }
      used.add(k.sky);
      if (!sky.label) sky.label = formatTime(k.time).replace(':', '.');
    }
    p.skies = p.skies.filter((s) => used.has(s.id));
  }
  if (!p.skies.some((s) => s.id === p.active)) p.active = p.skies[0].id;
  syncNames(p);
  return p;
}

function syncNames(p) {
  const taken = new Set();
  for (const s of p.skies) {
    s.name = uniqueName(cleanName(s.label ? `${p.name} ${s.label}` : p.name), taken);
    taken.add(s.name);
  }
}

function cleanValues(params, raw) {
  const out = defaults(params);
  for (const p of params) {
    const v = raw?.[p.id];
    if (p.type === 'color' && Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) out[p.id] = v.map((x) => clamp(x, 0, 1));
    if (p.type === 'range' && Number.isFinite(v)) out[p.id] = clamp(v, p.min, p.max);
  }
  return out;
}

// Keep only known keys with the right shape, so an old or hand-edited file can't break the UI.
// Version 1 projects held a single sky: { name, sky }.
function sanitize(raw) {
  const p = freshProject();
  if (!raw || typeof raw !== 'object') return p;
  if (typeof raw.name === 'string') p.name = cleanName(raw.name, 'My Look');
  if (raw.version === 1 || (raw.sky && !raw.skies)) {
    p.skies[0].values = cleanValues(SKY_PARAMS, raw.sky);
    return normalize(p);
  }
  if (Array.isArray(raw.skies) && raw.skies.length) {
    p.skies = raw.skies.slice(0, 32).map((s) => ({
      id: typeof s?.id === 'string' ? s.id : uid(),
      label: typeof s?.label === 'string' ? cleanLabel(s.label) : '',
      name: cleanName(s?.name),
      values: cleanValues(SKY_PARAMS, s?.values),
    }));
  }
  p.active = p.skies.some((s) => s.id === raw.active) ? raw.active : p.skies[0].id;
  p.water = cleanValues(WATER_PARAMS, raw.water);
  if (Array.isArray(raw.day)) {
    p.day = raw.day
      .filter((k) => k && Number.isFinite(k.time) && p.skies.some((s) => s.id === k.sky))
      .map((k) => ({ id: typeof k.id === 'string' ? k.id : uid(), time: clamp(k.time, 0, 0.9999), sky: k.sky }));
  }
  // Older projects named skies freely ("My Look Sunset"): keep the part after the project name as the label.
  for (const s of p.skies) {
    if (!s.label && p.day.some((k) => k.sky === s.id)) {
      s.label = cleanLabel(s.name.startsWith(`${p.name} `) ? s.name.slice(p.name.length + 1) : s.name.split(' ').pop());
    }
  }
  return normalize(p);
}

const cleanLabel = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 24);

function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
}

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_STORAGE_KEY);
    return sanitize(JSON.parse(raw || 'null'));
  } catch { return freshProject(); }
}

function saveProject() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(project)); } catch { /* storage unavailable */ }
}

let project = loadProject();
const ui = { tab: 'sky', dayTime: 0.5, playing: false, preview: null };
const activeSky = () => project.skies.find((s) => s.id === project.active) ?? project.skies[0];
const skyById = () => Object.fromEntries(project.skies.map((s) => [s.id, s.values]));

// ---------- Control building ----------
const controls = new Map(); // id -> function that shows the current value

function decimals(step) {
  return step >= 1 ? 0 : Math.max(0, Math.ceil(-Math.log10(step)));
}

// Log sliders give wide ranges (distance multiplier 0.05–1000) usable resolution.
const SLIDER_STEPS = 1000;
function toSlider(p, v) {
  if (!p.log) return v;
  const lo = Math.log(p.min), hi = Math.log(p.max);
  return Math.round(((Math.log(clamp(v, p.min, p.max)) - lo) / (hi - lo)) * SLIDER_STEPS);
}
function fromSlider(p, s) {
  if (!p.log) return s;
  const lo = Math.log(p.min), hi = Math.log(p.max);
  return +Math.exp(lo + (s / SLIDER_STEPS) * (hi - lo)).toFixed(decimals(p.step));
}

// `target()` returns the values object the control edits (the active sky, or the water).
function buildRange(p, target, key) {
  const el = document.createElement('div');
  el.className = 'ctl';
  el.innerHTML = `<label class="ctl-label"><span></span><span class="num"><input type="number"><small></small></span></label><input type="range">`;
  el.querySelector('.ctl-label > span').textContent = p.label;
  el.querySelector('small').textContent = p.unit ?? '';
  const num = el.querySelector('input[type="number"]');
  const range = el.querySelector('input[type="range"]');
  num.setAttribute('aria-label', p.label);
  range.setAttribute('aria-label', p.label);
  Object.assign(num, { min: p.min, max: p.max, step: p.step });
  if (p.log) Object.assign(range, { min: 0, max: SLIDER_STEPS, step: 1 });
  else Object.assign(range, { min: p.min, max: p.max, step: p.step });

  const show = () => {
    const v = target()[p.id];
    range.value = toSlider(p, v);
    if (document.activeElement !== num) num.value = v.toFixed(decimals(p.step));
  };
  range.addEventListener('input', () => {
    target()[p.id] = fromSlider(p, parseFloat(range.value));
    num.value = target()[p.id].toFixed(decimals(p.step));
    changed();
  });
  num.addEventListener('input', () => {
    const v = parseFloat(num.value);
    if (!Number.isFinite(v)) return;
    target()[p.id] = clamp(v, p.min, p.max);
    range.value = toSlider(p, target()[p.id]);
    changed();
  });
  num.addEventListener('change', show);
  controls.set(key, show);
  if (p.hint) appendHint(el, p.hint);
  return el;
}

// A colour is three 0–1 sliders plus a swatch, matching the editor's colour picker.
function buildColor(p, target, key) {
  const el = document.createElement('div');
  el.className = 'ctl color';
  el.innerHTML = `<div class="ctl-label"><span></span><span class="swatch-wrap"><output></output><input type="color" class="swatch"></span></div>`;
  el.querySelector('.ctl-label > span').textContent = p.label;
  const swatch = el.querySelector('.swatch');
  const out = el.querySelector('output');
  swatch.setAttribute('aria-label', `${p.label} colour picker`);
  const rows = ['R', 'G', 'B'].map((ch, i) => {
    const row = document.createElement('label');
    row.className = 'channel';
    row.innerHTML = `<span>${ch}</span><input type="range" min="0" max="1" step="0.001"><output></output>`;
    const input = row.querySelector('input');
    input.setAttribute('aria-label', `${p.label} ${ch}`);
    input.addEventListener('input', () => {
      target()[p.id][i] = parseFloat(input.value);
      show();
      changed();
    });
    el.append(row);
    return { input, out: row.querySelector('output') };
  });
  swatch.addEventListener('input', () => {
    const hex = swatch.value;
    target()[p.id] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255);
    show();
    changed();
  });

  function show() {
    const v = target()[p.id];
    const bytes = v.map((x) => Math.round(clamp(x, 0, 1) * 255));
    rows.forEach((r, i) => { r.input.value = v[i]; r.out.textContent = v[i].toFixed(3); });
    swatch.value = '#' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    out.textContent = bytes.join(', ');
  }
  controls.set(key, show);
  if (p.hint) appendHint(el, p.hint);
  return el;
}

function appendHint(el, text) {
  const h = document.createElement('p');
  h.className = 'hint';
  h.textContent = text;
  el.append(h);
}

function buildGroups(root, params, groups, target, scope) {
  for (const title of groups) {
    const group = document.createElement('details');
    group.className = 'group';
    group.open = true;
    group.innerHTML = '<summary></summary>';
    group.querySelector('summary').textContent = title;
    for (const p of params.filter((q) => q.group === title)) {
      const key = `${scope}:${p.id}`;
      const el = p.type === 'color' ? buildColor(p, target, key) : buildRange(p, target, key);
      if (p.xml === null) el.classList.add('not-in-file');
      group.append(el);
    }
    root.append(group);
  }
}

// ---------- Which sky is being edited ----------
// Only shown with a day cycle: one chip per key, in time order.
function renderSkyPicker() {
  const wrap = $('#sky-times');
  wrap.hidden = !project.day.length;
  const byId = Object.fromEntries(project.skies.map((s) => [s.id, s]));
  $('#sky-time-chips').replaceChildren(...project.day.map((k) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.setAttribute('aria-pressed', k.sky === project.active);
    b.innerHTML = '<span class="mono"></span> <span></span>';
    b.firstChild.textContent = formatTime(k.time);
    b.lastChild.textContent = byId[k.sky].label;
    b.addEventListener('click', () => editKey(k));
    return b;
  }));
}

// Night, Sunrise, Noon and Sunset versions of one sky, each a key with its own sky.
function makeDayCycle(base) {
  project.skies = [];
  project.day = generateVariants(base).map((v) => {
    const sky = { id: uid(), label: v.name, name: '', values: v.values };
    project.skies.push(sky);
    return { id: uid(), time: v.time, sky: sky.id };
  });
  project.active = project.skies[2].id; // Noon: closest to the sky it came from
  ui.dayTime = 0.5;
}

// Edit a key's sky: select it, move the timeline's time marker there and show the Sky tab.
function editKey(k) {
  project.active = k.sky;
  ui.dayTime = k.time;
  if (ui.tab !== 'sky') setTab('sky');
  changed({ controls: true, day: true });
}

// ---------- Day cycle ----------
function renderDay() {
  const list = $('#day-keys');
  const byId = Object.fromEntries(project.skies.map((s) => [s.id, s]));
  list.replaceChildren(...project.day.map((k) => {
    const sky = byId[k.sky];
    const row = document.createElement('li');
    row.className = 'day-key';
    row.innerHTML = `<input type="text" class="time" maxlength="5" aria-label="Time"><input type="text" class="label" maxlength="24" aria-label="Name of this key"><button class="btn ghost sm">Edit</button><button class="icon-btn close" aria-label="Remove key">×</button>`;
    const [time, label] = row.querySelectorAll('input');
    time.value = formatTime(k.time);
    time.addEventListener('change', () => {
      const t = parseTime(time.value);
      if (t === null) { time.value = formatTime(k.time); return toast('Use 24-hour time, like 06:30', true); }
      k.time = t;
      changed({ day: true });
    });
    label.value = sky.label;
    label.addEventListener('change', () => {
      sky.label = cleanLabel(label.value) || formatTime(k.time).replace(':', '.');
      changed({ day: true, controls: true });
    });
    row.querySelector('.btn').addEventListener('click', () => editKey(k));
    const remove = row.querySelector('.icon-btn');
    remove.disabled = project.day.length < 2;
    remove.title = remove.disabled ? 'A day cycle needs at least one key. Use “Remove the day cycle” instead.' : 'Remove key';
    remove.addEventListener('click', () => {
      project.day = project.day.filter((x) => x !== k);
      changed({ day: true, controls: true });
    });
    return row;
  }));
  const has = project.day.length > 0;
  $('#day-off').hidden = has; // tab reads "Day cycle · off" while the look is a single sky
  $('#day-empty').hidden = has;
  $('#day-warn').hidden = project.day.length <= MAX_DAY_KEYS;
  $('#generate-day').textContent = has ? 'Regenerate from the sky being edited' : 'Make a day cycle from this sky';
  $('#add-key').hidden = !has;
  $('#timeline').hidden = ui.tab !== 'day' || !has;
  $('#remove-day').hidden = !has;
  renderTimeline();
}

function renderTimeline() {
  const track = $('#timeline-track');
  track.querySelectorAll('.marker').forEach((m) => m.remove());
  const names = Object.fromEntries(project.skies.map((s) => [s.id, s.label]));
  for (const k of project.day) {
    const m = document.createElement('button');
    m.className = 'marker';
    placeMarker(m, k.time);
    m.title = `${formatTime(k.time)} ${names[k.sky] ?? ''}`;
    m.setAttribute('aria-label', `Keyframe ${m.title}. Drag to move.`);
    m.textContent = names[k.sky] ?? '?';
    m.addEventListener('pointerdown', (e) => dragMarker(e, k, m));
    track.append(m);
  }
  $('#timeline-head').style.left = `${ui.dayTime * 100}%`;
  $('#timeline-time').textContent = formatTime(ui.dayTime);
  updateToolbar();
}

// Labels slide from left- to right-aligned across the day so the end ones stay on the track.
function placeMarker(m, t) {
  m.style.left = `${t * 100}%`;
  m.style.transform = `translateX(-${t * 100}%)`;
}

function timeFromPointer(e) {
  const r = $('#timeline-track').getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 0.9999);
}

// Drag snaps to 5 minutes; the time marker follows so the preview shows the key.
function dragMarker(e, k, m) {
  e.preventDefault();
  e.stopPropagation();
  m.setPointerCapture(e.pointerId);
  const move = (ev) => {
    k.time = Math.round(timeFromPointer(ev) * 288) / 288 % 1;
    ui.dayTime = k.time;
    placeMarker(m, k.time);
    $('#timeline-head').style.left = `${k.time * 100}%`;
    $('#timeline-time').textContent = formatTime(k.time);
    updatePreview();
  };
  const up = () => {
    m.removeEventListener('pointermove', move);
    m.removeEventListener('pointerup', up);
    changed({ day: true });
  };
  m.addEventListener('pointermove', move);
  m.addEventListener('pointerup', up);
}

// ---------- Preview ----------
function previewSky() {
  if (ui.tab === 'day' && project.day.length) return skyAt(project.day, skyById(), ui.dayTime) ?? activeSky().values;
  return activeSky().values;
}

function updatePreview() {
  const sky = previewSky();
  if (ui.preview) {
    ui.preview.setSky(sky);
    ui.preview.setWater(project.water);
    const info = ui.preview.info();
    $('#exposure-badge').textContent = sky.probeAmbiance > 0 ? `Auto exposure ×${info.exposure.toFixed(2)}` : 'Auto exposure off';
  }
  $('#ambiance-badge').textContent = `Ambiance ${sky.probeAmbiance.toFixed(2)}`;
}

// ---------- Change handling ----------
// Batched per task, not per animation frame, so state is saved even in a background tab.
let pending = false;
let pendingOpts = {};
function changed(opts = {}) {
  pendingOpts = { ...pendingOpts, ...opts };
  if (!pending) {
    pending = true;
    queueMicrotask(() => {
      const o = pendingOpts;
      pending = false;
      pendingOpts = {};
      normalize(project);
      if (o.day || o.skies) renderDay();
      if (o.day || o.skies || o.controls) renderSkyPicker();
      if (o.controls) refreshControls();
      updatePreview();
      updateToolbar();
      saveProject();
    });
  }
}

function refreshControls() {
  for (const show of controls.values()) show();
  $('#project-name').value = project.name;
  renderSkyPicker();
}

// Panel titles: the project name on the editor, the sky, water or time on the preview.
function updateToolbar() {
  const sky = activeSky();
  const keys = project.day.length;
  $('#project-title').textContent = project.name;
  $('#project-meta').textContent = keys ? `day cycle · ${keys} ${keys === 1 ? 'key' : 'keys'}` : 'one sky';
  if (ui.tab === 'water') {
    $('#preview-title').textContent = 'Water';
    $('#file-name').textContent = 'water/Default.xml';
  } else if (ui.tab === 'day' && project.day.length) {
    $('#preview-title').textContent = `Day cycle · ${formatTime(ui.dayTime)}`;
    $('#file-name').textContent = `days/${legacyFileName(project.name)}`;
  } else {
    $('#preview-title').textContent = sky.name;
    $('#file-name').textContent = `skies/${legacyFileName(sky.name)}`;
  }
}

// ---------- Tabs ----------
function setTab(tab) {
  ui.tab = tab;
  for (const b of document.querySelectorAll('[role="tab"]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of document.querySelectorAll('[role="tabpanel"]')) p.hidden = p.id !== `tab-${tab}`;
  $('#timeline').hidden = tab !== 'day' || !project.day.length;
  if (tab !== 'day') setPlaying(false);
  changed();
}

// ---------- Water ----------
// "Match sky": take the rendered horizon colour toward the viewer, darken it a little, use it as fog.
function matchSky() {
  const lin = horizonColor(skyUniforms(activeSky().values));
  const srgb = lin.map((c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  const peak = Math.max(...srgb, 1e-3);
  project.water.fogColor = srgb.map((c) => clamp((c / peak) * Math.min(peak, 0.45) * 0.6, 0, 1));
  changed({ controls: true });
  toast('Fog colour set from the sky’s horizon');
}

// ---------- Photo / HDRI ----------
let photoUndo = null;
async function analyzeFile(file) {
  const status = $('#photo-status');
  status.textContent = `Reading ${file.name}…`;
  try {
    const { analyzeSky, pixelsFromFile } = await import('./analyze.js');
    const pixels = await pixelsFromFile(file);
    const res = analyzeSky(pixels, { kind: $('#photo-kind').value });
    drawThumb(pixels);
    // The image sets the whole look: the sky (or, with a day cycle, every key regenerated
    // from it) on top of the current settings. Undo puts the previous look back.
    photoUndo = structuredClone({ name: project.name, skies: project.skies, day: project.day, active: project.active });
    let values = cleanValues(SKY_PARAMS, { ...structuredClone(activeSky().values), ...structuredClone(res.values), ...(res.sun ?? {}) });
    if (res.targets) {
      const { fitSkyColors } = await import('./fit.js');
      const fit = fitSkyColors(values, res.targets);
      values = cleanValues(SKY_PARAMS, fit.values);
      res.notes.splice(-1, 0, fit.error < 0.15
        ? 'Sky colours fitted so the rendered zenith and horizon match the image.'
        : 'Sky colours fitted as closely as the WindLight model allows; the image’s colours are partly out of its range.');
    }
    if (project.name === DEFAULT_NAME) project.name = prettyName(file.name);
    const hadDay = project.day.length > 0;
    if (hadDay) makeDayCycle(values);
    else activeSky().values = values;
    const notes = $('#photo-notes');
    notes.replaceChildren(...res.notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
    status.textContent = hadDay
      ? `${res.kind === 'hdri' ? 'HDRI' : 'Photo'}: the day cycle was regenerated from this image. The preview behind shows it.`
      : `${res.kind === 'hdri' ? 'HDRI' : 'Photo'}: the sky now comes from this image. The preview behind shows it.`;
    $('#photo-actions').hidden = false;
    setTab('sky');
    changed({ controls: true, day: true });
  } catch (err) {
    status.textContent = `Couldn’t read ${file.name}: ${err.message}`;
  }
}

// "pink_sunrise_2k.exr" → "Pink Sunrise 2k"
function prettyName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return cleanName(base.replace(/\b[a-z]/g, (c) => c.toUpperCase()));
}

function drawThumb(px) {
  const c = $('#photo-thumb');
  const w = 240;
  const h = Math.max(1, Math.round((px.height / px.width) * w));
  c.width = w;
  c.height = h;
  c.hidden = false;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  // Simple Reinhard so HDR files show something sensible.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x / w) * px.width), sy = Math.floor((y / h) * px.height);
      const k = (sy * px.width + sx) * 3, o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = px.data[k + ch];
        if (px.hdr) v = v / (1 + v);
        img.data[o + ch] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
      }
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------- Files ----------
function downloadSky() {
  const sky = activeSky();
  downloadBlob(new Blob([skyXml(sky.values)], { type: 'application/xml' }), legacyFileName(sky.name));
  toast(`Saved. After import, set Reflection Probe Ambiance to ${sky.values.probeAmbiance.toFixed(2)}.`);
}

async function downloadAll() {
  try {
    await downloadZip(project);
    toast('Zip saved. README.txt lists the ambiance to set for each sky.');
  } catch (err) {
    toast(`Couldn’t build the zip: ${err.message}`, true);
  }
}

function saveJson() {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${project.name}.skyproject.json`);
}

function decodeName(fileName) {
  const base = fileName.replace(/\.xml$/i, '');
  try { return decodeURIComponent(base); } catch { return base; }
}

// Open a saved project, or legacy files: pick a day cycle together with its skies (and
// water) to load a whole exported look, or a single sky to replace the one being edited.
async function openFiles(files) {
  try {
    const json = files.find((f) => /\.json$/i.test(f.name));
    if (json) {
      project = sanitize(JSON.parse(await json.text()));
      toast('Project loaded');
      return changed({ controls: true, day: true });
    }
    const skies = new Map();
    let day = null;
    let dayName = '';
    let water = null;
    for (const f of files) {
      const data = parseXml(await f.text());
      const name = decodeName(f.name);
      if (Array.isArray(data)) { day = data; dayName = name; }
      else if (data && 'waterFogColor' in data) water = data;
      else if (data && ('sun_angle' in data || 'ambient' in data)) skies.set(name, data);
      else throw new Error(`${f.name} isn’t a sky, water or day cycle file`);
    }
    if (water) project.water = cleanValues(WATER_PARAMS, waterFromLegacy(water, project.water));
    // Ambiance isn't in legacy files: keep the current one.
    const base = activeSky().values;
    if (day) {
      const missing = day.map((k) => String(k[1])).filter((n) => !skies.has(n));
      if (missing.length) throw new Error(`pick the day cycle’s skies too: ${[...new Set(missing)].join(', ')}`);
      project.name = cleanName(dayName, DEFAULT_NAME);
      project.skies = [];
      project.day = day.map((k) => {
        const skyName = String(k[1]);
        const label = skyName.startsWith(`${project.name} `) ? skyName.slice(project.name.length + 1) : skyName;
        const sky = { id: uid(), label: cleanLabel(label), name: '', values: cleanValues(SKY_PARAMS, skyFromLegacy(skies.get(skyName), base)) };
        project.skies.push(sky);
        return { id: uid(), time: clamp(Number(k[0]) || 0, 0, 0.9999), sky: sky.id };
      });
      toast(`Day cycle “${project.name}” loaded with ${project.day.length} keys`);
    } else if (skies.size) {
      const [name, data] = skies.entries().next().value;
      activeSky().values = cleanValues(SKY_PARAMS, skyFromLegacy(data, base));
      if (!project.day.length && project.name === DEFAULT_NAME) project.name = cleanName(name, DEFAULT_NAME);
      toast(skies.size > 1
        ? `Loaded “${name}”. To load several skies, pick the day cycle file with them.`
        : project.day.length ? `“${name}” loaded into the ${activeSky().label} key` : `Sky “${name}” loaded`, skies.size > 1);
    } else if (water) {
      toast('Legacy water loaded');
    }
    changed({ controls: true, day: true });
  } catch (err) {
    toast(`Couldn’t open that: ${err.message}`, true);
  }
}

function showFiles() {
  const files = bundleFiles(project);
  const sel = $('#files-select');
  const dec = new TextDecoder();
  const names = Object.keys(files);
  const want = ui.tab === 'water' ? 'water/Default.xml' : ui.tab === 'day' ? names.find((n) => n.startsWith('days/')) : `skies/${legacyFileName(activeSky().name)}`;
  sel.replaceChildren(...names.map((n) => new Option(n, n, false, n === want)));
  const show = () => { $('#files-content').textContent = dec.decode(files[sel.value]); };
  sel.onchange = show;
  show();
  $('#files-meta').textContent = `${names.length} files`;
  $('#files').showModal();
}

// ---------- How to import ----------
// Steps for this project as it is now: one sky, or a day cycle with one ambiance per key.
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function showImportHelp() {
  const byId = Object.fromEntries(project.skies.map((s) => [s.id, s]));
  const file = (dir, name) => `<span class="mono">${dir}/${escHtml(legacyFileName(name))}</span>`;
  const amb = (sky) => sky.values.probeAmbiance.toFixed(2);
  const apply = '<li>Click <strong>Save</strong>, then right-click it in your inventory and choose <strong>Apply Only to Myself</strong> (or apply it to your parcel or region).</li>';
  let html = `<p>Unzip <span class="mono">${escHtml(project.name)}.zip</span> first, and keep its <span class="mono">skies</span>, <span class="mono">water</span> and <span class="mono">days</span> folders together.</p>`;
  if (!project.day.length) {
    const sky = project.skies[0];
    html += `<h3>Sky</h3><ol>
      <li>In your inventory, click <strong>+</strong>, then <strong>New Settings → New Sky</strong>.</li>
      <li>Open it, click <strong>Import</strong> and pick ${file('skies', sky.name)}.</li>
      <li>On the <strong>Atmosphere &amp; Lighting</strong> tab, set <strong>Reflection Probe Ambiance</strong> to <strong>${amb(sky)}</strong>. The file can’t carry this PBR setting, so it arrives as 0.</li>
      ${apply}</ol>`;
  } else {
    const rows = project.day.map((k) => `<span class="mono">${formatTime(k.time)}</span><span>${escHtml(byId[k.sky].label)}</span><span class="num">${amb(byId[k.sky])}</span>`).join('');
    html += `<h3>Day cycle</h3><ol>
      <li>In your inventory, click <strong>+</strong>, then <strong>New Settings → New Day Cycle</strong>.</li>
      <li>Open it, click <strong>Import</strong> and pick ${file('days', project.name)}. It loads its skies from <span class="mono">skies</span> and its water from <span class="mono">water/Default.xml</span>.</li>
      <li>Click each sky key on the day cycle’s timeline and set <strong>Reflection Probe Ambiance</strong> on its <strong>Atmosphere &amp; Lighting</strong> tab. The files can’t carry it, so every key arrives at 0:
        <div class="values">${rows}</div></li>
      ${apply}</ol>
      <p class="hint">Shortcut: <strong>World → Environment → Bulk Import</strong> creates every sky, the water and the day cycle at once. The ambiance still needs setting on each sky.</p>`;
  }
  html += `<h3>Water${project.day.length ? ' on its own (optional)' : ''}</h3><ol>
    <li>Click <strong>+</strong>, then <strong>New Settings → New Water</strong>.</li>
    <li>Open it, click <strong>Import</strong> and pick ${file('water', project.name)}.</li>
    ${apply}</ol>`;
  $('#import-steps').innerHTML = html;
  $('#import-meta').textContent = project.day.length ? `day cycle · ${project.day.length} keys` : 'one sky';
  $('#import-dialog').showModal();
}

// ---------- Toast ----------
let toastTimer = 0;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}

// ---------- Day playback ----------
let lastFrame = 0;
function setPlaying(on) {
  ui.playing = on;
  $('#play').textContent = on ? 'Pause' : 'Play';
  $('#play').setAttribute('aria-pressed', on);
  if (on) { lastFrame = performance.now(); requestAnimationFrame(tick); }
}
function tick(now) {
  if (!ui.playing) return;
  ui.dayTime = (ui.dayTime + ((now - lastFrame) / 1000) / 48) % 1; // a whole day in 48 s
  lastFrame = now;
  renderTimeline();
  updatePreview();
  requestAnimationFrame(tick);
}

// ---------- Wiring ----------
buildGroups($('#sky-groups'), SKY_PARAMS, SKY_GROUPS, () => activeSky().values, 'sky');
buildGroups($('#water-groups'), WATER_PARAMS, WATER_GROUPS, () => project.water, 'water');
refreshControls();
renderDay();
updateToolbar();

for (const b of document.querySelectorAll('[role="tab"]')) {
  b.addEventListener('click', () => setTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const i = (tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[i].focus();
    setTab(tabs[i].dataset.tab);
  });
}

$('#project-name').addEventListener('input', (e) => { project.name = cleanName(e.target.value, DEFAULT_NAME); changed(); });
$('#project-name').addEventListener('change', (e) => { e.target.value = project.name; });

$('#match-sky').addEventListener('click', matchSky);

$('#generate-day').addEventListener('click', () => {
  if (project.day.length && !confirm('Replace every key with Night, Sunrise, Noon and Sunset versions of the sky you’re editing?')) return;
  makeDayCycle(activeSky().values);
  changed({ controls: true, day: true });
  toast('Day cycle made: keys at 00:00, 06:00, 12:00 and 18:00, each with its own sky');
});
$('#remove-day').addEventListener('click', () => {
  if (!confirm(`Remove the day cycle and keep only the ${activeSky().label} sky?`)) return;
  project.day = [];
  changed({ controls: true, day: true });
});
// A new key starts from what the day looks like at the time picked on the timeline.
$('#add-key').addEventListener('click', () => {
  const time = Math.round(ui.dayTime * 288) / 288 % 1;
  // Two keys at the same time would fight: open the one that's there instead.
  const near = project.day.find((k) => Math.abs(((k.time - time + 1.5) % 1) - 0.5) < 15 / 1440);
  if (near) {
    editKey(near);
    return toast(`There’s already a key at ${formatTime(near.time)}. Pick another time on the timeline to add one there.`);
  }
  const values = structuredClone(skyAt(project.day, skyById(), time) ?? activeSky().values);
  const sky = { id: uid(), label: formatTime(time).replace(':', '.'), name: '', values };
  project.skies.push(sky);
  project.day.push({ id: uid(), time, sky: sky.id });
  project.active = sky.id;
  changed({ controls: true, day: true });
});
$('#timeline-track').addEventListener('pointerdown', (e) => {
  const track = e.currentTarget;
  track.setPointerCapture(e.pointerId);
  const scrub = (ev) => { ui.dayTime = timeFromPointer(ev); renderTimeline(); updatePreview(); };
  scrub(e);
  track.onpointermove = scrub;
  track.onpointerup = () => { track.onpointermove = null; };
});
$('#timeline-track').addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 1 / 24 : 1 / 96;
  if (e.key === 'ArrowRight') ui.dayTime = (ui.dayTime + step) % 1;
  else if (e.key === 'ArrowLeft') ui.dayTime = (ui.dayTime - step + 1) % 1;
  else return;
  e.preventDefault();
  renderTimeline();
  updatePreview();
});
$('#play').addEventListener('click', () => setPlaying(!ui.playing));

$('#photo-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) analyzeFile(f);
  e.target.value = '';
});
const dz = $('#photo-drop');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dz.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) analyzeFile(f);
});
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#photo-input').click(); } });
dz.addEventListener('click', () => $('#photo-input').click());
$('#photo-undo').addEventListener('click', () => {
  if (!photoUndo) return;
  Object.assign(project, photoUndo);
  photoUndo = null;
  $('#photo-actions').hidden = true;
  $('#photo-status').textContent = 'Put back the look from before the image.';
  changed({ controls: true, day: true });
});

// "Generate from an image" works on the whole look, so it's an action, not an editor tab.
function openImageDialog() {
  $('#photo-actions').hidden = !photoUndo;
  $('#image-dialog').showModal();
}
$('#open-image').addEventListener('click', openImageDialog);
$('#photo-done').addEventListener('click', () => $('#image-dialog').close());
// Dropping an image anywhere on the page opens the dialog with it.
const isImage = (f) => f && (/^image\//.test(f.type) || /\.(exr|hdr)$/i.test(f.name));
document.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (!isImage(f)) return;
  e.preventDefault();
  if (!$('#image-dialog').open) openImageDialog();
  analyzeFile(f);
});

$('#download-sky').addEventListener('click', downloadSky);
$('#download-all').addEventListener('click', downloadAll);
$('#how-to-import').addEventListener('click', showImportHelp);
$('#how-to-import-menu').addEventListener('click', showImportHelp);
$('#save-json').addEventListener('click', saveJson);
$('#view-files').addEventListener('click', showFiles);
$('#face-sun').addEventListener('click', () => ui.preview?.faceLight());
$('#look-up').addEventListener('click', () => ui.preview?.lookUp());
$('#zoom').addEventListener('click', (e) => {
  const on = document.body.classList.toggle('zoomed');
  e.currentTarget.setAttribute('aria-pressed', on);
  e.currentTarget.title = on ? 'Restore' : 'Zoom';
});
$('#animate').addEventListener('change', (e) => ui.preview?.setAnimate(e.target.checked));
$('#open-input').addEventListener('change', (e) => {
  const files = [...e.target.files];
  if (files.length) openFiles(files);
  e.target.value = '';
});
$('#reset').addEventListener('click', () => {
  if (!confirm('Start a new project? Unsaved skies, water and day cycle are lost.')) return;
  project = freshProject();
  changed({ controls: true, day: true });
});

setTab('sky');

import('./preview.js')
  .then(({ createPreview }) => createPreview($('#viewport')))
  .then((p) => { ui.preview = p; updatePreview(); })
  .catch((err) => {
    console.error(err);
    $('#viewport').insertAdjacentHTML('beforeend', '<p class="viewport-error">The 3D preview needs WebGL 2. Sliders and export still work.</p>');
  });
