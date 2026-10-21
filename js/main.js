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
function freshProject() {
  const id = uid();
  return {
    version: PROJECT_VERSION,
    name: 'My Look',
    skies: [{ id, name: 'My Sky', values: defaults(SKY_PARAMS) }],
    active: id,
    water: defaults(WATER_PARAMS),
    day: [],
  };
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
    if (typeof raw.name === 'string') p.skies[0].name = cleanName(raw.name);
    return p;
  }
  if (Array.isArray(raw.skies) && raw.skies.length) {
    const seen = new Set();
    p.skies = raw.skies.slice(0, 32).map((s) => {
      let name = uniqueName(cleanName(s?.name), seen);
      seen.add(name);
      return { id: typeof s?.id === 'string' ? s.id : uid(), name, values: cleanValues(SKY_PARAMS, s?.values) };
    });
  }
  p.active = p.skies.some((s) => s.id === raw.active) ? raw.active : p.skies[0].id;
  p.water = cleanValues(WATER_PARAMS, raw.water);
  if (Array.isArray(raw.day)) {
    p.day = raw.day
      .filter((k) => k && Number.isFinite(k.time) && p.skies.some((s) => s.id === k.sky))
      .map((k) => ({ id: typeof k.id === 'string' ? k.id : uid(), time: clamp(k.time, 0, 0.9999), sky: k.sky }));
  }
  return p;
}

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

// ---------- Sky list ----------
function renderSkyList() {
  const sel = $('#sky-select');
  sel.replaceChildren(...project.skies.map((s) => new Option(s.name, s.id, false, s.id === project.active)));
  $('#sky-name').value = activeSky().name;
  $('#delete-sky').disabled = project.skies.length < 2;
}

function addSky(name, values) {
  const n = uniqueName(cleanName(name), new Set(project.skies.map((s) => s.name)));
  const sky = { id: uid(), name: n, values };
  project.skies.push(sky);
  project.active = sky.id;
  return sky;
}

// ---------- Day cycle ----------
function renderDay() {
  const list = $('#day-keys');
  const keys = [...project.day].sort((a, b) => a.time - b.time);
  list.replaceChildren(...keys.map((k) => {
    const row = document.createElement('li');
    row.className = 'day-key';
    row.innerHTML = `<input type="text" class="time" maxlength="5" aria-label="Time"><select aria-label="Sky"></select><button class="btn ghost icon" aria-label="Remove keyframe">×</button>`;
    const time = row.querySelector('.time');
    time.value = formatTime(k.time);
    time.addEventListener('change', () => {
      const t = parseTime(time.value);
      if (t === null) { time.value = formatTime(k.time); return toast('Use 24-hour time, like 06:30', true); }
      k.time = t;
      changed({ day: true });
    });
    const sel = row.querySelector('select');
    sel.replaceChildren(...project.skies.map((s) => new Option(s.name, s.id, false, s.id === k.sky)));
    sel.addEventListener('change', () => { k.sky = sel.value; changed({ day: true }); });
    row.querySelector('button').addEventListener('click', () => {
      project.day = project.day.filter((x) => x !== k);
      changed({ day: true });
    });
    return row;
  }));
  $('#day-empty').hidden = keys.length > 0;
  $('#day-warn').hidden = keys.length <= MAX_DAY_KEYS;
  renderTimeline();
}

function renderTimeline() {
  const track = $('#timeline-track');
  track.querySelectorAll('.marker').forEach((m) => m.remove());
  const names = Object.fromEntries(project.skies.map((s) => [s.id, s.name]));
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

// Drag snaps to 5 minutes; the scrub head follows so the preview shows the key.
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
      if (o.skies) renderSkyList();
      if (o.day || o.skies) renderDay();
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
  renderSkyList();
}

