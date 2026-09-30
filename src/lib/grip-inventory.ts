/** GRIP4 road-type codes (UNSDI); types 1–4 are used for the world layer. */
export const GRIP_MAX_ROAD_TYPE = 4;

export const GRIP_SOURCE =
  "GRIP4 (Global Roads Inventory Project, Meijer et al. 2018, CC0)";

export const GRIP_ROAD_TYPE_LABEL: Record<number, string> = {
  1: "Highway",
  2: "Primary",
  3: "Secondary",
  4: "Tertiary",
  5: "Local",
};

export function gripRoadTypeLabel(code: number): string {
  return GRIP_ROAD_TYPE_LABEL[code] ?? `Type ${code}`;
}

export type GripRegionMeta = {
  id: string;
  file: string;
  /** Higher-zoom overlay (finer simplify); optional until rebuilt from GRIP GDBs. */
  detailFile?: string;
  west: number;
  south: number;
  east: number;
  north: number;
};

/** Loose bounds for lazy-loading overlay tiles (regions overlap at edges). */
export const GRIP_REGIONS: GripRegionMeta[] = [
  {
    id: "1",
    file: "grip-region-1.ndjson.gz",
    west: -167,
    south: 17,
    east: -52,
    north: 72,
  },
  {
    id: "2",
    file: "grip-region-2.ndjson.gz",
    west: -118,
    south: -56,
    east: -32,
    north: 33,
  },
  {
    id: "3",
    file: "grip-region-3.ndjson.gz",
    west: -26,
    south: -38,
    east: 58,
    north: 38,
  },
  {
    id: "4",
    file: "grip-region-4.ndjson.gz",
    detailFile: "grip-region-4-detail.ndjson.gz",
    west: -25,
    south: 5,
    east: 106,
    north: 72,
  },
  {
    id: "5",
    file: "grip-region-5.ndjson.gz",
    west: -180,
    south: 12,
    east: 180,
    north: 74,
  },
  {
    id: "6",
    file: "grip-region-6.ndjson.gz",
    west: 60,
    south: -11,
    east: 156,
    north: 54,
  },
  {
    id: "7",
    file: "grip-region-7.ndjson.gz",
    west: -180,
    south: -50,
    east: 180,
    north: 16,
  },
];

export const GRIP_EXCLUDED_NOTE =
  "GRIP local/urban roads (type 5) are omitted so the static bundle stays GitHub Pages–friendly; highway through tertiary (types 1–4) drive the world layer.";
