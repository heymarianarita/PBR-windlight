# Phase 1: prove the import path

These files were written by hand from the viewer's import code (`translateLegacySettings` in
`llsettingssky.cpp` / `llsettingswater.cpp`, `buildFromLegacyPreset` in `llsettingsvo.cpp`).
Each value is distinctive so you can tell which editor field it lands in.

```
phase1/
  skies/PBR%20Test%20Noon.xml
  skies/PBR%20Test%20Night.xml
  water/Default.xml              ← the day cycle importer always loads this name
  water/PBR%20Test%20Water.xml   ← same values, for the single-file Import button
  days/PBR%20Test%20Day.xml      ← Night at 0, Noon at 0.5
```

## How to test

1. **Sky:** Inventory → New Settings → New Sky, open it, click **Import**, pick `skies/PBR%20Test%20Noon.xml`.
2. **Water:** New Water → **Import** → `water/PBR%20Test%20Water.xml`.
3. **Day cycle:** New Day Cycle → **Import** → `days/PBR%20Test%20Day.xml`. Keep the folder layout:
   the importer looks for `../skies/` and `../water/Default.xml` next to `days/`.
4. **Bulk import:** zip the `phase1` folder contents (`skies/`, `water/`, `days/` at the top level) and
   use World → Environment → Bulk Import.

## What the editor should show (Noon sky)

The source says the editor divides some stored values before showing them. If a field
doesn't match, write down what it shows instead.

| Tab | Field | Stored in file | Editor should show | Actual |
| --- | --- | --- | --- | --- |
| Atmosphere | Ambient | 0.9, 0.75, 0.6 | ÷3 → 0.30, 0.25, 0.20 (77, 64, 51) | |
| Atmosphere | Blue horizon | 0.5, 0.6, 0.8 | ÷2 → 0.25, 0.30, 0.40 (64, 77, 102) | |
| Atmosphere | Blue density | 0.3, 0.6, 1.2 | ÷2 → 0.15, 0.30, 0.60 (38, 77, 153) | |
| Atmosphere | Haze horizon | 0.33 | 0.33 | |
| Atmosphere | Haze density | 1.25 | 1.25 | |
| Atmosphere | Density multiplier | 0.00025 | ×1000 → 0.25 | |
| Atmosphere | Distance multiplier | 3.5 | 3.5 | |
| Atmosphere | Maximum altitude | 1200 | 1200 | |
| Atmosphere | Scene gamma | 1.1 | 1.1 | |
| Atmosphere | **Reflection probe ambiance** | (not in file) | 0 expected | |
| Clouds | Cloud colour | 0.6, 0.55, 0.5 | 153, 140, 128 | |
| Clouds | Cloud coverage | cloud_shadow 0.35 | 0.35 | |
| Clouds | Cloud scale | 0.55 | 0.55 | |
| Clouds | Scroll X / Y | 10.5, 9.8 | −10 → 0.5, −0.2 | |
| Clouds | Density X / Y / D | 0.5, 0.3, 0.8 | 0.5, 0.3, 0.8 | |
| Clouds | Detail X / Y / D | 0.6, 0.4, 0.2 | 0.6, 0.4, 0.2 | |
| Sun & Moon | Sun colour | 2.4, 2.1, 1.8 | ÷3 → 0.8, 0.7, 0.6 (204, 179, 153) | |
| Sun & Moon | Glow size | glow[0] = 10 | 2 − 10/20 → 1.5 | |
| Sun & Moon | Glow focus | glow[2] = −1.5 | −1.5 / −5 → 0.3 | |
| Sun & Moon | Star brightness | 0.4 | ×250 → 100 | |
| Sun & Moon | Sun elevation | sun_angle 1.047 rad (60°) | 60° | |
| Sun & Moon | Sun azimuth | east_angle 0.785 rad (45°) | 45° or 315° (sign is flipped on import) | |

## What the editor should show (water)

| Field | Stored in file | Editor should show | Actual |
| --- | --- | --- | --- |
| Fog colour | 0.05, 0.2, 0.3 | 13, 51, 77 | |
| **Fog density** | 8 (plain number) | 8 if stored as-is | |
| Underwater fog modifier | 0.3 | 0.3 | |
| Fresnel scale / offset | 0.55 / 0.45 | 0.55 / 0.45 | |
| Wave 1 direction | 1.5, −0.5 | 1.5, −0.5 | |
| Wave 2 direction | 1.1, −1.2 | 1.1, −1.2 | |
| Normal scale | 2.5, 2, 1.5 | 2.5, 2, 1.5 | |
| Reflection scale above / below | 0.08 / 0.25 | 0.08 / 0.25 | |
| Blur multiplier | 0.06 | 0.06 | |

## Questions to answer

- [ ] All three files import with the Import button
- [ ] Bulk Import of the zipped folder creates both skies, the water and the day cycle
- [ ] Reflection probe ambiance after import (expected 0):
- [ ] Sun azimuth sign (45° or 315°):
- [ ] Water fog density shown as 8, or as something else (e.g. 3 = log₂ 8):
- [ ] Day cycle uses `water/Default.xml`, not the other water file
- [ ] Any value that doesn't match the table above:
