export type AreaShare = {
  id: string;
  km2: number;
  share: number;
};

export type SampleReading = {
  id: string;
  name: string;
  region: string;
  lon: number;
  lat: number;
  zoom: number;
  land: boolean;
  ice: boolean;
  /** Straight-line kilometers, rounded. Null when the point is not on land. */
  km: number | null;
  bandId: string | null;
};

export type WorldMeta = {
  resolutionDeg: number;
  cols: number;
  rows: number;
  /** Kilometers per step stored in the field image's green channel. */
  kmStep: number;
  tileMaxZoom: number;
  roads: {
    source: string;
    excluded: string[];
    countsByType: Record<string, number>;
    kmByType: Record<string, number>;
  };
  landKm2: number;
  iceKm2: number;
  areaWithIce: AreaShare[];
  areaNoIce: AreaShare[];
  samples: SampleReading[];
};
