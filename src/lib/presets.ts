import type { BBox } from "@/lib/roads";

export type WorldPreset = {
  kind: "world";
  id: string;
  name: string;
  center: [number, number];
  zoom: number;
};

export type StudyPreset = {
  kind: "study";
  id: string;
  name: string;
  blurb: string;
  bounds: BBox;
  groups: string[];
};

export type Preset = WorldPreset | StudyPreset;

export const WORLD_PRESETS: WorldPreset[] = [
  { kind: "world", id: "earth", name: "Whole earth", center: [12, 16], zoom: 1.4 },
  { kind: "world", id: "sahara", name: "Sahara", center: [10, 22], zoom: 4.1 },
  { kind: "world", id: "amazon", name: "Amazon", center: [-63, -5], zoom: 4.2 },
  { kind: "world", id: "australia", name: "Australia", center: [134, -25], zoom: 4 },
  { kind: "world", id: "europe", name: "Europe", center: [10, 50], zoom: 3.8 },
  { kind: "world", id: "siberia", name: "Siberia", center: [100, 64], zoom: 3.4 },
];

export const STUDY_PRESETS: StudyPreset[] = [
  {
    kind: "study",
    id: "manhattan",
    name: "Manhattan",
    blurb: "A street grid. Almost nothing is far.",
    bounds: { west: -74.018, south: 40.7, east: -73.972, north: 40.8 },
    groups: ["motorway", "trunk", "primary", "secondary", "tertiary", "street"],
  },
  {
    kind: "study",
    id: "cairngorms",
    name: "Cairngorms",
    blurb: "Highland plateau. Tracks matter here.",
    bounds: { west: -3.78, south: 57.02, east: -3.48, north: 57.16 },
    groups: ["trunk", "primary", "secondary", "tertiary", "street", "track"],
  },
  {
    kind: "study",
    id: "iceland",
    name: "Icelandic highlands",
    blurb: "Interior routes, with the towns left out.",
    bounds: { west: -19.35, south: 64.45, east: -17.55, north: 65.05 },
    groups: ["trunk", "primary", "secondary", "tertiary", "track"],
  },
  {
    kind: "study",
    id: "nullarbor",
    name: "Nullarbor",
    blurb: "One highway across a plain.",
    bounds: { west: 128.7, south: -31.85, east: 130.35, north: -31.05 },
    groups: ["motorway", "trunk", "primary"],
  },
];
