export type Rgb = [number, number, number];

export type Band = {
  id: string;
  label: string;
  detail: string;
  /** Inclusive upper bound. The last band uses Infinity. */
  maxMeters: number;
  color: Rgb;
};

/**
 * Planetary classes. The world grid is ~5 km at the equator; the first bands
 * split the near-road corridor so dense GRIP networks do not read as one flat tone.
 */
export const WORLD_BANDS: Band[] = [
  {
    id: "verge",
    label: "Under 1 km",
    detail: "Right beside the mapped road network",
    maxMeters: 1_000,
    color: [252, 244, 228],
  },
  {
    id: "roadside",
    label: "1–5 km",
    detail: "Beside the mapped road network",
    maxMeters: 5_000,
    color: [245, 232, 196],
  },
  {
    id: "corridor",
    label: "5–10 km",
    detail: "In the road corridor",
    maxMeters: 10_000,
    color: [228, 196, 118],
  },
  {
    id: "near",
    label: "10–25 km",
    detail: "A short way off the mapped network",
    maxMeters: 25_000,
    color: [224, 168, 78],
  },
  {
    id: "half",
    label: "25–50 km",
    detail: "Beyond an easy detour",
    maxMeters: 50_000,
    color: [201, 106, 62],
  },
  {
    id: "stretch",
    label: "50–100 km",
    detail: "A long reach from the network",
    maxMeters: 100_000,
    color: [126, 148, 92],
  },
  {
    id: "far",
    label: "100–250 km",
    detail: "Hinterland",
    maxMeters: 250_000,
    color: [42, 140, 132],
  },
  {
    id: "remote",
    label: "250–500 km",
    detail: "Deep country",
    maxMeters: 500_000,
    color: [27, 86, 112],
  },
  {
    id: "wild",
    label: "Beyond 500 km",
    detail: "The far side of the mapped roads",
    maxMeters: Number.POSITIVE_INFINITY,
    color: [22, 32, 44],
  },
];

/** Classes for a local study, where streets make meters meaningful. */
export const LOCAL_BANDS: Band[] = [
  {
    id: "verge",
    label: "Under 50 m",
    detail: "On or beside the road",
    maxMeters: 50,
    color: [236, 214, 156],
  },
  {
    id: "block",
    label: "50–100 m",
    detail: "Across the street",
    maxMeters: 100,
    color: [232, 196, 112],
  },
  {
    id: "walk",
    label: "100–250 m",
    detail: "A short walk",
    maxMeters: 250,
    color: [224, 160, 70],
  },
  {
    id: "stroll",
    label: "250–500 m",
    detail: "A few blocks, or a field away",
    maxMeters: 500,
    color: [212, 114, 58],
  },
  {
    id: "km",
    label: "0.5–1 km",
    detail: "Out of the street grid",
    maxMeters: 1_000,
    color: [176, 86, 64],
  },
  {
    id: "near",
    label: "1–2 km",
    detail: "A neighborhood away",
    maxMeters: 2_000,
    color: [112, 138, 90],
  },
  {
    id: "out",
    label: "2–5 km",
    detail: "Clear of town",
    maxMeters: 5_000,
    color: [46, 138, 118],
  },
  {
    id: "far",
    label: "5–10 km",
    detail: "Open country",
    maxMeters: 10_000,
    color: [32, 112, 128],
  },
  {
    id: "remote",
    label: "10–25 km",
    detail: "A long way from these roads",
    maxMeters: 25_000,
    color: [26, 72, 104],
  },
  {
    id: "wild",
    label: "Beyond 25 km",
    detail: "Farther than this view's roads",
    maxMeters: Number.POSITIVE_INFINITY,
    color: [22, 32, 44],
  },
];

export function bandIndex(meters: number, bands: Band[]): number {
  for (let i = 0; i < bands.length; i++) {
    if (meters <= bands[i].maxMeters) return i;
  }
  return bands.length - 1;
}

export function bandAlpha(index: number, count: number): number {
  if (count <= 1) return 200;
  return Math.round(150 + (index / (count - 1)) * 90);
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function colorForMeters(
  meters: number,
  bands: Band[],
  mode: "bands" | "continuous",
): { rgb: Rgb; alpha: number; index: number } {
  const index = bandIndex(meters, bands);
  const alpha = bandAlpha(index, bands.length);
  if (mode === "bands" || !Number.isFinite(meters)) {
    return { rgb: bands[index].color, alpha, index };
  }

  const knots: { log: number; color: Rgb }[] = [];
  let previous = 8;
  for (let i = 0; i < bands.length; i++) {
    const edge = Number.isFinite(bands[i].maxMeters) ? bands[i].maxMeters : previous * 3;
    knots.push({ log: Math.log(Math.max(edge, 1)), color: bands[i].color });
    previous = edge;
  }
  const x = Math.log(Math.max(meters, 8));
  if (x <= knots[0].log) return { rgb: knots[0].color, alpha, index };
  for (let i = 1; i < knots.length; i++) {
    if (x <= knots[i].log) {
      const span = knots[i].log - knots[i - 1].log;
      const t = span === 0 ? 0 : (x - knots[i - 1].log) / span;
      return { rgb: lerpRgb(knots[i - 1].color, knots[i].color, t), alpha, index };
    }
  }
  return { rgb: knots[knots.length - 1].color, alpha, index };
}

export function textOn(rgb: Rgb): string {
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return luminance > 0.62 ? "#2a241c" : "#f6f1e7";
}
