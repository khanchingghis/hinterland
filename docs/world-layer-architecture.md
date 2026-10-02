# World distance layer and “Show roads used”

## Decision (2026)

Use **one distance field** and **one road geometry tier** at regional/city zoom. Do not composite lazy-loaded regional field PNGs or a finer GRIP detail overlay on top of the planetary grid in the browser—**except** the dedicated **UK pack** described below.

| Zoom | Distance shading | Road overlay (toggle) |
|------|------------------|------------------------|
| 0–6 | Pre-rendered raster tiles (`public/tiles*`) from `world-field.png` | Global overview NDJSON (highway ≤3, major ≤6) |
| >6 (outside UK) | Canvas samples `world-field.png` directly (0.05° cells, ~5 km) | Per-region `grip-region-*.ndjson.gz` (same simplify as the field build) |
| >6 (UK, when active) | Canvas composites `public/uk-pack/uk-field.png` (~0.01°) inside the pack bbox | `public/uk-pack/uk-roads.ndjson.gz` (same file burned into the field) |

Local OpenStreetMap studies replace both when active.

## UK high-detail pack

**Goal:** In Great Britain, Northern Ireland, and nearby seas, show a denser GRIP network with distance shading that matches the “Roads used” overlay—no roads through “far” cells from mismatched geometry tiers.

| Piece | Location | Notes |
|-------|----------|--------|
| Bounds (data) | `UK_PACK_BOUNDS` in `src/lib/uk-pack.ts` | Padded bbox (~48–62°N, 13°W–5°E) so coast and Channel approaches are not clipped mid-segment |
| Activation | `UK_ACTIVATION_BOUNDS` + `UK_PACK_MIN_ZOOM` (7) | Lazy-load when the viewport overlaps activation and ≥12% of the view lies inside activation (avoids switching on a sliver of Scotland at Paris zoom) |
| Roads | `uk-roads.ndjson.gz` | GRIP4 types 1–4; built from `GRIP4_region4` GDB at 0.012° simplify when available, else clipped from `grip-region-4.ndjson.gz` (0.05° source simplify) |
| Field | `uk-field.png` | Euclidean distance transform on the **same** `uk-roads.ndjson.gz`, 0.01° cells, regional lon/lat masks (see `buildBoxDistanceFieldPng` in `scripts/field-detail.ts`) |
| Build | `npm run uk-pack` | Requires Natural Earth land/ice in `data/raw/`; optional GDB for finer chords |

Outside the UK activation zone, behavior is unchanged from the global stack.

## Root causes addressed

### 1. Map turns uniformly dark / blank when zooming in

Above `tileMaxZoom` (6), tiles hide and a canvas paints the distance field. PRs #7–#9 also loaded **regional field-detail PNGs** at zoom ≥8 and preferred them over the global field.

Those PNGs were built with a bug in `scripts/field-detail.ts`: land/ice masks used **planetary** lon/lat → pixel mapping inside **regional** buffers. Most land cells were empty or assigned the farthest band, so the overlay read as ink/teal or transparent holes once tiles were off.

**Fix:** Runtime no longer loads `world-field-detail` for the global layer. High zoom outside the UK always samples the same `world-field.png` as tiles and hover text. The build script mapping bug is fixed for optional regional/UK fields.

### 2. Roads through cells classified >5 km

The distance field (global and the broken detail PNGs) is computed from **regional** GRIP exports (`grip-region-*.ndjson.gz`, ~0.05° simplify). The road overlay at zoom ≥9 switched to **`grip-region-4-detail`** (finer geometry) plus coarse secondary/tertiary supplements—geometry that was **not** burned into the distance grid.

**Fix:** Remove the detail road tier from the global stack. Overlay lines always come from the same regional files used in `npm run world`. The UK pack is the exception: one road file and one field, shipped together.

### 3. Roads missing or too straight

Missing: overview tiers stop at zoom 6; detail existed only for region 4. Too straight: coarse simplify is intentional for bundle size; showing finer chords without a matching field was misleading.

**Fix:** Regional lines at zoom >6 globally; UK pack adds a matching finer field + roads for the British Isles only.

## What we kept

- Guide UI, Classify this view (Overpass), GitHub Pages `basePath`, abort guards on road loads, roads-toggle loading spinner.
- Hiding Positron OSM road layers when the GRIP overlay is shown at high zoom (avoids implying OSM drives world distance).

## Future work (optional)

- Re-enable other regional 0.025° fields **only** after rebuild with fixed masks and **the same** road file used for overlay.
- Or raise `tileMaxZoom` and skip canvas until tile weight is acceptable.
- Rebuild UK roads from GDB in CI when Zenodo FGDBs are available (finer than clipping committed 0.05° regional gzip).
