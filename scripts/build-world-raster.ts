/**
 * Build the planetary distance layer.
 *
 * Roads come from GRIP4 (types 1–4: highway through tertiary). Land and ice
 * use Natural Earth 1:10m (public domain). Each land cell of a 0.05° grid
 * stores straight-line distance to the nearest road, computed with a
 * Euclidean distance transform in overlapping latitude bands so a degree of
 * longitude shrinks toward the poles. Ocean is left unpainted.
 *
 * Run: npm run world
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { WORLD_ROADS_DIR } from "./grip-export";
import path from "node:path";
import os from "node:os";
import {
  assertGripRegionsPresent,
  buildGripOverlayAssets,
  buildGripOverviewAssets,
  exportGripRegionSeq,
  rasterizeGripGzFile,
  rasterizeGripSeqFile,
} from "./grip-export";
import { GRIP_SOURCE, GRIP_REGIONS } from "../src/lib/grip-inventory";
import { PNG } from "pngjs";
import { WORLD_BANDS, bandAlpha, bandIndex } from "../src/lib/bands";
import { assertDistanceTransform, distanceToFeatures } from "../src/lib/geo/edt";
import { assertLocal } from "../src/lib/geo/local";
import { assertMeasure, metersPerDegLat, metersPerDegLon, splitDateLine } from "../src/lib/geo/measure";
import type { SampleReading, WorldMeta } from "../src/lib/world-types";

const RES = 0.05;
const COLS = Math.round(360 / RES);
const ROWS = Math.round(180 / RES);
const TILE = 256;
const MAX_Z = 5;
const KM_STEP = 5;

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data/raw");
const TILE_DIR = path.join(ROOT, "public/tiles");
const TILE_DIR_NO_ICE = path.join(ROOT, "public/tiles-no-ice");

const EXCLUDED = ["GRIP local/urban (type 5)", "Ferry routes (not in GRIP)"];

const SAMPLES: Omit<SampleReading, "land" | "ice" | "km" | "bandId">[] = [
  { id: "london", name: "London", region: "Western Europe", lon: -0.1276, lat: 51.5072, zoom: 5 },
  { id: "manhattan", name: "Manhattan", region: "New York", lon: -73.985, lat: 40.758, zoom: 5 },
  { id: "tanezrouft", name: "Tanezrouft", region: "Sahara", lon: 0.4, lat: 22.2, zoom: 4.6 },
  { id: "amazon", name: "Western Amazon", region: "Brazil", lon: -66.5, lat: -4.2, zoom: 4.8 },
  { id: "simpson", name: "Simpson Desert", region: "Australia", lon: 137.2, lat: -24.8, zoom: 4.8 },
  { id: "greenland", name: "Central Greenland", region: "Ice sheet", lon: -40, lat: 75, zoom: 3.6 },
  { id: "siberia", name: "Central Siberia", region: "Russia", lon: 104, lat: 66, zoom: 4 },
  { id: "changtang", name: "Changtang", region: "Tibetan plateau", lon: 86.5, lat: 33.5, zoom: 4.4 },
];

type Geometry = {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
};

type Feature = {
  properties: Record<string, unknown>;
  geometry: Geometry | null;
};

function loadFeatures(file: string): Feature[] {
  const json = JSON.parse(readFileSync(path.join(RAW, file), "utf8")) as {
    features: Feature[];
  };
  return json.features;
}

function lonToX(lon: number): number {
  return ((lon + 180) / 360) * COLS;
}

function latToY(lat: number): number {
  return ((90 - lat) / 180) * ROWS;
}

function rasterizePolygons(features: Feature[], mask: Uint8Array, exteriorOnly: boolean): void {
  type Edge = { y0: number; y1: number; x0: number; x1: number };
  const edges: Edge[] = [];

  const pushRing = (ring: number[][]) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const a: [number, number] = [ring[i][0], ring[i][1]];
      const b: [number, number] = [ring[i + 1][0], ring[i + 1][1]];
      for (const [start, end] of splitDateLine(a, b)) {
        let y0 = latToY(start[1]);
        let x0 = lonToX(start[0]);
        let y1 = latToY(end[1]);
        let x1 = lonToX(end[0]);
        if (y0 === y1) continue;
        if (y0 > y1) {
          [y0, y1] = [y1, y0];
          [x0, x1] = [x1, x0];
        }
        edges.push({ y0, y1, x0, x1 });
      }
    }
  };

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon") {
      const rings = geometry.coordinates as number[][][];
      const usable = exteriorOnly ? rings.slice(0, 1) : rings;
      for (const ring of usable) pushRing(ring);
    } else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates as number[][][][]) {
        const usable = exteriorOnly ? polygon.slice(0, 1) : polygon;
        for (const ring of usable) pushRing(ring);
      }
    }
  }

  edges.sort((a, b) => a.y0 - b.y0);
  const active: Edge[] = [];
  let cursor = 0;
  const xs: number[] = [];

  for (let y = 0; y < ROWS; y++) {
    const scan = y + 0.5;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].y1 <= scan) active.splice(i, 1);
    }
    while (cursor < edges.length && edges[cursor].y0 < scan) {
      if (edges[cursor].y1 > scan) active.push(edges[cursor]);
      cursor += 1;
    }
    if (active.length < 2) continue;
    xs.length = 0;
    for (const edge of active) {
      const t = (scan - edge.y0) / (edge.y1 - edge.y0);
      xs.push(edge.x0 + t * (edge.x1 - edge.x0));
    }
    xs.sort((a, b) => a - b);
    const row = y * COLS;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let c0 = Math.ceil(xs[i] - 0.5);
      let c1 = Math.floor(xs[i + 1] - 0.5);
      if (c0 < 0) c0 = 0;
      if (c1 >= COLS) c1 = COLS - 1;
      for (let c = c0; c <= c1; c++) mask[row + c] = 1;
    }
  }
}

function computeDistances(seeds: Uint8Array): Float32Array {
  const out = new Float32Array(COLS * ROWS);
  out.fill(Number.POSITIVE_INFINITY);
  const stripDeg = 15;
  const padDeg = 36;
  const padRows = Math.ceil(padDeg / RES);
  const padCols = Math.ceil(padDeg / RES);

  for (let lat0 = -90; lat0 < 90; lat0 += stripDeg) {
    const lat1 = Math.min(90, lat0 + stripDeg);
    const coreR0 = Math.max(0, Math.min(ROWS, Math.round((90 - lat1) / RES)));
    const coreR1 = Math.max(coreR0, Math.min(ROWS, Math.round((90 - lat0) / RES)));
    const r0 = Math.max(0, coreR0 - padRows);
    const r1 = Math.min(ROWS, coreR1 + padRows);
    const height = r1 - r0;
    const width = COLS + padCols * 2;
    const sub = new Uint8Array(width * height);

    for (let r = 0; r < height; r++) {
      const src = (r0 + r) * COLS;
      const dest = r * width;
      for (let c = 0; c < padCols; c++) sub[dest + c] = seeds[src + (COLS - padCols + c)];
      sub.set(seeds.subarray(src, src + COLS), dest + padCols);
      for (let c = 0; c < padCols; c++) sub[dest + padCols + COLS + c] = seeds[src + c];
    }

    const midLat = Math.max(-84, Math.min(84, (lat0 + lat1) / 2));
    const sy = metersPerDegLat(midLat) * RES;
    const sx = Math.max(50, metersPerDegLon(midLat) * RES);
    const dist = distanceToFeatures(sub, width, height, sx, sy);

    for (let r = coreR0; r < coreR1; r++) {
      const srcRow = (r - r0) * width + padCols;
      const destRow = r * COLS;
      for (let c = 0; c < COLS; c++) {
        const value = dist[srcRow + c];
        if (value < out[destRow + c]) out[destRow + c] = value;
      }
    }
    console.log(`  band ${lat0}° to ${lat1}°`);
  }

  return out;
}

function cellAt(lon: number, lat: number): number {
  let x = Math.floor(lonToX(lon));
  let y = Math.floor(latToY(lat));
  if (x < 0) x = 0;
  if (x >= COLS) x = COLS - 1;
  if (y < 0) y = 0;
  if (y >= ROWS) y = ROWS - 1;
  return y * COLS + x;
}

function areas(land: Uint8Array, ice: Uint8Array, dist: Float32Array, hideIce: boolean) {
  const km2 = new Array<number>(WORLD_BANDS.length).fill(0);
  let landKm2 = 0;
  let iceKm2 = 0;
  for (let r = 0; r < ROWS; r++) {
    const lat = 90 - (r + 0.5) * RES;
    const cell = (metersPerDegLat(lat) * RES * metersPerDegLon(lat) * RES) / 1e6;
    const row = r * COLS;
    for (let c = 0; c < COLS; c++) {
      const i = row + c;
      if (!land[i]) continue;
      if (ice[i]) iceKm2 += cell;
      if (hideIce && ice[i]) continue;
      landKm2 += cell;
      const meters = Number.isFinite(dist[i]) ? dist[i] : Number.POSITIVE_INFINITY;
      km2[bandIndex(meters, WORLD_BANDS)] += cell;
    }
  }
  const shares = WORLD_BANDS.map((band, index) => ({
    id: band.id,
    km2: Math.round(km2[index]),
    share: landKm2 > 0 ? km2[index] / landKm2 : 0,
  }));
  return { shares, landKm2, iceKm2 };
}

function mercLat(z: number, y: number, py: number): number {
  const scale = TILE * 2 ** z;
  const worldY = y * TILE + py;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * worldY) / scale)));
  return (lat * 180) / Math.PI;
}

function medianBand(
  lng0: number,
  lng1: number,
  south: number,
  north: number,
  land: Uint8Array,
  ice: Uint8Array,
  dist: Float32Array,
  hideIce: boolean,
): number | null {
  let c0 = Math.floor(lonToX(lng0));
  let c1 = Math.ceil(lonToX(lng1));
  let r0 = Math.floor(latToY(north));
  let r1 = Math.ceil(latToY(south));
  if (c0 < 0) c0 = 0;
  if (c1 > COLS) c1 = COLS;
  if (r0 < 0) r0 = 0;
  if (r1 > ROWS) r1 = ROWS;
  if (c1 <= c0 || r1 <= r0) return null;

  const hist = new Array<number>(WORLD_BANDS.length).fill(0);
  let count = 0;
  for (let r = r0; r < r1; r++) {
    const row = r * COLS;
    for (let c = c0; c < c1; c++) {
      const i = row + c;
      if (!land[i]) continue;
      if (hideIce && ice[i]) continue;
      const meters = Number.isFinite(dist[i]) ? dist[i] : Number.POSITIVE_INFINITY;
      hist[bandIndex(meters, WORLD_BANDS)] += 1;
      count += 1;
    }
  }
  if (count === 0) return null;
  let seen = 0;
  const target = count / 2;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= target) return i;
  }
  return hist.length - 1;
}

function centerBand(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
  land: Uint8Array,
  ice: Uint8Array,
  dist: Float32Array,
  hideIce: boolean,
): number | null {
  const n = 2 ** z;
  const lng = ((x + (px + 0.5) / TILE) / n) * 360 - 180;
  const lat = mercLat(z, y, py + 0.5);
  if (lat > 89 || lat < -89) return null;
  const i = cellAt(lng, lat);
  if (!land[i]) return null;
  if (hideIce && ice[i]) return null;
  const meters = Number.isFinite(dist[i]) ? dist[i] : Number.POSITIVE_INFINITY;
  return bandIndex(meters, WORLD_BANDS);
}

function tileMayHaveLand(
  z: number,
  x: number,
  y: number,
  land: Uint8Array,
  ice: Uint8Array,
  hideIce: boolean,
): boolean {
  const n = 2 ** z;
  const lng0 = (x / n) * 360 - 180;
  const lng1 = ((x + 1) / n) * 360 - 180;
  const north = mercLat(z, y, 0);
  const south = mercLat(z, y, TILE);
  let c0 = Math.floor(lonToX(lng0));
  let c1 = Math.ceil(lonToX(lng1));
  let r0 = Math.floor(latToY(Math.max(north, south)));
  let r1 = Math.ceil(latToY(Math.min(north, south)));
  if (c0 < 0) c0 = 0;
  if (c1 > COLS) c1 = COLS;
  if (r0 < 0) r0 = 0;
  if (r1 > ROWS) r1 = ROWS;
  for (let r = r0; r < r1; r++) {
    const row = r * COLS;
    for (let c = c0; c < c1; c++) {
      const i = row + c;
      if (!land[i]) continue;
      if (hideIce && ice[i]) continue;
      return true;
    }
  }
  return false;
}

function writeTiles(
  directory: string,
  land: Uint8Array,
  ice: Uint8Array,
  dist: Float32Array,
  hideIce: boolean,
  emptyBuf: Buffer,
): void {
  mkdirSync(directory, { recursive: true });
  for (let z = 0; z <= MAX_Z; z++) {
    const n = 2 ** z;
    let painted = 0;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const file = path.join(directory, String(z), String(x), `${y}.png`);
        if (!tileMayHaveLand(z, x, y, land, ice, hideIce)) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, emptyBuf);
          continue;
        }
        const png = new PNG({ width: TILE, height: TILE });
        let any = false;
        const lng0 = (x / n) * 360 - 180;
        const lng1 = ((x + 1) / n) * 360 - 180;
        for (let py = 0; py < TILE; py++) {
          const north = mercLat(z, y, py);
          const south = mercLat(z, y, py + 1);
          for (let px = 0; px < TILE; px++) {
            const pxLng0 = lng0 + ((lng1 - lng0) * px) / TILE;
            const pxLng1 = lng0 + ((lng1 - lng0) * (px + 1)) / TILE;
            const band =
              z <= 3
                ? medianBand(pxLng0, pxLng1, Math.min(north, south), Math.max(north, south), land, ice, dist, hideIce)
                : centerBand(z, x, y, px, py, land, ice, dist, hideIce);
            if (band == null) continue;
            any = true;
            const color = WORLD_BANDS[band].color;
            const offset = (py * TILE + px) * 4;
            png.data[offset] = color[0];
            png.data[offset + 1] = color[1];
            png.data[offset + 2] = color[2];
            png.data[offset + 3] = bandAlpha(band, WORLD_BANDS.length);
          }
        }
        mkdirSync(path.dirname(file), { recursive: true });
        if (!any) writeFileSync(file, emptyBuf);
        else {
          writeFileSync(file, PNG.sync.write(png));
          painted += 1;
        }
      }
    }
    console.log(`  z${z} ${hideIce ? "without ice" : "with ice"}: ${painted} land tiles`);
  }
}

function writeField(land: Uint8Array, ice: Uint8Array, dist: Float32Array): void {
  // Half the analysis grid. Hover readings are already quantized to 20 km.
  const stride = 2;
  const width = COLS / stride;
  const height = ROWS / stride;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride * COLS + x * stride;
      const offset = (y * width + x) * 4;
      png.data[offset + 3] = 255;
      if (!land[i]) continue;
      const meters = Number.isFinite(dist[i]) ? dist[i] : 6_000_000;
      const km = meters / 1000;
      png.data[offset] = bandIndex(meters, WORLD_BANDS) + 1;
      png.data[offset + 1] = Math.min(255, Math.round(km / KM_STEP) + 1);
      png.data[offset + 2] = ice[i] ? 255 : 0;
    }
  }
  const file = path.join(ROOT, "public/world-field.png");
  writeFileSync(file, PNG.sync.write(png, { deflateLevel: 6 }));
  console.log(`  field ${Math.round(readFileSize(file) / 1024)} KB`);
}

function readFileSize(file: string): number {
  return readFileSync(file).length;
}

async function ensureNaturalEarthRaw(): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  const sources: Record<string, string> = {
    "ne_10m_land.geojson":
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson",
    "ne_10m_glaciated_areas.geojson":
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_glaciated_areas.geojson",
  };
  for (const [file, url] of Object.entries(sources)) {
    const dest = path.join(RAW, file);
    if (existsSync(dest)) continue;
    console.log(`  downloading ${file}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url} (${response.status}).`);
    writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  }
}

function gripGdbAvailable(): boolean {
  try {
    assertGripRegionsPresent();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  assertMeasure();
  assertDistanceTransform();
  assertLocal();
  console.log("distance checks passed");

  await ensureNaturalEarthRaw();

  const fromPublicGrip = !gripGdbAvailable();
  if (fromPublicGrip) {
    for (const region of GRIP_REGIONS) {
      const gz = path.join(WORLD_ROADS_DIR, region.file);
      if (!existsSync(gz)) {
        throw new Error(
          `Missing ${gz}. Install GRIP4 GDBs under data/raw/grip or keep committed overlay gzip files.`,
        );
      }
    }
    console.log("GRIP GDB not found; rasterizing roads from public/world-roads gzip");
  }

  console.log("rasterizing land");
  const land = new Uint8Array(COLS * ROWS);
  rasterizePolygons(loadFeatures("ne_10m_land.geojson"), land, false);
  let landCells = 0;
  for (let i = 0; i < land.length; i++) if (land[i]) landCells += 1;
  const landShare = landCells / land.length;
  console.log(`  land cells ${(landShare * 100).toFixed(1)}%`);
  if (landShare < 0.2 || landShare > 0.45) {
    throw new Error(`Land mask looks wrong (${landShare}).`);
  }

  console.log("rasterizing ice");
  const ice = new Uint8Array(COLS * ROWS);
  rasterizePolygons(loadFeatures("ne_10m_glaciated_areas.geojson"), ice, true);

  console.log("rasterizing GRIP roads (types 1–4)");
  const seeds = new Uint8Array(COLS * ROWS);
  const countsByType: Record<string, number> = {};
  const kmByType: Record<string, number> = {};

  const draw = (a: [number, number], b: [number, number]) => {
    const x0 = lonToX(a[0]);
    const y0 = latToY(a[1]);
    const x1 = lonToX(b[0]);
    const y1 = latToY(b[1]);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const c = Math.round(x0 + dx * t);
      const r = Math.round(y0 + dy * t);
      if (c >= 0 && c < COLS && r >= 0 && r < ROWS) seeds[r * COLS + c] = 1;
    }
  };

  const onRoadFeature = (type: string, lengthKm: number) => {
    countsByType[type] = (countsByType[type] ?? 0) + 1;
    kmByType[type] = (kmByType[type] ?? 0) + lengthKm;
  };
  const drawSegment = (a: [number, number], b: [number, number]) => {
    for (const [start, end] of splitDateLine(a, b)) draw(start, end);
  };

  if (fromPublicGrip) {
    for (const region of GRIP_REGIONS) {
      const gz = path.join(WORLD_ROADS_DIR, region.file);
      console.log(`  region ${region.id} (gzip)`);
      await rasterizeGripGzFile(gz, drawSegment, onRoadFeature);
    }
  } else {
    const RASTER_SIMPLIFY = 0.012;
    for (const region of GRIP_REGIONS) {
      const temp = path.join(os.tmpdir(), `hinterland-grip-${region.id}.ndjson`);
      console.log(`  region ${region.id}`);
      exportGripRegionSeq(region.id, temp, RASTER_SIMPLIFY);
      await rasterizeGripSeqFile(temp, drawSegment, onRoadFeature);
      unlinkSync(temp);
    }

    console.log("writing road overlay assets");
    buildGripOverlayAssets();
    console.log("writing road overview assets (map overlay)");
    await buildGripOverviewAssets();
    const legacyRoads = path.join(ROOT, "public/world-roads.geojson");
    if (existsSync(legacyRoads)) unlinkSync(legacyRoads);
  }

  let seedCells = 0;
  for (let i = 0; i < seeds.length; i++) if (seeds[i]) seedCells += 1;
  console.log(`  road cells ${seedCells.toLocaleString("en-US")}`);
  if (seedCells < 50_000) throw new Error("Too few road cells were painted.");

  console.log("distance transform");
  const dist = computeDistances(seeds);

  const withIce = areas(land, ice, dist, false);
  const noIce = areas(land, ice, dist, true);
  console.log(
    `  land ${Math.round(withIce.landKm2 / 1e6)} million km², ice ${Math.round(withIce.iceKm2 / 1e6)} million km²`,
  );

  const samples: SampleReading[] = SAMPLES.map((sample) => {
    const i = cellAt(sample.lon, sample.lat);
    const onLand = land[i] === 1;
    const onIce = ice[i] === 1;
    if (!onLand) {
      return { ...sample, land: false, ice: onIce, km: null, bandId: null };
    }
    const meters = Number.isFinite(dist[i]) ? dist[i] : Number.POSITIVE_INFINITY;
    return {
      ...sample,
      land: true,
      ice: onIce,
      km: Math.round(meters / 1000),
      bandId: WORLD_BANDS[bandIndex(meters, WORLD_BANDS)].id,
    };
  });
  for (const sample of samples) {
    console.log(`  ${sample.name}: ${sample.land ? `${sample.km} km` : "water"}${sample.ice ? " ice" : ""}`);
  }

  const london = samples.find((sample) => sample.id === "london");
  if (!london?.land) throw new Error("London fell in the ocean. The land mask is shifted.");
  if (london.km != null && london.km > 40) {
    throw new Error(`London is ${london.km} km from a road. The road raster or distance field is off.`);
  }
  const sahara = samples.find((sample) => sample.id === "tanezrouft");
  if (sahara?.km != null && sahara.km < 5) {
    throw new Error("The Tanezrouft looks too close to a road. The distance field may be wrong.");
  }
  const amazon = samples.find((sample) => sample.id === "amazon");
  if (amazon?.km != null && amazon.km > 200) {
    throw new Error(
      `The western Amazon is still ${amazon.km} km from a road. GRIP should be denser than Natural Earth here.`,
    );
  }

  const meta: WorldMeta = {
    resolutionDeg: RES,
    cols: COLS,
    rows: ROWS,
    kmStep: KM_STEP,
    tileMaxZoom: MAX_Z,
    roads: {
      source: GRIP_SOURCE,
      excluded: EXCLUDED,
      countsByType,
      kmByType: Object.fromEntries(
        Object.entries(kmByType).map(([key, value]) => [key, Math.round(value)]),
      ),
    },
    landKm2: Math.round(withIce.landKm2),
    iceKm2: Math.round(withIce.iceKm2),
    areaWithIce: withIce.shares,
    areaNoIce: noIce.shares,
    samples,
  };
  writeFileSync(path.join(ROOT, "public/world-meta.json"), JSON.stringify(meta));

  console.log("writing field");
  writeField(land, ice, dist);

  const empty = new PNG({ width: TILE, height: TILE });
  const emptyBuf = PNG.sync.write(empty);
  console.log("writing tiles");
  writeTiles(TILE_DIR, land, ice, dist, false, emptyBuf);
  writeTiles(TILE_DIR_NO_ICE, land, ice, dist, true, emptyBuf);
  console.log("done");
}

void main();
