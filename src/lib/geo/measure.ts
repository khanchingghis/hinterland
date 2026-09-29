export type LonLat = [number, number];

/** Meters in one degree of latitude at `latDeg` (WGS84 meridional radius). */
export function metersPerDegLat(latDeg: number): number {
  const lat = (latDeg * Math.PI) / 180;
  return (
    111132.92 -
    559.82 * Math.cos(2 * lat) +
    1.175 * Math.cos(4 * lat) -
    0.0023 * Math.cos(6 * lat)
  );
}

/** Meters in one degree of longitude at `latDeg`. */
export function metersPerDegLon(latDeg: number): number {
  const lat = (latDeg * Math.PI) / 180;
  return 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat) + 0.118 * Math.cos(5 * lat);
}

/**
 * Split a segment that takes the short way across the antimeridian.
 * A naive line from 179° to −179° would otherwise streak across the planet.
 */
export function splitDateLine(a: LonLat, b: LonLat): [LonLat, LonLat][] {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const delta = lon2 - lon1;
  if (Math.abs(delta) <= 180) return [[a, b]];

  if (delta < -180) {
    const span = lon2 + 360 - lon1;
    const t = span === 0 ? 0 : (180 - lon1) / span;
    const lat = lat1 + t * (lat2 - lat1);
    return [
      [
        [lon1, lat1],
        [180, lat],
      ],
      [
        [-180, lat],
        [lon2, lat2],
      ],
    ];
  }

  const span = lon2 - 360 - lon1;
  const t = span === 0 ? 0 : (-180 - lon1) / span;
  const lat = lat1 + t * (lat2 - lat1);
  return [
    [
      [lon1, lat1],
      [-180, lat],
    ],
    [
      [180, lat],
      [lon2, lat2],
    ],
  ];
}

export function assertMeasure(): void {
  const east = splitDateLine([170, 0], [-170, 10]);
  if (east.length !== 2) throw new Error("date line split failed");
  if (Math.abs(east[0][1][0] - 180) > 1e-6) throw new Error("east split did not hit +180");
  if (Math.abs(east[1][0][0] + 180) > 1e-6) throw new Error("east split did not restart at -180");
  if (Math.abs(east[0][1][1] - 5) > 1e-6) throw new Error("east split latitude");

  const west = splitDateLine([-170, 0], [170, 10]);
  if (Math.abs(west[0][1][0] + 180) > 1e-6) throw new Error("west split did not hit -180");
  if (Math.abs(west[1][0][0] - 180) > 1e-6) throw new Error("west split did not restart at +180");

  const plain = splitDateLine([0, 0], [1, 1]);
  if (plain.length !== 1) throw new Error("short segment should stay whole");

  const equator = metersPerDegLon(0);
  if (equator < 110_000 || equator > 112_000) throw new Error(`bad equatorial degree: ${equator}`);
  const polar = metersPerDegLon(80);
  if (!(polar < equator * 0.25)) throw new Error("longitude should shrink toward the pole");
}
