import { bandIndex, type Band } from "@/lib/bands";
import { distanceToFeatures } from "@/lib/geo/edt";
import { metersPerDegLat, metersPerDegLon, splitDateLine, type LonLat } from "@/lib/geo/measure";
import type { BBox } from "@/lib/roads";

export type RoadLine = {
  highway: string;
  coords: LonLat[];
};

export type LocalGrid = {
  west: number;
  south: number;
  east: number;
  north: number;
  cols: number;
  rows: number;
  /** Average cell edge, for display. */
  cellM: number;
  sx: number;
  sy: number;
  meters: Float32Array;
};

const MAX_CELLS = 480;

export function buildLocalGrid(roads: RoadLine[], box: BBox, requestedCellM: number): LocalGrid {
  const mid = (box.south + box.north) / 2;
  const mLon = metersPerDegLon(mid);
  const mLat = metersPerDegLat(mid);
  const widthM = Math.max(1, (box.east - box.west) * mLon);
  const heightM = Math.max(1, (box.north - box.south) * mLat);

  let cellM = Math.max(8, requestedCellM);
  let cols = Math.ceil(widthM / cellM);
  let rows = Math.ceil(heightM / cellM);
  const scale = Math.max(cols, rows) / MAX_CELLS;
  if (scale > 1) {
    cellM *= scale;
    cols = Math.ceil(widthM / cellM);
    rows = Math.ceil(heightM / cellM);
  }
  cols = Math.max(2, Math.min(MAX_CELLS, cols));
  rows = Math.max(2, Math.min(MAX_CELLS, rows));

  const sx = widthM / cols;
  const sy = heightM / rows;
  const seeds = new Uint8Array(cols * rows);

  for (const road of roads) {
    for (let i = 0; i < road.coords.length - 1; i++) {
      for (const [a, b] of splitDateLine(road.coords[i], road.coords[i + 1])) {
        const x0 = ((a[0] - box.west) * mLon) / sx;
        const y0 = ((box.north - a[1]) * mLat) / sy;
        const x1 = ((b[0] - box.west) * mLon) / sx;
        const y1 = ((box.north - b[1]) * mLat) / sy;
        stamp(seeds, cols, rows, x0, y0, x1, y1);
      }
    }
  }

  const meters = distanceToFeatures(seeds, cols, rows, sx, sy);
  return {
    west: box.west,
    south: box.south,
    east: box.east,
    north: box.north,
    cols,
    rows,
    cellM: (sx + sy) / 2,
    sx,
    sy,
    meters,
  };
}

function stamp(
  seeds: Uint8Array,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const margin = 1;
  if (
    (x0 < -margin && x1 < -margin) ||
    (y0 < -margin && y1 < -margin) ||
    (x0 > cols + margin && x1 > cols + margin) ||
    (y0 > rows + margin && y1 > rows + margin)
  ) {
    return;
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.min(20_000, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    let c = Math.round(x0 + dx * t);
    let r = Math.round(y0 + dy * t);
    if (c === -1) c = 0;
    if (r === -1) r = 0;
    if (c === cols) c = cols - 1;
    if (r === rows) r = rows - 1;
    if (c >= 0 && c < cols && r >= 0 && r < rows) seeds[r * cols + c] = 1;
  }
}

export function buildStudy(roads: RoadLine[], box: BBox, requestedCellM: number, bands: Band[]) {
  const started = Date.now();
  const grid = buildLocalGrid(roads, box, requestedCellM);
  return {
    grid,
    shares: summarizeGrid(grid, bands),
    ms: Date.now() - started,
  };
}

export function summarizeGrid(
  grid: LocalGrid,
  bands: Band[],
): { id: string; share: number }[] {
  const counts = new Array<number>(bands.length).fill(0);
  for (let i = 0; i < grid.meters.length; i++) {
    counts[bandIndex(grid.meters[i], bands)] += 1;
  }
  const total = grid.meters.length || 1;
  return bands.map((band, index) => ({ id: band.id, share: counts[index] / total }));
}

export function sampleGrid(grid: LocalGrid, lon: number, lat: number): number | null {
  if (lon < grid.west || lon > grid.east || lat < grid.south || lat > grid.north) return null;
  const x = ((lon - grid.west) / (grid.east - grid.west)) * grid.cols;
  const y = ((grid.north - lat) / (grid.north - grid.south)) * grid.rows;
  const c = Math.min(grid.cols - 1, Math.max(0, Math.floor(x)));
  const r = Math.min(grid.rows - 1, Math.max(0, Math.floor(y)));
  const meters = grid.meters[r * grid.cols + c];
  return Number.isFinite(meters) ? meters : null;
}

export function nearestRoad(
  roads: RoadLine[],
  lon: number,
  lat: number,
): { highway: string; meters: number } | null {
  if (roads.length === 0) return null;
  const midLat = lat;
  const mLon = metersPerDegLon(midLat);
  const mLat = metersPerDegLat(midLat);
  const px = lon * mLon;
  const py = lat * mLat;

  let best = Number.POSITIVE_INFINITY;
  let highway = roads[0].highway;

  for (const road of roads) {
    const coords = road.coords;
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = coords[i][0] * mLon;
      const ay = coords[i][1] * mLat;
      const bx = coords[i + 1][0] * mLon;
      const by = coords[i + 1][1] * mLat;
      // Cheap reject: skip segments whose box is already farther than the best hit.
      const minX = Math.min(ax, bx) - best;
      const maxX = Math.max(ax, bx) + best;
      const minY = Math.min(ay, by) - best;
      const maxY = Math.max(ay, by) + best;
      if (px < minX || px > maxX || py < minY || py > maxY) continue;
      const dist = pointSegmentDistance(px, py, ax, ay, bx, by);
      if (dist < best) {
        best = dist;
        highway = road.highway;
      }
    }
  }

  if (!Number.isFinite(best)) return null;
  return { highway, meters: best };
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / ab2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = ax + abx * t - px;
  const dy = ay + aby * t - py;
  return Math.hypot(dx, dy);
}

export function assertLocal(): void {
  const roads: RoadLine[] = [
    {
      highway: "primary",
      coords: [
        [0, 0],
        [0.02, 0],
      ],
    },
  ];
  const grid = buildLocalGrid(
    roads,
    { west: 0, south: 0, east: 0.02, north: 0.02 },
    80,
  );
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < grid.meters.length; i++) {
    if (grid.meters[i] < min) min = grid.meters[i];
  }
  if (min > 50) throw new Error(`local road cell too far: ${min}`);

  const south = sampleGrid(grid, 0.01, 0.0002);
  const north = sampleGrid(grid, 0.01, 0.018);
  if (south == null || north == null) throw new Error("sample missed the grid");
  if (!(north > south + 500)) {
    throw new Error(`expected the north cell to be farther (${south} vs ${north})`);
  }
}
