# World distance layer and “Show roads used”

## Decision (2026)

Use **one distance field** and **one road geometry tier** at regional/city zoom. Do not composite lazy-loaded regional field PNGs or a finer GRIP detail overlay on top of the planetary grid in the browser.

| Zoom | Distance shading | Road overlay (toggle) |
|------|------------------|------------------------|
| 0–6 | Pre-rendered raster tiles (`public/tiles*`) from `world-field.png` | Global overview NDJSON (highway ≤3, major ≤6) |
| >6 | Canvas samples `world-field.png` directly (0.05° cells, ~5 km) | Per-region `grip-region-*.ndjson.gz` (same simplify as the field build) |

Local OpenStreetMap studies replace both when active.

## Root causes addressed

### 1. Map turns uniformly dark / blank when zooming in

Above `tileMaxZoom` (6), tiles hide and a canvas paints the distance field. PRs #7–#9 also loaded **regional field-detail PNGs** at zoom ≥8 and preferred them over the global field.

Those PNGs were built with a bug in `scripts/field-detail.ts`: land/ice masks used **planetary** lon/lat → pixel mapping inside **regional** buffers. Most land cells were empty or assigned the farthest band, so the overlay read as ink/teal or transparent holes once tiles were off.

**Fix:** Runtime no longer loads `world-field-detail`. High zoom always samples the same `world-field.png` as tiles and hover text. The build script mapping bug is fixed for a future optional finer field.

### 2. Roads through cells classified >5 km

The distance field (global and the broken detail PNGs) is computed from **regional** GRIP exports (`grip-region-*.ndjson.gz`, ~0.05° simplify). The road overlay at zoom ≥9 switched to **`grip-region-4-detail`** (finer geometry) plus coarse secondary/tertiary supplements—geometry that was **not** burned into the distance grid.

**Fix:** Remove the detail road tier. Overlay lines always come from the same regional files used in `npm run world`.

### 3. Roads missing or too straight

Missing: overview tiers stop at zoom 6; detail existed only for region 4. Too straight: coarse simplify is intentional for bundle size; showing finer chords without a matching field was misleading.

**Fix:** Regional lines at zoom >6; accept simplified geometry until a matching finer field is rebuilt and shipped together with its roads.

## What we kept

- Guide UI, Classify this view (Overpass), GitHub Pages `basePath`, abort guards on road loads, roads-toggle loading spinner.
- Hiding Positron OSM road layers when the GRIP overlay is shown at high zoom (avoids implying OSM drives world distance).

## Future work (optional)

- Re-enable regional 0.025° fields **only** after rebuild with fixed masks and **the same** road file used for overlay.
- Or raise `tileMaxZoom` and skip canvas until tile weight is acceptable.