function updateToolbar() {
  const sky = activeSky();
  $('#file-name').textContent = ui.tab === 'water' ? `water/${legacyFileName(project.name)}` : `skies/${legacyFileName(sky.name)}`;
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
  $('#timeline').hidden = tab !== 'day';
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
    // A new sky named after the image: the current sky's other settings, plus what the image gave.
    const previous = project.active;
    let values = cleanValues(SKY_PARAMS, { ...structuredClone(activeSky().values), ...structuredClone(res.values), ...(res.sun ?? {}) });
    if (res.targets) {
      const { fitSkyColors } = await import('./fit.js');
      const fit = fitSkyColors(values, res.targets);
      values = cleanValues(SKY_PARAMS, fit.values);
      res.notes.splice(-1, 0, fit.error < 0.15
        ? 'Sky colours fitted so the rendered zenith and horizon match the image.'
        : 'Sky colours fitted as closely as the WindLight model allows; the image’s colours are partly out of its range.');
    }
    const sky = addSky(prettyName(file.name), values);
    photoUndo = { id: sky.id, previous };
    const notes = $('#photo-notes');
    notes.replaceChildren(...res.notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
    status.textContent = `${res.kind === 'hdri' ? 'HDRI' : 'Photo'}: made the sky “${sky.name}”. Tune it on the Sky tab.`;
    $('#photo-undo').hidden = false;
    changed({ controls: true, skies: true, day: true });
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

async function openFile(file) {
  const text = await file.text();
  try {
    if (/^\s*[{[]/.test(text)) {
      project = sanitize(JSON.parse(text));
      toast('Project loaded');
    } else {
      const data = parseXml(text);
      const name = decodeName(file.name);
      if (Array.isArray(data)) {
        // Legacy day cycle: [[time, sky name], …]; skies must already be in the project.
        const byName = Object.fromEntries(project.skies.map((s) => [s.name, s.id]));
        const missing = data.filter((k) => !byName[k[1]]).map((k) => k[1]);
        project.day = data.filter((k) => byName[k[1]]).map((k) => ({ id: uid(), time: clamp(Number(k[0]) || 0, 0, 0.9999), sky: byName[k[1]] }));
        toast(missing.length ? `Day cycle loaded. Open these skies first: ${missing.join(', ')}` : 'Day cycle loaded', missing.length > 0);
      } else if (data && 'waterFogColor' in data) {
        project.water = cleanValues(WATER_PARAMS, waterFromLegacy(data, project.water));
        toast('Legacy water loaded');
      } else if (data && ('sun_angle' in data || 'ambient' in data)) {
        // Ambiance isn't in legacy files: keep the current one.
        const values = cleanValues(SKY_PARAMS, skyFromLegacy(data, activeSky().values));
        addSky(name, values);
        toast(`Legacy sky “${activeSky().name}” added`);
      } else {
        throw new Error('not a sky, water or day cycle file');
      }
    }
    changed({ controls: true, skies: true, day: true });
  } catch (err) {
    toast(`Couldn’t open ${file.name}: ${err.message}`, true);
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
  $('#files').showModal();
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

$('#project-name').addEventListener('input', (e) => { project.name = cleanName(e.target.value, 'My Look'); changed(); });
$('#project-name').addEventListener('change', (e) => { e.target.value = project.name; });
$('#sky-select').addEventListener('change', (e) => { project.active = e.target.value; changed({ controls: true }); });
$('#sky-name').addEventListener('change', (e) => {
  const sky = activeSky();
  const others = new Set(project.skies.filter((s) => s !== sky).map((s) => s.name));
  sky.name = uniqueName(cleanName(e.target.value), others);
  changed({ skies: true });
});
$('#add-sky').addEventListener('click', () => { addSky('New Sky', defaults(SKY_PARAMS)); changed({ controls: true, skies: true }); });
$('#duplicate-sky').addEventListener('click', () => {
  addSky(`${activeSky().name} copy`, structuredClone(activeSky().values));
  changed({ controls: true, skies: true });
});
$('#delete-sky').addEventListener('click', () => {
  const sky = activeSky();
  if (project.skies.length < 2 || !confirm(`Delete “${sky.name}”? Day cycle keys that use it are removed too.`)) return;
  project.skies = project.skies.filter((s) => s !== sky);
  project.day = project.day.filter((k) => k.sky !== sky.id);
  project.active = project.skies[0].id;
  changed({ controls: true, skies: true, day: true });
});

$('#match-sky').addEventListener('click', matchSky);

$('#generate-day').addEventListener('click', () => {
  if (project.day.length && !confirm('Replace the current day cycle with Night, Sunrise, Noon and Sunset versions of this sky?')) return;
  const base = activeSky();
  const baseName = base.name;
  project.day = generateVariants(base.values).map((v) => {
    const sky = addSky(`${baseName} ${v.name}`, v.values);
    return { id: uid(), time: v.time, sky: sky.id };
  });
  project.active = base.id;
  changed({ controls: true, skies: true, day: true });
  toast('Added 4 skies and keyed them at 00:00, 06:00, 12:00 and 18:00');
});
$('#add-key').addEventListener('click', () => {
  project.day.push({ id: uid(), time: Math.round(ui.dayTime * 288) / 288 % 1, sky: activeSky().id });
  changed({ day: true });
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
  dz.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) analyzeFile(f);
});
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#photo-input').click(); } });
dz.addEventListener('click', () => $('#photo-input').click());
$('#photo-undo').addEventListener('click', () => {
  if (!photoUndo || project.skies.length < 2) return;
  project.skies = project.skies.filter((s) => s.id !== photoUndo.id);
  project.day = project.day.filter((k) => k.sky !== photoUndo.id);
  project.active = project.skies.some((s) => s.id === photoUndo.previous) ? photoUndo.previous : project.skies[0].id;
  photoUndo = null;
  $('#photo-undo').hidden = true;
  $('#photo-status').textContent = 'Removed the sky made from the image.';
  changed({ controls: true, skies: true, day: true });
});

$('#download-sky').addEventListener('click', downloadSky);
$('#download-all').addEventListener('click', downloadAll);
$('#save-json').addEventListener('click', saveJson);
$('#view-files').addEventListener('click', showFiles);
$('#face-sun').addEventListener('click', () => ui.preview?.faceLight());
$('#look-up').addEventListener('click', () => ui.preview?.lookUp());
$('#animate').addEventListener('change', (e) => ui.preview?.setAnimate(e.target.checked));
$('#open-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) openFile(f);
  e.target.value = '';
});
$('#reset').addEventListener('click', () => {
  if (!confirm('Start a new project? Unsaved skies, water and day cycle are lost.')) return;
  project = freshProject();
  changed({ controls: true, skies: true, day: true });
});

setTab('sky');

import('./preview.js')
  .then(({ createPreview }) => createPreview($('#viewport')))
  .then((p) => { ui.preview = p; updatePreview(); })
  .catch((err) => {
    console.error(err);
    $('#viewport').insertAdjacentHTML('beforeend', '<p class="viewport-error">The 3D preview needs WebGL 2. Sliders and export still work.</p>');
  });
