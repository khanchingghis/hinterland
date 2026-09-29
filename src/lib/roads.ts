import { metersPerDegLat, metersPerDegLon } from "@/lib/geo/measure";

export type RoadGroup = {
  id: string;
  label: string;
  hint: string;
  highways: string[];
  defaultOn: boolean;
};

export const ROAD_GROUPS: RoadGroup[] = [
  {
    id: "motorway",
    label: "Motorways",
    hint: "Motorways and their ramps",
    highways: ["motorway", "motorway_link"],
    defaultOn: true,
  },
  {
    id: "trunk",
    label: "Trunk roads",
    hint: "The main roads that are not motorways",
    highways: ["trunk", "trunk_link"],
    defaultOn: true,
  },
  {
    id: "primary",
    label: "Primary",
    hint: "Main roads through a region",
    highways: ["primary", "primary_link"],
    defaultOn: true,
  },
  {
    id: "secondary",
    label: "Secondary",
    hint: "Connectors between towns",
    highways: ["secondary", "secondary_link"],
    defaultOn: true,
  },
  {
    id: "tertiary",
    label: "Tertiary",
    hint: "Smaller connectors",
    highways: ["tertiary", "tertiary_link"],
    defaultOn: true,
  },
  {
    id: "street",
    label: "Streets",
    hint: "Residential and unclassified streets",
    highways: ["residential", "unclassified", "living_street"],
    defaultOn: true,
  },
  {
    id: "service",
    label: "Service roads",
    hint: "Driveways, alleys, and access ways",
    highways: ["service"],
    defaultOn: false,
  },
  {
    id: "track",
    label: "Tracks",
    hint: "Unpaved tracks. They rewrite open country.",
    highways: ["track"],
    defaultOn: false,
  },
  {
    id: "path",
    label: "Paths",
    hint: "Footways, cycleways, and bridleways",
    highways: ["path", "footway", "cycleway", "bridleway"],
    defaultOn: false,
  },
];

const GROUP_BY_ID = new Map(ROAD_GROUPS.map((group) => [group.id, group]));

export const HIGHWAY_LABEL: Record<string, string> = {
  motorway: "motorway",
  motorway_link: "motorway link",
  trunk: "trunk road",
  trunk_link: "trunk link",
  primary: "primary road",
  primary_link: "primary link",
  secondary: "secondary road",
  secondary_link: "secondary link",
  tertiary: "tertiary road",
  tertiary_link: "tertiary link",
  residential: "residential street",
  unclassified: "unclassified road",
  living_street: "living street",
  service: "service road",
  track: "track",
  path: "path",
  footway: "footway",
  cycleway: "cycleway",
  bridleway: "bridleway",
};

export function highwayLabel(tag: string): string {
  return HIGHWAY_LABEL[tag] ?? tag.replaceAll("_", " ");
}

export function defaultGroupState(): Record<string, boolean> {
  return Object.fromEntries(ROAD_GROUPS.map((group) => [group.id, group.defaultOn]));
}

export function selectedGroupIds(state: Record<string, boolean>): string[] {
  return ROAD_GROUPS.filter((group) => state[group.id]).map((group) => group.id);
}

export function highwaysForGroups(groupIds: string[]): string[] {
  const values: string[] = [];
  for (const id of groupIds) {
    const group = GROUP_BY_ID.get(id);
    if (group) values.push(...group.highways);
  }
  return values;
}

export type BBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/** Wider views are allowed when the query leaves out street-level classes. */
export function maxSpanKm(groupIds: string[]): number {
  if (groupIds.some((id) => id === "street" || id === "service" || id === "path")) return 32;
  if (groupIds.some((id) => id === "secondary" || id === "tertiary" || id === "track")) return 110;
  return 340;
}

export function spanKm(box: BBox): number {
  const mid = (box.south + box.north) / 2;
  const width = Math.abs(box.east - box.west) * (metersPerDegLon(mid) / 1000);
  const height = Math.abs(box.north - box.south) * (metersPerDegLat(mid) / 1000);
  return Math.max(width, height);
}

export function spanLimitMessage(box: BBox, groupIds: string[]): string | null {
  if (groupIds.length === 0) return "Choose at least one kind of road.";
  const span = spanKm(box);
  const max = maxSpanKm(groupIds);
  if (span <= max) return null;
  return `This view is ${Math.round(span)} km across. These road classes are limited to ${max} km so OpenStreetMap can answer. Zoom in, or turn off streets, paths, and tracks.`;
}
