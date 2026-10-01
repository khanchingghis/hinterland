import { publicPath } from "@/lib/base-path";
import type { FieldDetailRegionMeta, WorldFieldDetailMeta } from "@/lib/world-types";
import type { BBox } from "@/lib/roads";
import type { WorldField } from "@/lib/geo/world-field";

export const WORLD_FIELD_DETAIL_MIN_ZOOM = 8;

export type GeoWorldField = WorldField & {
  resDeg: number;
  west: number;
  south: number;
  east: number;
  north: number;
  regionId: string;
};

export function regionsForBounds(
  meta: WorldFieldDetailMeta | undefined,
  bounds: BBox,
): FieldDetailRegionMeta[] {
  if (!meta) return [];
  return meta.regions.filter(
    (region) =>
      region.east > bounds.west &&
      region.west < bounds.east &&
      region.north > bounds.south &&
      region.south < bounds.north,
  );
}

export async function decodeFieldPng(
  response: Response,
  region: FieldDetailRegionMeta,
): Promise<GeoWorldField | null> {
  if (!response.ok) return null;
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    data: image.data,
    resDeg: (region.east - region.west) / region.cols,
    west: region.west,
    south: region.south,
    east: region.east,
    north: region.north,
    regionId: region.id,
  };
}

export async function loadFieldDetailManifest(): Promise<WorldFieldDetailMeta | null> {
  try {
    const response = await fetch(publicPath("/world-field-detail/manifest.json"));
    if (!response.ok) return null;
    return (await response.json()) as WorldFieldDetailMeta;
  } catch {
    return null;
  }
}

export async function fetchFieldDetailRegion(
  region: FieldDetailRegionMeta,
  signal?: AbortSignal,
): Promise<GeoWorldField | null> {
  const response = await fetch(publicPath(`/world-field-detail/${region.file}`), { signal });
  return decodeFieldPng(response, region);
}

export function boundsOverlap(a: BBox, west: number, south: number, east: number, north: number): boolean {
  return a.east > west && a.west < east && a.north > south && a.south < north;
}
