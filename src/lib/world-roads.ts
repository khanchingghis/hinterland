import { publicPath } from "@/lib/base-path";
import type { BBox } from "@/lib/roads";
import type { ExpressionSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, MultiLineString, Position } from "geojson";

export type WorldRoadLine = {
  type: string;
  coords: [number, number][];
  west: number;
  south: number;
  east: number;
  north: number;
};

export type WorldRoadInventory = {
  source: string;
  excluded: string[];
  roadTypes?: string;
  lines: WorldRoadLine[];
};

type WorldRoadsManifest = {
  source: string;
  roadTypes?: string;
  excluded: string[];
  regions: {
    id: string;
    file: string;
    west: number;
    south: number;
    east: number;
    north: number;
  }[];
  overviews?: {
    highway: { file: string; maxZoom: number; maxRoadType: number };
    major: { file: string; maxZoom: number; maxRoadType: number };
  };
};

type GeoJsonFeature = {
  properties?: { type?: string; GP_RTP?: number };
  geometry?: {
    type: string;
    coordinates: number[][] | number[][][];
  };
};

/** Zoom ≤ this uses the global highway-only overview (one ~13 MB gzip). */
export const WORLD_ROADS_HIGHWAY_OVERVIEW_MAX_ZOOM = 3;
/** Zoom ≤ this (and > highway max) uses the major-road overview (types 1–2). */
export const WORLD_ROADS_MAJOR_OVERVIEW_MAX_ZOOM = 6;

let manifestPromise: Promise<WorldRoadsManifest> | null = null;
const loadedRegionFiles = new Map<string, WorldRoadLine[]>();
const overviewCache = new Map<string, FeatureCollection>();

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function pushLine(
  lines: WorldRoadLine[],
  type: string,
  coords: [number, number][],
): void {
  if (coords.length < 2) return;
  let west = coords[0][0];
  let east = coords[0][0];
  let south = coords[0][1];
  let north = coords[0][1];
  for (const [lon, lat] of coords) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  lines.push({ type, coords, west, south, east, north });
}

function parseFeatureLines(feature: GeoJsonFeature): WorldRoadLine[] {
  const type = String(feature.properties?.type ?? "Unknown");
  const geometry = feature.geometry;
  if (!geometry) return [];
  const out: WorldRoadLine[] = [];
  if (geometry.type === "LineString") {
    pushLine(out, type, geometry.coordinates as [number, number][]);
  } else if (geometry.type === "MultiLineString") {
    for (const part of geometry.coordinates as [number, number][][]) {
      pushLine(out, type, part);
    }
  }
  return out;
}

function lineIntersectsBounds(line: WorldRoadLine, bounds: BBox, pad: number): boolean {
  const west = bounds.west - pad;
  const east = bounds.east + pad;
  const south = bounds.south - pad;
  const north = bounds.north + pad;
  return line.east >= west && line.west <= east && line.north >= south && line.south <= north;
}

function regionIntersectsBounds(
  region: WorldRoadsManifest["regions"][number],
  bounds: BBox,
  pad: number,
): boolean {
  const west = bounds.west - pad;
  const east = bounds.east + pad;
  const south = bounds.south - pad;
  const north = bounds.north + pad;
  return region.east >= west && region.west <= east && region.north >= south && region.south <= north;
}

function featureFromGripRow(row: GeoJsonFeature): Feature<LineString | MultiLineString>[] {
  const type = String(row.properties?.type ?? "Unknown");
  const geometry = row.geometry;
  if (!geometry) return [];
  if (geometry.type === "LineString") {
    return [
      {
        type: "Feature",
        properties: { type },
        geometry: {
          type: "LineString",
          coordinates: geometry.coordinates as Position[],
        },
      },
    ];
  }
  if (geometry.type === "MultiLineString") {
    return [
      {
        type: "Feature",
        properties: { type },
        geometry: {
          type: "MultiLineString",
          coordinates: geometry.coordinates as Position[][],
        },
      },
    ];
  }
  return [];
}

