/**
 * Regional 0.025° distance fields for high zoom (lazy-loaded). Same encoding as world-field.png.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { GRIP_REGIONS } from "../src/lib/grip-inventory";
import { WORLD_BANDS, bandIndex } from "../src/lib/bands";
import { distanceToFeatures } from "../src/lib/geo/edt";
import { metersPerDegLat, metersPerDegLon, splitDateLine } from "../src/lib/geo/measure";
import { rasterizeGripGzFile } from "./grip-export";
import type { WorldFieldDetailMeta } from "../src/lib/world-types";

export const FIELD_DETAIL_RES = 0.025;
export const FIELD_DETAIL_MIN_ZOOM = 8;
const KM_STEP = 1;
const PAD_DEG = 4;

const ROOT = path.resolve(__dirname, "..");
const DETAIL_DIR = path.join(ROOT, "public/world-field-detail");
const WORLD_ROADS_DIR = path.join(ROOT, "public/world-roads");

type Geometry = {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
};

type Feature = {
  properties: Record<string, unknown>;
  geometry: Geometry | null;
};

type Edge = { y0: number; y1: number; x0: number; x1: number };

function lonToX(lon: number, west: number, east: number, cols: number): number {
  return ((lon - west) / (east - west)) * cols;
}

function latToY(lat: number, south: number, north: number, rows: number): number {
  return ((north - lat) / (north - south)) * rows;
}

function rasterizePolygonsInBox(
  features: Feature[],
  mask: Uint8Array,
  cols: number,
  rows: number,
  west: number,
  east: number,
  south: number,
  north: number,
  exteriorOnly: boolean,
): void {
  const edges: Edge[] = [];

  const pushRing = (ring: number[][]) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const a: [number, number] = [ring[i][0], ring[i][1]];
      const b: [number, number] = [ring[i + 1][0], ring[i + 1][1]];
      for (const [start, end] of splitDateLine(a, b)) {
        if (start[0] < west - 1 && end[0] < west - 1) continue;
        if (start[0] > east + 1 && end[0] > east + 1) continue;
        if (start[1] < south - 1 && end[1] < south - 1) continue;
        if (start[1] > north + 1 && end[1] > north + 1) continue;
        let y0 = latToY(start[1], south, north, rows);
        let x0 = lonToX(start[0], west, east, cols);
        let y1 = latToY(end[1], south, north, rows);
        let x1 = lonToX(end[0], west, east, cols);
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

  for (let y = 0; y < rows; y++) {
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
    const row = y * cols;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let c0 = Math.ceil(xs[i] - 0.5);
      let c1 = Math.floor(xs[i + 1] - 0.5);
      if (c0 < 0) c0 = 0;
      if (c1 >= cols) c1 = cols - 1;
      for (let c = c0; c <= c1; c++) mask[row + c] = 1;
    }
  }
}

function computeRegionalDistances(
  seeds: Uint8Array,
  cols: number,
  rows: number,
  south: number,
  north: number,
): Float32Array {
  const out = new Float32Array(cols * rows);
  out.fill(Number.POSITIVE_INFINITY);
  const stripDeg = 10;
  const padDeg = 24;
  const padRows = Math.ceil(padDeg / FIELD_DETAIL_RES);
  const padCols = Math.ceil(padDeg / FIELD_DETAIL_RES);

  for (let lat0 = south; lat0 < north; lat0 += stripDeg) {
    const lat1 = Math.min(north, lat0 + stripDeg);
    const coreR0 = Math.max(0, Math.min(rows, Math.round((90 - lat1) / FIELD_DETAIL_RES)));
    const coreR1 = Math.max(coreR0, Math.min(rows, Math.round((90 - lat0) / FIELD_DETAIL_RES)));
    const r0 = Math.max(0, coreR0 - padRows);
    const r1 = Math.min(rows, coreR1 + padRows);
    const height = r1 - r0;
    const width = cols + padCols * 2;
    const sub = new Uint8Array(width * height);

    for (let r = 0; r < height; r++) {
      const src = (r0 + r) * cols;
      const dest = r * width;
      for (let c = 0; c < padCols; c++) sub[dest + c] = seeds[src + (cols - padCols + c)];
      sub.set(seeds.subarray(src, src + cols), dest + padCols);
      for (let c = 0; c < padCols; c++) sub[dest + padCols + cols + c] = seeds[src + c];
    }

    const midLat = Math.max(-84, Math.min(84, (lat0 + lat1) / 2));
    const sy = metersPerDegLat(midLat) * FIELD_DETAIL_RES;
    const sx = Math.max(50, metersPerDegLon(midLat) * FIELD_DETAIL_RES);
    const dist = distanceToFeatures(sub, width, height, sx, sy);

    for (let r = coreR0; r < coreR1; r++) {
      const srcRow = (r - r0) * width + padCols;
      const destRow = r * cols;
      for (let c = 0; c < cols; c++) {
        const value = dist[srcRow + c];
        if (value < out[destRow + c]) out[destRow + c] = value;
      }
    }
  }

  return out;
}

function paddedBounds(west: number, south: number, east: number, north: number) {
  return {
    west: Math.max(-180, west - PAD_DEG),
    south: Math.max(-90, south - PAD_DEG),
    east: Math.min(180, east + PAD_DEG),
    north: Math.min(90, north + PAD_DEG),
  };
}

export type FieldDetailRegionMeta = {
  id: string;
  file: string;
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
};

export async function buildRegionalFieldDetails(
  landFeatures: Feature[],
  iceFeatures: Feature[],
): Promise<FieldDetailRegionMeta[]> {
  mkdirSync(DETAIL_DIR, { recursive: true });
  const regions: FieldDetailRegionMeta[] = [];

  for (const region of GRIP_REGIONS) {
    const gz = path.join(WORLD_ROADS_DIR, region.file);
    if (!existsSync(gz)) {
      throw new Error(`Missing ${gz} for field detail build.`);
    }
    const box = paddedBounds(region.west, region.south, region.east, region.north);
    const cols = Math.ceil((box.east - box.west) / FIELD_DETAIL_RES);
    const rows = Math.ceil((box.north - box.south) / FIELD_DETAIL_RES);
    console.log(`  field detail region ${region.id} ${cols}×${rows}`);

    const land = new Uint8Array(cols * rows);
    const ice = new Uint8Array(cols * rows);
    rasterizePolygonsInBox(landFeatures, land, cols, rows, box.west, box.east, box.south, box.north, false);
    rasterizePolygonsInBox(iceFeatures, ice, cols, rows, box.west, box.east, box.south, box.north, true);

    const seeds = new Uint8Array(cols * rows);
    const lonToCol = (lon: number) =>
      Math.min(cols - 1, Math.max(0, Math.floor((lon - box.west) / FIELD_DETAIL_RES)));
    const latToRow = (lat: number) =>
      Math.min(rows - 1, Math.max(0, Math.floor((box.north - lat) / FIELD_DETAIL_RES)));

    const draw = (a: [number, number], b: [number, number]) => {
      const x0 = lonToCol(a[0]);
      const y0 = latToRow(a[1]);
      const x1 = lonToCol(b[0]);
      const y1 = latToRow(b[1]);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const c = Math.round(x0 + dx * t);
        const r = Math.round(y0 + dy * t);
        if (c >= 0 && c < cols && r >= 0 && r < rows) seeds[r * cols + c] = 1;
      }
    };

    const drawSegment = (a: [number, number], b: [number, number]) => {
      for (const [start, end] of splitDateLine(a, b)) draw(start, end);
    };

    await rasterizeGripGzFile(gz, drawSegment, () => {});

    const dist = computeRegionalDistances(seeds, cols, rows, box.south, box.north);
    const png = new PNG({ width: cols, height: rows });
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const offset = i * 4;
        png.data[offset + 3] = 255;
        if (!land[i]) continue;
        const meters = Number.isFinite(dist[i]) ? dist[i] : 6_000_000;
        const km = meters / 1000;
        png.data[offset] = bandIndex(meters, WORLD_BANDS) + 1;
        png.data[offset + 1] = Math.min(255, Math.round(km / KM_STEP) + 1);
        png.data[offset + 2] = ice[i] ? 255 : 0;
      }
    }

    const file = `region-${region.id}.png`;
    const outPath = path.join(DETAIL_DIR, file);
    writeFileSync(outPath, PNG.sync.write(png, { deflateLevel: 6 }));
    const kb = Math.round(readFileSync(outPath).length / 1024);
    console.log(`    ${file} ${kb} KB`);

    regions.push({
      id: region.id,
      file,
      west: box.west,
      south: box.south,
      east: box.east,
      north: box.north,
      cols,
      rows,
    });
  }

  writeFileSync(path.join(DETAIL_DIR, "manifest.json"), JSON.stringify({ resolutionDeg: FIELD_DETAIL_RES, minZoom: FIELD_DETAIL_MIN_ZOOM, regions }));
  return regions;
}

export function fieldDetailMetaForWorldMeta(regions: FieldDetailRegionMeta[]): WorldFieldDetailMeta {
  return {
    resolutionDeg: FIELD_DETAIL_RES,
    minZoom: FIELD_DETAIL_MIN_ZOOM,
    regions: regions.map(({ id, file, west, south, east, north, cols, rows }) => ({
      id,
      file,
      west,
      south,
      east,
      north,
      cols,
      rows,
    })),
  };
}
