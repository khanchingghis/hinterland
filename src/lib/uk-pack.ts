import type { BBox } from "@/lib/roads";

/** Padded GRIP clip + distance field extent (coasts, Channel, NI approaches). */
export const UK_PACK_BOUNDS: BBox = {
  west: -13,
  south: 48,
  east: 5,
  north: 62,
};

/** Viewport must overlap this box before the UK pack replaces the global stack. */
export const UK_ACTIVATION_BOUNDS: BBox = {
  west: -9.5,
  south: 49.5,
  east: 3,
  north: 60.8,
};

/** First zoom where the UK field + roads may replace the 0.05° global stack. */
export const UK_PACK_MIN_ZOOM = 7;

/** Fraction of the viewport area that must lie inside {@link UK_ACTIVATION_BOUNDS}. */
export const UK_PACK_MIN_VIEW_FRACTION = 0.12;

export type UkPackManifest = {
  source: string;
  roadTypes: string;
  resolutionDeg: number;
  minZoom: number;
  bounds: BBox;
  activation: BBox;
  roadsFile: string;
  fieldFile: string;
  roadsSimplifyDeg: number;
  kmStep: number;
};

function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.east > b.west && a.west < b.east && a.north > b.south && a.south < b.north;
}

function overlapArea(a: BBox, b: BBox): number {
  const west = Math.max(a.west, b.west);
  const east = Math.min(a.east, b.east);
  const south = Math.max(a.south, b.south);
  const north = Math.min(a.north, b.north);
  if (east <= west || north <= south) return 0;
  return (east - west) * (north - south);
}

function viewArea(bounds: BBox): number {
  return Math.max(0, bounds.east - bounds.west) * Math.max(0, bounds.north - bounds.south);
}

export function viewportFractionInActivation(bounds: BBox): number {
  const area = viewArea(bounds);
  if (area <= 0) return 0;
  return overlapArea(bounds, UK_ACTIVATION_BOUNDS) / area;
}

export function viewportQualifiesForUkPack(bounds: BBox, zoom: number): boolean {
  if (zoom < UK_PACK_MIN_ZOOM) return false;
  if (!boxesOverlap(bounds, UK_ACTIVATION_BOUNDS)) return false;
  return viewportFractionInActivation(bounds) >= UK_PACK_MIN_VIEW_FRACTION;
}

export function pointInPack(lon: number, lat: number): boolean {
  return (
    lon >= UK_PACK_BOUNDS.west &&
    lon <= UK_PACK_BOUNDS.east &&
    lat >= UK_PACK_BOUNDS.south &&
    lat <= UK_PACK_BOUNDS.north
  );
}

// Re-export from uk-field for backwards compatibility
export { loadUkPackManifest } from "@/lib/geo/uk-field";
