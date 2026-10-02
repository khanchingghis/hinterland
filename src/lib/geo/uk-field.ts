import { publicPath } from "@/lib/base-path";
import { WORLD_BANDS, bandAlpha } from "@/lib/bands";
import type { StudyRaster } from "@/lib/geo/paint";
import { fieldRasterForBounds, sampleWorldField, type WorldField } from "@/lib/geo/world-field";
import {
  UK_PACK_MIN_ZOOM,
  type UkPackManifest,
  pointInPack,
  viewportQualifiesForUkPack,
} from "@/lib/uk-pack";
import type { BBox } from "@/lib/roads";

export type UkDistanceField = WorldField & {
  resDeg: number;
  west: number;
  south: number;
  east: number;
  north: number;
};

let manifestPromise: Promise<UkPackManifest | null> | null = null;
let fieldPromise: Promise<UkDistanceField | null> | null = null;

export async function loadUkPackManifest(): Promise<UkPackManifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch(publicPath("/uk-pack/manifest.json"))
      .then((response) => (response.ok ? (response.json() as Promise<UkPackManifest>) : null))
      .catch(() => null);
  }
  return manifestPromise;
}

async function decodeUkFieldPng(manifest: UkPackManifest): Promise<UkDistanceField | null> {
  const response = await fetch(publicPath(`/uk-pack/${manifest.fieldFile}`));
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
  const { west, south, east, north } = manifest.bounds;
  return {
    width: canvas.width,
    height: canvas.height,
    data: image.data,
    resDeg: (east - west) / canvas.width,
    west,
    south,
    east,
    north,
  };
}

export async function ensureUkDistanceField(): Promise<UkDistanceField | null> {
  const manifest = await loadUkPackManifest();
  if (!manifest) return null;
  if (!fieldPromise) {
    fieldPromise = decodeUkFieldPng(manifest);
  }
  return fieldPromise;
}

function sampleUkFieldPixel(field: UkDistanceField, lon: number, lat: number): number {
  if (!pointInPack(lon, lat)) return -1;
  const fx = Math.floor((lon - field.west) / field.resDeg);
  const fy = Math.floor((field.north - lat) / field.resDeg);
  if (fx < 0 || fx >= field.width || fy < 0 || fy >= field.height) return -1;
  return (fy * field.width + fx) * 4;
}

function ukFieldRasterForBounds(
  field: UkDistanceField,
  bounds: BBox,
  hideIce: boolean,
  opacity: number,
): { raster: StudyRaster; bounds: BBox } | null {
  const west = Math.max(bounds.west, field.west);
  const east = Math.min(bounds.east, field.east);
  const south = Math.max(bounds.south, field.south);
  const north = Math.min(bounds.north, field.north);
  if (east <= west || north <= south) return null;

  const x0 = Math.max(0, Math.floor((west - field.west) / field.resDeg));
  const x1 = Math.min(field.width, Math.ceil((east - field.west) / field.resDeg));
  const y0 = Math.max(0, Math.floor((field.north - north) / field.resDeg));
  const y1 = Math.min(field.height, Math.ceil((field.north - south) / field.resDeg));
  if (x1 <= x0 || y1 <= y0) return null;

  const cols = x1 - x0;
  const rows = y1 - y0;
  const rgba = new Uint8ClampedArray(cols * rows * 4);
  const alphaScale = Math.round(opacity * 255);

  for (let row = 0; row < rows; row++) {
    const fy = y0 + row;
    const lat = field.north - (fy + 0.5) * field.resDeg;
    for (let col = 0; col < cols; col++) {
      const fx = x0 + col;
      const lon = field.west + (fx + 0.5) * field.resDeg;
      const offset = sampleUkFieldPixel(field, lon, lat);
      const out = (row * cols + col) * 4;
      if (offset < 0) continue;
      const bandCode = field.data[offset];
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
    bounds: {
      west: field.west + x0 * field.resDeg,
      east: field.west + x1 * field.resDeg,
      north: field.north - y0 * field.resDeg,
      south: field.north - y1 * field.resDeg,
    },
  };
}

/**
 * Paint the viewport distance layer: UK pack cells inside the pack bbox, global field elsewhere.
 */
export function compositeFieldRasterForBounds(
  globalField: WorldField,
  ukField: UkDistanceField | null,
  viewBounds: BBox,
  zoom: number,
  hideIce: boolean,
  opacity: number,
): { raster: StudyRaster; bounds: BBox } | null {
  const useUk = ukField && viewportQualifiesForUkPack(viewBounds, zoom);
  if (!useUk) {
    return fieldRasterForBounds(globalField, viewBounds, hideIce, opacity);
  }

  const globalPart = fieldRasterForBounds(globalField, viewBounds, hideIce, opacity);
  const ukPart = ukFieldRasterForBounds(ukField, viewBounds, hideIce, opacity);
  if (!globalPart && !ukPart) return null;
  if (!ukPart) return globalPart;
  if (!globalPart) return ukPart;

  const painted = globalPart.raster;
  const uk = ukPart.raster;
  const gb = globalPart.bounds;
  const ub = ukPart.bounds;

  const cols = painted.width;
  const rows = painted.height;
  for (let row = 0; row < rows; row++) {
    const lat = gb.north - ((row + 0.5) / rows) * (gb.north - gb.south);
    for (let col = 0; col < cols; col++) {
      const lon = gb.west + ((col + 0.5) / cols) * (gb.east - gb.west);
      if (!pointInPack(lon, lat)) continue;
      if (lon < ub.west || lon > ub.east || lat < ub.south || lat > ub.north) continue;
      const ukCol = Math.floor(((lon - ub.west) / (ub.east - ub.west)) * uk.width);
      const ukRow = Math.floor(((ub.north - lat) / (ub.north - ub.south)) * uk.height);
      if (ukCol < 0 || ukCol >= uk.width || ukRow < 0 || ukRow >= uk.height) continue;
      const ukOffset = (ukRow * uk.width + ukCol) * 4;
      if (uk.rgba[ukOffset + 3] === 0) continue;
      const out = (row * cols + col) * 4;
      painted.rgba[out] = uk.rgba[ukOffset];
      painted.rgba[out + 1] = uk.rgba[ukOffset + 1];
      painted.rgba[out + 2] = uk.rgba[ukOffset + 2];
      painted.rgba[out + 3] = uk.rgba[ukOffset + 3];
    }
  }

  return { raster: painted, bounds: gb };
}

export function sampleCompositeWorldField(
  globalField: WorldField,
  ukField: UkDistanceField | null,
  lon: number,
  lat: number,
  zoom: number,
  globalKmStep = 20,
  ukKmStep = 1,
): ReturnType<typeof sampleWorldField> {
  if (ukField && zoom >= UK_PACK_MIN_ZOOM && pointInPack(lon, lat)) {
    const offset = sampleUkFieldPixel(ukField, lon, lat);
    if (offset >= 0) {
      const bandCode = ukField.data[offset];
      if (bandCode === 0) return { kind: "water" };
      return {
        kind: "land",
        band: bandCode - 1,
        km: Math.max(0, ukField.data[offset + 1] - 1) * ukKmStep,
        ice: ukField.data[offset + 2] > 0,
      };
    }
  }
  return sampleWorldField(globalField, lon, lat, globalKmStep);
}
