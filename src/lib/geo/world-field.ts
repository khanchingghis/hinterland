import { WORLD_BANDS, bandAlpha } from "@/lib/bands";
import type { GeoWorldField } from "@/lib/geo/world-field-detail";
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

function sampleFieldPixels(
  field: WorldField,
  detailLayers: GeoWorldField[],
  lon: number,
  lat: number,
): { data: Uint8ClampedArray; offset: number } {
  for (const layer of detailLayers) {
    if (lon < layer.west || lon > layer.east || lat < layer.south || lat > layer.north) continue;
    const x = Math.floor((lon - layer.west) / layer.resDeg);
    const y = Math.floor((layer.north - lat) / layer.resDeg);
    if (x < 0 || x >= layer.width || y < 0 || y >= layer.height) continue;
    return { data: layer.data, offset: (y * layer.width + x) * 4 };
  }
  let fx = Math.floor(((lon + 180) / 360) * field.width);
  let fy = Math.floor(((90 - lat) / 180) * field.height);
  if (fx < 0) fx = 0;
  if (fx >= field.width) fx = field.width - 1;
  if (fy < 0) fy = 0;
  if (fy >= field.height) fy = field.height - 1;
  return { data: field.data, offset: (fy * field.width + fx) * 4 };
}

/**
 * Paint the visible portion of the world field for a map frame. One raster pixel
 * per field cell (or per loaded regional detail cell) so city zoom shows true grid
 * spacing instead of upscaled tiles.
 */
export function fieldRasterForBounds(
  field: WorldField,
  bounds: BBox,
  hideIce: boolean,
  opacity: number,
  detailLayers: GeoWorldField[] = [],
): { raster: StudyRaster; bounds: BBox } | null {
  const globalRes = 360 / field.width;
  const resDeg =
    detailLayers.length > 0
      ? Math.min(globalRes, ...detailLayers.map((layer) => layer.resDeg))
      : globalRes;

  const x0 = Math.max(0, Math.floor((bounds.west + 180) / resDeg));
  const x1 = Math.min(Math.ceil(360 / resDeg), Math.ceil((bounds.east + 180) / resDeg));
  const y0 = Math.max(0, Math.floor((90 - bounds.north) / resDeg));
  const y1 = Math.min(Math.ceil(180 / resDeg), Math.ceil((90 - bounds.south) / resDeg));
  if (x1 <= x0 || y1 <= y0) return null;

  const cols = x1 - x0;
  const rows = y1 - y0;
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  const alphaScale = Math.round(opacity * 255);
  const sortedDetails = [...detailLayers].sort((a, b) => a.resDeg - b.resDeg);

  for (let row = 0; row < rows; row++) {
    const lat = 90 - (y0 + row + 0.5) * resDeg;
    for (let col = 0; col < cols; col++) {
      const lon = (x0 + col + 0.5) * resDeg - 180;
      const { data, offset } = sampleFieldPixels(field, sortedDetails, lon, lat);
      const bandCode = data[offset];
      const out = (row * cols + col) * 4;
      if (bandCode === 0) continue;
      if (hideIce && data[offset + 2] > 0) continue;
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
    bounds: {
      west: x0 * resDeg - 180,
      east: x1 * resDeg - 180,
      north: 90 - y0 * resDeg,
      south: 90 - y1 * resDeg,
    },
  };
}

export function sampleWorldField(
  field: WorldField,
  lon: number,
  lat: number,
  kmStep = 20,
): { kind: "water" } | { kind: "land"; band: number; km: number; ice: boolean } {
  let x = Math.floor(((lon + 180) / 360) * field.width);
  let y = Math.floor(((90 - lat) / 180) * field.height);
  if (x < 0) x = 0;
  if (x >= field.width) x = field.width - 1;
  if (y < 0) y = 0;
  if (y >= field.height) y = field.height - 1;
  const offset = (y * field.width + x) * 4;
  const bandCode = field.data[offset];
  if (bandCode === 0) return { kind: "water" };
  return {
    kind: "land",
    band: bandCode - 1,
    km: Math.max(0, field.data[offset + 1] - 1) * kmStep,
    ice: field.data[offset + 2] > 0,
  };
}
