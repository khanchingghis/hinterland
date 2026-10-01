import { WORLD_BANDS, bandAlpha } from "@/lib/bands";
import type { StudyRaster } from "@/lib/geo/paint";
import type { BBox } from "@/lib/roads";

/** Decoded `world-field.png`: one pixel per 0.05° analysis cell. */
export type WorldField = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export function fieldCellIndices(
  field: WorldField,
  bounds: BBox,
): { x0: number; x1: number; y0: number; y1: number } {
  const x0 = Math.max(0, Math.floor(((bounds.west + 180) / 360) * field.width));
  const x1 = Math.min(field.width, Math.ceil(((bounds.east + 180) / 360) * field.width));
  const y0 = Math.max(0, Math.floor(((90 - bounds.north) / 180) * field.height));
  const y1 = Math.min(field.height, Math.ceil(((90 - bounds.south) / 180) * field.height));
  return { x0, x1, y0, y1 };
}

export function fieldGeoBounds(
  field: WorldField,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): BBox {
  return {
    west: (x0 / field.width) * 360 - 180,
    east: (x1 / field.width) * 360 - 180,
    north: 90 - (y0 / field.height) * 180,
    south: 90 - (y1 / field.height) * 180,
  };
}

function sampleGlobalFieldPixel(field: WorldField, lon: number, lat: number): number {
  let fx = Math.floor(((lon + 180) / 360) * field.width);
  let fy = Math.floor(((90 - lat) / 180) * field.height);
  if (fx < 0) fx = 0;
  if (fx >= field.width) fx = field.width - 1;
  if (fy < 0) fy = 0;
  if (fy >= field.height) fy = field.height - 1;
  return (fy * field.width + fx) * 4;
}

/**
 * Paint the visible portion of the planetary 0.05° field for a map frame. One
 * raster pixel per field cell so zoomed-in views show the true ~5 km grid instead
 * of upscaled tiles.
 */
export function fieldRasterForBounds(
  field: WorldField,
  bounds: BBox,
  hideIce: boolean,
  opacity: number,
): { raster: StudyRaster; bounds: BBox } | null {
  const { x0, x1, y0, y1 } = fieldCellIndices(field, bounds);
  if (x1 <= x0 || y1 <= y0) return null;

  const cols = x1 - x0;
  const rows = y1 - y0;
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  const alphaScale = Math.round(opacity * 255);

  for (let row = 0; row < rows; row++) {
    const fy = y0 + row;
    const lat = 90 - ((fy + 0.5) / field.height) * 180;
    for (let col = 0; col < cols; col++) {
      const fx = x0 + col;
      const lon = ((fx + 0.5) / field.width) * 360 - 180;
      const offset = sampleGlobalFieldPixel(field, lon, lat);
      const bandCode = field.data[offset];
      const out = (row * cols + col) * 4;
      if (bandCode === 0) continue;
      if (hideIce && field.data[offset + 2] > 0) continue;
      const band = bandCode - 1;
      const color = WORLD_BANDS[band].color;
      const alpha = Math.round((bandAlpha(band, WORLD_BANDS.length) / 255) * alphaScale);
      rgba[out] = color[0];
      rgba[out + 1] = color[1];
      rgba[out + 2] = color[2];
      rgba[out + 3] = alpha;
    }
  }

  return {
    raster: { width: cols, height: rows, rgba },
    bounds: fieldGeoBounds(field, x0, x1, y0, y1),
  };
}

export function sampleWorldField(
  field: WorldField,
  lon: number,
  lat: number,
  kmStep = 20,
): { kind: "water" } | { kind: "land"; band: number; km: number; ice: boolean } {
  const offset = sampleGlobalFieldPixel(field, lon, lat);
  const bandCode = field.data[offset];
  if (bandCode === 0) return { kind: "water" };
  return {
    kind: "land",
    band: bandCode - 1,
    km: Math.max(0, field.data[offset + 1] - 1) * kmStep,
    ice: field.data[offset + 2] > 0,
  };
}
