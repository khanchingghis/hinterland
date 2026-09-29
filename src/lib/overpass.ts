import { ROAD_GROUPS, highwaysForGroups, type BBox } from "@/lib/roads";
import type { RoadLine } from "@/lib/geo/local";

const ALLOWED = new Set(ROAD_GROUPS.flatMap((group) => group.highways));
const GROUP_IDS = new Set(ROAD_GROUPS.map((group) => group.id));

/** kumi sends Access-Control-Allow-Origin: *, so a static GitLab Pages site can call it. */
const ENDPOINTS = ["https://overpass.kumi.systems/api/interpreter"];

type CacheEntry = { at: number; segments: RoadLine[] };
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 10 * 60 * 1000;

type OverpassElement = {
  type?: string;
  tags?: { highway?: string };
  geometry?: { lon: number; lat: number }[];
};

export async function fetchRoads(
  box: BBox,
  groupIds: string[],
  signal?: AbortSignal,
): Promise<RoadLine[]> {
  if (box.west >= box.east) {
    throw new Error("This view crosses the date line. Pan so the area sits on one side of it.");
  }
  const selected = groupIds.filter((value) => GROUP_IDS.has(value));
  if (selected.length === 0) {
    throw new Error("Choose at least one kind of road.");
  }

  const highways = highwaysForGroups(selected).filter((value) => ALLOWED.has(value));
  const key = [
    box.south.toFixed(4),
    box.west.toFixed(4),
    box.north.toFixed(4),
    box.east.toFixed(4),
    highways.join("|"),
  ].join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.segments;

  const regex = `^(${highways.join("|")})$`;
  const query = `[out:json][timeout:25];
way["highway"~"${regex}"](${box.south},${box.west},${box.north},${box.east});
out geom;`;

  let lastError = "OpenStreetMap did not answer.";
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: query,
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `Road service returned ${response.status}.`;
        continue;
      }
      const parsed = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string };
      if (parsed.remark && !parsed.elements) {
        lastError = "The road query timed out. Zoom in and try again.";
        continue;
      }
      const segments = simplifyElements(parsed.elements ?? []);
      if (segments.length > 80_000) {
        throw new Error("That view has too many roads to measure at once. Zoom in.");
      }
      if (segments.length === 0) {
        throw new Error("No roads of the selected kinds in this view.");
      }
      cache.set(key, { at: Date.now(), segments });
      if (cache.size > 12) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      return segments;
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") throw caught;
      if (caught instanceof Error && /too many roads|No roads/.test(caught.message)) throw caught;
      lastError = "The road service could not be reached.";
    }
  }

  throw new Error(lastError);
}

function simplifyElements(elements: OverpassElement[]): RoadLine[] {
  const segments: RoadLine[] = [];
  for (const element of elements) {
    if (element.type !== "way" || !element.geometry || !element.tags?.highway) continue;
    const coords: [number, number][] = [];
    let previous: [number, number] | null = null;
    for (const point of element.geometry) {
      if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue;
      const next: [number, number] = [
        Math.round(point.lon * 1e5) / 1e5,
        Math.round(point.lat * 1e5) / 1e5,
      ];
      if (previous) {
        const dLon = next[0] - previous[0];
        const dLat = next[1] - previous[1];
        if (dLon * dLon + dLat * dLat < 4e-8) continue;
      }
      coords.push(next);
      previous = next;
    }
    const last = element.geometry[element.geometry.length - 1];
    if (last && coords.length >= 1) {
      const end: [number, number] = [
        Math.round(last.lon * 1e5) / 1e5,
        Math.round(last.lat * 1e5) / 1e5,
      ];
      const tail = coords[coords.length - 1];
      if (tail[0] !== end[0] || tail[1] !== end[1]) coords.push(end);
    }
    if (coords.length >= 2) segments.push({ highway: element.tags.highway, coords });
  }
  return segments;
}
