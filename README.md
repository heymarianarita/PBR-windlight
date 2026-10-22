# Sky Maker (PBR WindLight)

Make Firestorm **sky, water and day cycle** presets that look right under PBR lighting. It sits next to the
Normal Map Maker and uses the same stack: plain HTML, CSS and ES modules, no build step.

Firestorm only imports the old WindLight XML format, so PBR-only settings can't go in the file. "PBR-ready"
means two steps: the tool picks legacy values that look right under PBR, then you type the suggested
**Reflection Probe Ambiance** into the sky editor after import.

## Status

| Phase | State |
| --- | --- |
| 1. Prove the import path | Test files ready in [`phase1/`](phase1/CHECKLIST.md). **Needs an in-world import.** |
| 2. Schema, XML writer, plain sliders | Done |
| 3. Sky preview | Done: ported sky, clouds and atmospheric lighting; island test scene; auto exposure and tone mapping |
| 4. Photo and HDRI analysis | Done: `.exr`, `.hdr`, JPEG, PNG, WebP. Tested on synthetic images only, so **needs 5 real ones** |
| 5. Water | Done: editor, preview, "match sky" |
| 6. Day cycle and zip export | Done: timeline, generate from one sky, blend preview, zip with README.txt. **Needs a Bulk Import test** |
| 7. Calibration | Not started: needs in-world screenshots |

## How it works

```
index.html
css/style.css   app styles on MDS v3 tokens: a header and two panels, light and dark
css/mds/        MDS v3 (Mariana's Design System) tokens: colours, type, spacing, effects, base
js/
  theme.js       Light / Dark / System theme switch
  params.js      every sky and water parameter, defined once
  legacy-xml.js  LLSD read/write and file names: the only module that knows the format
  main.js        project state, generated controls, tabs, timeline, open/save
  atmosphere.js  LGPL port of the viewer's sky, cloud and lighting shaders (kept separate)
  preview.js     three.js scene: sky dome, island, test spheres, water, tone mapping
  daycycle.js    keyframes, blending, "generate from one sky"
  analyze.js     starting values from a photo or HDRI
  hdr.js         Radiance .hdr decoder
  exr.js         OpenEXR decoder (three.js EXRLoader)
  fit.js         fits sky colours so the WindLight model matches an image
  export.js      downloads, zip bundle and README.txt
phase1/          hand-written import test files and checklist
```

A project is one look: a single fixed sky, or a day cycle where every key has its own sky, plus one water. Sky names come from the project name ("My Look", "My Look Sunset"). Slider values use the units the
Firestorm editor shows, and `params.js` converts them to what the file stores.

### Preview: what's a guess

The sky, cloud and haze maths come straight from the viewer's shaders. These parts are guesses for
Phase 7 to calibrate:

- `PROBE_SCALE` in `preview.js`: how much sky light one unit of Reflection Probe Ambiance adds
- the auto-exposure target. Only its 0.5–2 range comes from the viewer
- cloud UV mapping, noise and scroll speed. The viewer maps a tiling noise texture onto a dome mesh. This uses a flat layer and non-repeating noise computed in the shader, with the viewer's cloud formula on top
- water waves and refraction. The fresnel mix follows `waterF.glsl`, but the seabed is analytic and objects don't reflect in the water

## Encodings (from the viewer source)

From `translateLegacySettings` (`llsettingssky.cpp`, `llsettingswater.cpp`), `buildFromLegacyPreset`
(`llsettingsvo.cpp`) and the editor panels (`llpaneleditsky.cpp`). Phase 1 confirms them in-world.

| Field | Stored in file | Editor shows |
| --- | --- | --- |
| ambient, sunlight_color | 4-array, 0–3 | ÷3 |
| blue_density, blue_horizon | 4-array, 0–2 | ÷2 |
| density_multiplier | 4-array, slot 0 | ×1000 |
| haze, distance, max_y, gamma, cloud_scale, cloud_shadow | 4-array, slot 0 | as stored |
| glow | [x, _, z, _] | size = 2 − x/20, focus = z/−5 |
| star_brightness | plain real, 0–2 | ×250 |
| cloud_scroll_rate | 2-array | −10 |
| sun_angle, east_angle | plain real, radians | azimuth/elevation (east angle is negated) |
| Water values | plain reals; colour 4-array; normScale 3-array; waves 2-array | as stored |

Things that change the export layout:

- **The day cycle importer always loads `water/Default.xml`.** It ignores other water files, and the import
  fails if `water/` exists without `Default.xml`. The zip has to include it.
- Sky files are looked up as `name.xml`, then URL-escaped (`%20`), then with `-` as `%2D`.
  `legacyFileName()` matches `LLURI::escape`.
- After import the sky has `reflection_probe_ambiance` = 0. That turns off auto-adjust, so you get
  plain non-HDR lighting until you set it.

## Run locally

ES modules don't load from `file://`, so serve the folder:

```bash
python3 -m http.server 8766
```

Then open http://localhost:8766.

## Deploy to GitHub Pages

Go to **Settings → Pages → Source: Deploy from a branch**, then choose `main` and `/ (root)`. After a minute
or two the tool is live at `https://heymarianarita.github.io/pbr-windlight/`, and every push to `main` redeploys.

## Licence note

`js/atmosphere.js` is adapted from the Second Life Viewer (LGPL 2.1, Linden Research). It stays in its
own file with attribution. The rest of the tool doesn't copy viewer code.
