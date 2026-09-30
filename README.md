# Hinterland

A map that classifies land by how far it sits from the nearest road.

The world layer is a 0.05° grid, about 5 km at the equator. Warm colors are close to a mapped road. Deep teal and ink are far. Ocean is left clear. Zoom in and **Classify this view** to measure a place against live OpenStreetMap roads, down to city blocks.

## Run

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

The world tiles are already built. You do not need an API key.

## What a study does

**Classify this view** asks the Overpass API (overpass.kumi.systems, which allows browser requests) for the highway classes you checked. The browser burns those lines into a grid and runs a Euclidean distance transform. Cell size defaults to 70 m and will coarsen if the frame would exceed 480 cells on a side.

Street-level classes are limited to a 32 km frame. Major roads can cover about 340 km. That keeps the request small enough for Overpass to answer.

## Method

Distance means straight-line distance to the nearest road centerline, in meters. It is the same quantity as GRASS `r.grow.distance` (Euclidean) and GDAL’s proximity raster.

1. Burn road lines into a grid.
2. Run a separable Euclidean distance transform ([Felzenszwalb & Huttenlocher 2012](https://cs.brown.edu/people/pfelzens/papers/dt-final.pdf)), with empty columns kept at infinity so the squared distances do not overflow.
3. Classify each cell into distance bands.

The world grid is computed in overlapping latitude bands. Inside a band, cell width uses the meters in a degree of longitude at that latitude, so the poles are not stretched. The antimeridian is padded so roads in Alaska and Chukotka can be each other’s nearest road. Ferry routes are not in GRIP and are not burned.

Zoomed-out pixels use the median class of the cells they cover, so a thin road corridor does not disappear. From zoom level 4 upward, a pixel is the cell under its center.

A local study uses the same transform on a projected meter grid for that frame. Within a few hundred kilometers the earth is flat enough for this.

## Libraries and data

| Piece | Role |
| --- | --- |
| [MapLibre GL JS](https://maplibre.org/) | Map, image overlay, and interaction |
| [OpenFreeMap](https://openfreemap.org/) Positron | Basemap. OpenStreetMap data, no API key |
| [GRIP4](https://www.globio.info/download-grip-dataset) | World roads (types 1–4: highway through tertiary). CC0 |
| [Natural Earth](https://www.naturalearthdata.com/) 1:10m | Land and ice masks. Public domain |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | Live OpenStreetMap roads for a study |
| Distance transform in `src/lib/geo/edt.ts` | The measurement |

The world distance field uses **GRIP4** road types 1–4 (highway, primary, secondary, tertiary). GRIP type 5 (local/urban) is omitted so the static overlay stays within a practical size for GitHub Pages (~150 MB gzip across seven regional files, loaded by viewport). That is denser and more globally even than Natural Earth 1:10m, but still coarser than a full OpenStreetMap burn.

The in-map list titled **Decisions still open** is the set of product questions this prototype is meant to pin down: what counts as a road, straight-line distance versus travel time, how to treat water and ice, whether the subject is the planet or the place in front of you, and whether classes or a continuous ramp should lead.

Sample cells update when you rebuild the world layer; after the GRIP switch, expect more land in nearer bands outside Europe and North America.

## Rebuild the world layer

Raw inputs are not committed. You need **GDAL** (`ogr2ogr`) on your PATH.

### Natural Earth (land and ice)

Place in `data/raw/`:

- `ne_10m_land.geojson`
- `ne_10m_glaciated_areas.geojson`

From [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector/tree/master/geojson).

### GRIP4 (roads)

Download the seven regional **FileGDB** archives from [Zenodo](https://zenodo.org/records/6420961) (or [globio.info](https://www.globio.info/download-grip-dataset)). Unzip each into `data/raw/grip/` so you have:

- `data/raw/grip/GRIP4_region1.gdb` … `GRIP4_region7.gdb`

### Build

```bash
npm run world
```

That rewrites `public/tiles`, `public/tiles-no-ice`, `public/world-field.png`, `public/world-meta.json`, and `public/world-roads/` (seven regional gzip GeoJSON sequences at 0.05° simplify, optional per-region `*-detail.ndjson.gz` with full-resolution highway/primary for zoom ≥ 11, two global overview files for low zoom, plus `manifest.json` for the **Show roads used** overlay). The distance field rasterizes at 0.012° simplify. Without GRIP GDBs, `npm run world` reuses the committed gzip files.

To rebuild one high-zoom overlay region: `npx tsx scripts/build-grip-detail-region.ts 4` (Europe).

## GitHub Pages

The site is a static export (`output: "export"` in `next.config.ts`). `.github/workflows/pages.yml` builds `out/` and deploys it with GitHub Pages.

A project site is served at `https://<user>.github.io/<repo>/`. The workflow sets `NEXT_PUBLIC_BASE_PATH` to `/<repo>` so tiles, the map worker, and Next’s assets resolve. A repository named `<user>.github.io` is served from the domain root, so the base path stays empty.

```bash
npm run build
```

The exported files land in `out/`. Open them through a static server, because the map loads tiles and workers by URL.
