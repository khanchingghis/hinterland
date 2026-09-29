/**
 * Euclidean distance to the nearest seed on an anisotropic grid.
 *
 * This is the separable distance transform from Felzenszwalb & Huttenlocher
 * (2012), "Distance Transforms of Sampled Functions", with the column pass
 * taken from Meijster so empty columns stay at infinity instead of being
 * added into a squared-distance that overflows.
 *
 * `sx` and `sy` are the cell widths in meters. The result is meters.
 */

const EMPTY = 1e20;

export function distanceToFeatures(
  seeds: Uint8Array,
  width: number,
  height: number,
  sx: number,
  sy: number,
): Float32Array {
  if (width <= 0 || height <= 0) return new Float32Array();
  if (!(sx > 0) || !(sy > 0)) {
    throw new Error("Cell size must be positive");
  }

  const vertical = new Float32Array(width * height);
  for (let x = 0; x < width; x++) {
    let last = -1;
    for (let y = 0; y < height; y++) {
      if (seeds[y * width + x]) last = y;
      vertical[y * width + x] = last < 0 ? EMPTY : (y - last) * sy;
    }
    last = -1;
    for (let y = height - 1; y >= 0; y--) {
      if (seeds[y * width + x]) last = y;
      if (last >= 0) {
        const dist = (last - y) * sy;
        const i = y * width + x;
        if (dist < vertical[i]) vertical[i] = dist;
      }
    }
  }

  const out = new Float32Array(width * height);
  const position = new Float64Array(width);
  for (let x = 0; x < width; x++) position[x] = x * sx;

  const row = new Float64Array(width);
  const envelope = new Int32Array(width);
  const bound = new Float64Array(width + 1);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = vertical[y * width + x];
      row[x] = value >= EMPTY / 2 ? Number.POSITIVE_INFINITY : value;
    }
    transformRow(row, position, envelope, bound, out.subarray(y * width, (y + 1) * width));
  }

  return out;
}

function intersect(g: Float64Array, pos: Float64Array, i: number, j: number): number {
  const gi = g[i];
  const gj = g[j];
  const pi = pos[i];
  const pj = pos[j];
  return (gj * gj - gi * gi + (pj * pj - pi * pi)) / (2 * (pj - pi));
}

function transformRow(
  g: Float64Array,
  pos: Float64Array,
  envelope: Int32Array,
  bound: Float64Array,
  out: Float32Array,
): void {
  const n = g.length;
  let k = -1;

  for (let q = 0; q < n; q++) {
    if (!Number.isFinite(g[q])) continue;
    if (k < 0) {
      k = 0;
      envelope[0] = q;
      bound[0] = Number.NEGATIVE_INFINITY;
      bound[1] = Number.POSITIVE_INFINITY;
      continue;
    }
    let s = intersect(g, pos, envelope[k], q);
    while (s <= bound[k]) {
      k -= 1;
      if (k < 0) break;
      s = intersect(g, pos, envelope[k], q);
    }
    k += 1;
    envelope[k] = q;
    bound[k] = s;
    bound[k + 1] = Number.POSITIVE_INFINITY;
  }

  if (k < 0) {
    out.fill(Number.POSITIVE_INFINITY);
    return;
  }

  let index = 0;
  for (let q = 0; q < n; q++) {
    while (bound[index + 1] < pos[q]) index += 1;
    const dx = pos[q] - pos[envelope[index]];
    const gy = g[envelope[index]];
    out[q] = Math.hypot(dx, gy);
  }
}

export function assertDistanceTransform(): void {
  const almost = (actual: number, expected: number, label: string) => {
    const tolerance = Math.max(1e-2, Math.abs(expected) * 1e-6);
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
      throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
  };

  const horizontal = new Uint8Array(5);
  horizontal[2] = 1;
  const h = distanceToFeatures(horizontal, 5, 1, 1000, 1000);
  almost(h[2], 0, "seed");
  almost(h[1], 1000, "west");
  almost(h[3], 1000, "east");
  almost(h[0], 2000, "far west");
  almost(h[4], 2000, "far east");

  const vertical = new Uint8Array(5);
  vertical[2] = 1;
  const v = distanceToFeatures(vertical, 1, 5, 10, 5);
  almost(v[2], 0, "vertical seed");
  almost(v[0], 10, "north");
  almost(v[4], 10, "south");

  const grid = new Uint8Array(9);
  grid[4] = 1;
  const d = distanceToFeatures(grid, 3, 3, 10, 10);
  almost(d[4], 0, "center");
  almost(d[1], 10, "up");
  almost(d[3], 10, "left");
  almost(d[0], Math.SQRT2 * 10, "diagonal");

  const empty = distanceToFeatures(new Uint8Array(4), 2, 2, 10, 10);
  if (Number.isFinite(empty[0])) throw new Error("empty grid should be infinite");
}
