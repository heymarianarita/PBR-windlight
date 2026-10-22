// File downloads and the zip bundle. fflate is loaded only when a zip is made.

import { skyXml, waterXml, dayXml, legacyFileName } from './legacy-xml.js';
import { formatTime } from './daycycle.js';

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Folder layout the importer expects. The day cycle importer always loads
// water/Default.xml, so the water goes in twice: once under that name, once named.
export function bundleFiles(project) {
  const enc = (s) => new TextEncoder().encode(s);
  const files = {};
  for (const s of project.skies) files[`skies/${legacyFileName(s.name)}`] = enc(skyXml(s.values));
  files['water/Default.xml'] = enc(waterXml(project.water));
  files[`water/${legacyFileName(project.name)}`] = enc(waterXml(project.water));
  const keys = dayKeys(project);
  if (keys.length) files[`days/${legacyFileName(project.name)}`] = enc(dayXml(keys));
  files['README.txt'] = enc(readme(project));
  return files;
}

function dayKeys(project) {
  const byId = Object.fromEntries(project.skies.map((s) => [s.id, s]));
  return project.day.filter((k) => byId[k.sky]).map((k) => ({ time: k.time, name: byId[k.sky].name }));
}

export async function downloadZip(project) {
  const { zipSync } = await import('fflate');
  const blob = new Blob([zipSync(bundleFiles(project))], { type: 'application/zip' });
  downloadBlob(blob, `${project.name}.zip`);
}

export function readme(project) {
  const byId = Object.fromEntries(project.skies.map((s) => [s.id, s]));
  const keys = [...project.day].filter((k) => byId[k.sky]).sort((a, b) => a.time - b.time);
  const lines = [
    `${project.name} · made with Windlight Generator`,
    '',
    'IMPORT',
    '  Bulk: unzip, then World > Environment > Bulk Import and pick the files.',
    '  One at a time: in Inventory make a New Sky / New Water / New Day Cycle,',
    '  open it and click Import. Keep the skies/, water/ and days/ folders',
    '  together: a day cycle loads its skies from ../skies/ and its water',
    '  from ../water/Default.xml.',
    '',
    'AFTER IMPORT: SET REFLECTION PROBE AMBIANCE',
    '  The legacy format can\'t carry this PBR setting, so every imported sky',
    '  starts at 0. Open each sky (Atmosphere & Lighting tab), type the value',
    '  below, and save. 0 turns auto exposure off.',
    '',
  ];
  for (const s of project.skies) lines.push(`  ${s.name.padEnd(28)} ${s.values.probeAmbiance.toFixed(2)}`);
  if (keys.length) {
    lines.push('', '  In the day cycle, set it on each keyframe sky:');
    for (const k of keys) lines.push(`  ${formatTime(k.time)}  ${byId[k.sky].name.padEnd(22)} ${byId[k.sky].values.probeAmbiance.toFixed(2)}`);
  }
  lines.push(
    '',
    'NOT INCLUDED',
    '  Moisture, droplet radius, ice level, Rayleigh/Mie/absorption, sun and',
    '  moon textures, moon brightness and sun scale are PBR-only and keep',
    '  their defaults after import.',
    '',
  );
  return lines.join('\r\n');
}
