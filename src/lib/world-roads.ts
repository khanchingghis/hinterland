import { publicPath } from "@/lib/base-path";
import type { BBox } from "@/lib/roads";

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
};

type GeoJsonFeature = {
  properties?: { type?: string };
  geometry?: {
    type: string;
    coordinates: number[][] | number[][][];
  };
};

let manifestPromise: Promise<WorldRoadsManifest> | null = null;
const loadedRegionFiles = new Map<string, WorldRoadLine[]>();

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

async function loadRegionFile(file: string): Promise<WorldRoadLine[]> {
  if (loadedRegionFiles.has(file)) return loadedRegionFiles.get(file)!;
  const response = await fetch(publicPath(`/world-roads/${file}`));
  if (!response.ok) throw new Error(`Road overlay ${file} did not load.`);
  const compressed = await response.arrayBuffer();
  const text = await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const lines: WorldRoadLine[] = [];
  for (const row of text.split("\n")) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    const feature = JSON.parse(trimmed) as GeoJsonFeature;
    lines.push(...parseFeatureLines(feature));
  }
  loadedRegionFiles.set(file, lines);
  return lines;
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

/** Preload manifest (and legacy inventory when present). */
export function loadWorldRoadInventory(): Promise<WorldRoadInventory> {
  return ensureWorldRoadInventory(null);
}

export function linesInBounds(inventory: WorldRoadInventory, bounds: BBox): WorldRoadLine[] {
  const pad = 0.25;
  const west = bounds.west - pad;
  const east = bounds.east + pad;
  const south = bounds.south - pad;
  const north = bounds.north + pad;
  return inventory.lines.filter(
    (line) => line.east >= west && line.west <= east && line.north >= south && line.south <= north,
  );
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
