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
  lines: WorldRoadLine[];
};

type GeoJsonFeature = {
  properties?: { type?: string };
  geometry?: {
    type: string;
    coordinates: number[][] | number[][][];
  };
};

let cached: Promise<WorldRoadInventory> | null = null;

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

function parseInventory(body: {
  properties?: { source?: string; excluded?: string[] };
  features: GeoJsonFeature[];
}): WorldRoadInventory {
  const lines: WorldRoadLine[] = [];
  for (const feature of body.features) {
    const type = String(feature.properties?.type ?? "Unknown");
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "LineString") {
      pushLine(lines, type, geometry.coordinates as [number, number][]);
    } else if (geometry.type === "MultiLineString") {
      for (const part of geometry.coordinates as [number, number][][]) {
        pushLine(lines, type, part);
      }
    }
  }
  return {
    source: body.properties?.source ?? "Natural Earth 1:10 million roads",
    excluded: body.properties?.excluded ?? [],
    lines,
  };
}

export function loadWorldRoadInventory(): Promise<WorldRoadInventory> {
  if (!cached) {
    cached = fetch(publicPath("/world-roads.geojson"))
      .then((response) => {
        if (!response.ok) throw new Error("The world road inventory did not load.");
        return response.json();
      })
      .then(parseInventory);
  }
  return cached;
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
    case "Major Highway":
      return "#b83828";
    case "Secondary Highway":
      return "#c86a2c";
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