async function loadManifest(): Promise<WorldRoadsManifest> {
  if (!manifestPromise) {
    manifestPromise = fetch(publicPath("/world-roads/manifest.json"))
      .then((response) => {
        if (!response.ok) throw new Error("The world road manifest did not load.");
        return response.json() as Promise<WorldRoadsManifest>;
      })
      .catch(async () => {
        const legacy = await fetch(publicPath("/world-roads.geojson"));
        if (!legacy.ok) throw new Error("The world road inventory did not load.");
        const body = (await legacy.json()) as {
          properties?: { source?: string; excluded?: string[] };
          features: GeoJsonFeature[];
        };
        const lines: WorldRoadLine[] = [];
        for (const feature of body.features) {
          lines.push(...parseFeatureLines(feature));
        }
        return {
          source: body.properties?.source ?? "Natural Earth 1:10 million roads",
          excluded: body.properties?.excluded ?? [],
          regions: [],
          roadTypes: undefined,
          _legacyLines: lines,
        } as WorldRoadsManifest & { _legacyLines?: WorldRoadLine[] };
      });
  }
  return manifestPromise;
}

async function streamNdjsonGzip(
  url: string,
  signal: AbortSignal | undefined,
  onRow: (row: GeoJsonFeature) => void | Promise<void>,
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Road overlay did not load (${response.status}).`);
  if (!response.body) throw new Error("Road overlay did not load.");
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let rows = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const trimmed = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (trimmed) {
        const feature = JSON.parse(trimmed) as GeoJsonFeature;
        await onRow(feature);
        rows += 1;
        if (rows % 2500 === 0) await yieldToMain();
      }
      newline = pending.indexOf("\n");
    }
  }
  const tail = pending.trim();
  if (tail) {
    const feature = JSON.parse(tail) as GeoJsonFeature;
    await onRow(feature);
  }
}

async function loadRegionFile(file: string, signal?: AbortSignal): Promise<WorldRoadLine[]> {
  if (loadedRegionFiles.has(file)) return loadedRegionFiles.get(file)!;
  const lines: WorldRoadLine[] = [];
  await streamNdjsonGzip(publicPath(`/world-roads/${file}`), signal, (row) => {
    const rtp = row.properties?.GP_RTP ?? 99;
    if (rtp > 4) return;
    lines.push(...parseFeatureLines(row));
  });
  loadedRegionFiles.set(file, lines);
  return lines;
}

async function loadOverviewFile(
  cacheKey: string,
  file: string,
  maxRoadType: number,
  signal?: AbortSignal,
): Promise<FeatureCollection> {
  const cached = overviewCache.get(cacheKey);
  if (cached) return cached;
  const features: Feature[] = [];
  await streamNdjsonGzip(publicPath(`/world-roads/${file}`), signal, (row) => {
    const rtp = row.properties?.GP_RTP ?? 99;
    if (rtp > maxRoadType) return;
    features.push(...featureFromGripRow(row));
  });
  const collection: FeatureCollection = { type: "FeatureCollection", features };
  overviewCache.set(cacheKey, collection);
  return collection;
}

function defaultOverviews(manifest: WorldRoadsManifest): NonNullable<WorldRoadsManifest["overviews"]> {
  return (
    manifest.overviews ?? {
      highway: {
        file: "grip-overview-highway.ndjson.gz",
        maxZoom: WORLD_ROADS_HIGHWAY_OVERVIEW_MAX_ZOOM,
        maxRoadType: 1,
      },
      major: {
        file: "grip-overview-major.ndjson.gz",
        maxZoom: WORLD_ROADS_MAJOR_OVERVIEW_MAX_ZOOM,
        maxRoadType: 2,
      },
    }
  );
}

function linesToFeatureCollection(lines: WorldRoadLine[]): FeatureCollection {
  const features: Feature<LineString>[] = lines.map((line) => ({
    type: "Feature",
    properties: { type: line.type },
    geometry: {
      type: "LineString",
      coordinates: line.coords,
    },
  }));
  return { type: "FeatureCollection", features };
}

export async function ensureWorldRoadInventory(bounds?: BBox | null): Promise<WorldRoadInventory> {
  const manifest = await loadManifest();
  const legacy = manifest as WorldRoadsManifest & { _legacyLines?: WorldRoadLine[] };
  if (legacy._legacyLines) {
    return {
      source: manifest.source,
      excluded: manifest.excluded,
      roadTypes: manifest.roadTypes,
      lines: legacy._legacyLines,
    };
  }
  const pad = 0.5;
  const box =
    bounds ??
    ({
      west: -180,
      south: -85,
      east: 180,
      north: 85,
    } satisfies BBox);
  const needed = manifest.regions.filter((region) => regionIntersectsBounds(region, box, pad));
  for (const region of needed) {
    if (!loadedRegionFiles.has(region.file)) {
      await loadRegionFile(region.file);
    }
  }
  const lines: WorldRoadLine[] = [];
  for (const region of needed) {
    lines.push(...(loadedRegionFiles.get(region.file) ?? []));
  }
  return {
    source: manifest.source,
    excluded: manifest.excluded,
    roadTypes: manifest.roadTypes,
    lines,
  };
}

export async function loadWorldRoadGeoJson(
  bounds: BBox,
  zoom: number,
  signal?: AbortSignal,
): Promise<FeatureCollection> {
  const manifest = await loadManifest();
  const legacy = manifest as WorldRoadsManifest & { _legacyLines?: WorldRoadLine[] };
  if (legacy._legacyLines) {
    const pad = 0.25;
    const lines = legacy._legacyLines.filter((line) => lineIntersectsBounds(line, bounds, pad));
    return linesToFeatureCollection(lines);
  }

  const overviews = defaultOverviews(manifest);
  if (zoom <= overviews.highway.maxZoom) {
    return loadOverviewFile("highway", overviews.highway.file, overviews.highway.maxRoadType, signal);
  }
  if (zoom <= overviews.major.maxZoom) {
    return loadOverviewFile("major", overviews.major.file, overviews.major.maxRoadType, signal);
  }

  const pad = 0.5;
  const needed = manifest.regions.filter((region) => regionIntersectsBounds(region, bounds, pad));
  for (const region of needed) {
    if (!loadedRegionFiles.has(region.file)) {
      await loadRegionFile(region.file, signal);
    }
  }
  const lines: WorldRoadLine[] = [];
  const viewPad = 0.25;
  for (const region of needed) {
    for (const line of loadedRegionFiles.get(region.file) ?? []) {
      if (lineIntersectsBounds(line, bounds, viewPad)) lines.push(line);
    }
  }
  return linesToFeatureCollection(lines);
}

/** Preload manifest only (tiny); road geometry loads when the overlay is enabled. */
export function preloadWorldRoadsManifest(): Promise<void> {
  return loadManifest().then(() => undefined);
}

/** @deprecated Prefer preloadWorldRoadsManifest; full-world load is intentionally avoided. */
export function loadWorldRoadInventory(): Promise<WorldRoadInventory> {
  return preloadWorldRoadsManifest().then(() =>
    ensureWorldRoadInventory({
      west: -180,
      south: -85,
      east: 180,
      north: 85,
    }),
  );
}

export function linesInBounds(inventory: WorldRoadInventory, bounds: BBox): WorldRoadLine[] {
  const pad = 0.25;
  return inventory.lines.filter((line) => lineIntersectsBounds(line, bounds, pad));
}

export function strokeColorForRoadType(type: string): string {
  switch (type) {
    case "Highway":
    case "Major Highway":
      return "#b83828";
    case "Primary":
    case "Secondary Highway":
      return "#c86a2c";
    case "Secondary":
      return "#d08030";
    case "Tertiary":
    case "Road":
      return "#7a5a2a";
    case "Beltway":
    case "Bypass":
      return "#9a4528";
    case "Track":
      return "#6a5848";
    default:
      return "#4a4038";
  }
}

export function lineWidthForZoom(zoom: number): number {
  if (zoom <= 2) return 0.6;
  if (zoom <= 4) return 1.1;
  if (zoom <= 7) return 2;
  if (zoom <= 10) return 2.8;
  return 3.6;
}

export function worldRoadLineColorExpression(): ExpressionSpecification {
  return [
    "match",
    ["get", "type"],
    "Highway",
    "#b83828",
    "Major Highway",
    "#b83828",
    "Primary",
    "#c86a2c",
    "Secondary Highway",
    "#c86a2c",
    "Secondary",
    "#d08030",
    "Tertiary",
    "#7a5a2a",
    "Road",
    "#7a5a2a",
    "Beltway",
    "#9a4528",
    "Bypass",
    "#9a4528",
    "Track",
    "#6a5848",
    "#4a4038",
  ];
}

export function worldRoadLineWidthExpression(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    1,
    0.6,
    2,
    0.6,
    4,
    1.1,
    7,
    2,
    10,
    2.8,
    16,
    3.6,
  ];
}

export function worldRoadLineCasingWidthExpression(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    1,
    2.8,
    2,
    2.8,
    4,
    3.3,
    7,
    4.2,
    10,
    5,
    16,
    5.8,
  ];
}
