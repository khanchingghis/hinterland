import { colorForMeters, type Band } from "@/lib/bands";
import type { LocalGrid } from "@/lib/geo/local";

/** One pixel per distance cell. Row 0 is the north edge. */
export type StudyRaster = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

/**
 * Paint the distance grid into an image the map can stretch over the study
 * bounds. A canvas overlay uses this instead of map polygons, which disappear
 * once the camera is closer than the world tiles.
 */
export function gridToRaster(
  grid: LocalGrid,
  bands: Band[],
  mode: "bands" | "continuous",
  isolate: string | null,
): StudyRaster {
  const rgba = new Uint8ClampedArray(grid.cols * grid.rows * 4);
  for (let index = 0; index < grid.cols * grid.rows; index++) {
    const painted = colorForMeters(grid.meters[index], bands, mode);
    const bandId = bands[painted.index].id;
    const alpha = isolate && isolate !== bandId ? painted.alpha * 0.14 : painted.alpha;
    const offset = index * 4;
    rgba[offset] = painted.rgb[0];
    rgba[offset + 1] = painted.rgb[1];
    rgba[offset + 2] = painted.rgb[2];
    rgba[offset + 3] = Math.round(alpha);
  }
  return { width: grid.cols, height: grid.rows, rgba };
}
