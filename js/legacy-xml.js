// Legacy WindLight XML (LLSD) reading and writing. Everything about the file format
// lives here, so if Firestorm changes its importer it's a fix in one module.

import { SKY_PARAMS, SKY_XML, WATER_PARAMS, WATER_XML, DEFAULT_WATER_NORMAL, toStored, fromStored } from './params.js';

// ---------- Values → LLSD ----------

// Build the legacy map { key: number | number[] } from shown values.
function toLegacy(params, layout, values) {
  const out = {};
  for (const [key, shape] of Object.entries(layout)) {
    if (shape.len) out[key] = [...shape.fill];
  }
  for (const p of params) {
    if (!p.xml) continue;
    const v = values[p.id];
    if (p.type === 'color') {
      for (let i = 0; i < 3; i++) out[p.xml][i] = toStored(p, v[i]);
    } else if (layout[p.xml].len) {
      out[p.xml][p.index] = toStored(p, v);
    } else {
      out[p.xml] = toStored(p, v);
    }
  }
  return out;
}

export function skyToLegacy(values) {
  const out = toLegacy(SKY_PARAMS, SKY_XML, values);
  // Without this the importer keeps the scroll it read; with it, false zeroes an axis.
  out.enable_cloud_scroll = [true, true];
  return out;
}

export function waterToLegacy(values) {
  const out = toLegacy(WATER_PARAMS, WATER_XML, values);
  out.normalMap = { uuid: DEFAULT_WATER_NORMAL };
  return out;
}

// ---------- LLSD → values ----------

function fromLegacy(params, data, base) {
  const values = structuredClone(base);
  for (const p of params) {
    if (!p.xml || !(p.xml in data)) continue;
    const s = data[p.xml];
    if (p.type === 'color') values[p.id] = [0, 1, 2].map((i) => fromStored(p, Number(s[i]) || 0));
    else if (Array.isArray(s)) values[p.id] = fromStored(p, Number(s[p.index ?? 0]) || 0);
    else values[p.id] = fromStored(p, Number(s) || 0);
  }
  return values;
}

export const skyFromLegacy = (data, base) => fromLegacy(SKY_PARAMS, data, base);
export const waterFromLegacy = (data, base) => fromLegacy(WATER_PARAMS, data, base);

// ---------- LLSD XML serialisation ----------

// Seven decimals covers density_multiplier (≈0.0001) without exponent notation.
function real(n) {
  if (!Number.isFinite(n)) n = 0;
  const s = n.toFixed(7).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function node(v, indent) {
  const pad = '  '.repeat(indent);
  if (typeof v === 'number') return `<real>${real(v)}</real>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (v && v.uuid) return `<uuid>${v.uuid}</uuid>`;
  if (Array.isArray(v)) {
    // Short arrays of scalars stay on one line, like the viewer's own presets.
    if (v.every((x) => typeof x !== 'object')) return `<array>${v.map((x) => node(x, 0)).join('')}</array>`;
    return `<array>\n${v.map((x) => `${pad}  ${node(x, indent + 1)}`).join('\n')}\n${pad}</array>`;
  }
  const keys = Object.keys(v).sort();
  return `<map>\n${keys.map((k) => `${pad}  <key>${esc(k)}</key>${node(v[k], indent + 1)}`).join('\n')}\n${pad}</map>`;
}

export function toXml(llsd) {
  return `<?xml version="1.0" ?>\n<llsd>\n${node(llsd, 0)}\n</llsd>\n`;
}

export const skyXml = (values) => toXml(skyToLegacy(values));
export const waterXml = (values) => toXml(waterToLegacy(values));

// Day cycle: [[time 0–1, sky name], …], sorted by time. Names must match files in skies/.
export function dayXml(keys) {
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  return toXml(sorted.map((k) => [k.time, k.name]));
}

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not valid XML');
  const root = doc.documentElement;
  if (root.nodeName !== 'llsd') throw new Error('Not an LLSD file');
  const first = [...root.children][0];
  return first ? parseNode(first) : null;
}

function parseNode(el) {
  const t = el.textContent.trim();
  switch (el.nodeName) {
    case 'real': case 'integer': return Number(t);
    case 'boolean': return t === '1' || t === 'true';
    case 'string': return t;
    case 'uuid': return { uuid: t };
    case 'undef': return null;
    case 'array': return [...el.children].map(parseNode);
    case 'map': {
      const out = {};
      const kids = [...el.children];
      for (let i = 0; i + 1 < kids.length; i += 2) out[kids[i].textContent] = parseNode(kids[i + 1]);
      return out;
    }
    default: return t;
  }
}

// ---------- File names ----------

// Same as LLURI::escape: keep A–Z a–z 0–9 - . _ ~, percent-encode the rest as UTF-8.
// The viewer unescapes the file name to get the setting name.
export function legacyFileName(name) {
  const bytes = new TextEncoder().encode(name);
  let out = '';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return `${out}.xml`;
}

// Setting names end up in file paths: drop path separators and control characters.
export function cleanName(name, fallback = 'My Sky') {
  const s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 63);
  return s || fallback;
}
