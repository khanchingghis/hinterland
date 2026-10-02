/**
 * UK high-detail pack: one road file + matching distance field (~0.01° cells).
 * Run: npm run uk-pack
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GRIP_SOURCE } from "../src/lib/grip-inventory";
import {
  UK_ACTIVATION_BOUNDS,
  UK_PACK_BOUNDS,
  UK_PACK_MIN_ZOOM,
} from "../src/lib/uk-pack";
import { buildBoxDistanceFieldPng, type MaskFeature } from "./field-detail";
import {
  clipGripGzToBounds,
  exportGripBoundsSeq,
  gzipFile,
  gripGdbPath,
  WORLD_ROADS_DIR,
} from "./grip-export";

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data/raw");
const OUT_DIR = path.join(ROOT, "public/uk-pack");
const UK_RES = 0.01;
const UK_KM_STEP = 1;
const REGION4 = "4";
const REGION4_GZ = path.join(WORLD_ROADS_DIR, "grip-region-4.ndjson.gz");
const ROADS_OUT = "uk-roads.ndjson.gz";
const FIELD_OUT = "uk-field.png";

/** GRIP regional overlay simplify (see grip-export OVERLAY_SIMPLIFY). */
const CLIP_SIMPLIFY_DEG = 0.05;
/** Finer simplify when rebuilding from GDB (still GRIP types 1–4). */
const GDB_SIMPLIFY_DEG = 0.012;

function loadFeatures(file: string): MaskFeature[] {
  const json = JSON.parse(readFileSync(path.join(RAW, file), "utf8")) as {
    features: MaskFeature[];
  };
  return json.features;
}

async function buildUkRoads(): Promise<{ simplifyDeg: number; featureCount: number }> {
  const roadsGz = path.join(OUT_DIR, ROADS_OUT);
  const gdb = gripGdbPath(REGION4);
  if (existsSync(gdb)) {
    console.log(`exporting UK roads from ${gdb} (simplify ${GDB_SIMPLIFY_DEG}°)`);
    const seq = path.join(OUT_DIR, "uk-roads.ndjson");
    exportGripBoundsSeq(REGION4, seq, UK_PACK_BOUNDS, GDB_SIMPLIFY_DEG);
    gzipFile(seq, roadsGz);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(seq);
    const lines = readFileSync(roadsGz).length;
    console.log(`  ${ROADS_OUT} ${Math.round(lines / 1024)} KB gzip`);
    return { simplifyDeg: GDB_SIMPLIFY_DEG, featureCount: -1 };
  }

  if (!existsSync(REGION4_GZ)) {
    throw new Error(`Missing ${REGION4_GZ}. Commit regional GRIP exports or install GRIP4_region4.gdb.`);
  }
  console.log(`clipping ${REGION4_GZ} to UK pack bounds (simplify ${CLIP_SIMPLIFY_DEG}° from source)`);
  const kept = await clipGripGzToBounds(REGION4_GZ, roadsGz, UK_PACK_BOUNDS);
  console.log(`  ${ROADS_OUT} ${Math.round(readFileSync(roadsGz).length / 1024)} KB gzip (${kept} features)`);
  return { simplifyDeg: CLIP_SIMPLIFY_DEG, featureCount: kept };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const landPath = path.join(RAW, "ne_10m_land.geojson");
  const icePath = path.join(RAW, "ne_10m_glaciated_areas.geojson");
  if (!existsSync(landPath) || !existsSync(icePath)) {
    throw new Error(
      `Missing Natural Earth inputs in data/raw/. Download ne_10m_land.geojson and ne_10m_glaciated_areas.geojson (see README).`,
    );
  }

  const { simplifyDeg } = await buildUkRoads();
  const roadsGz = path.join(OUT_DIR, ROADS_OUT);
  const fieldPath = path.join(OUT_DIR, FIELD_OUT);

  console.log("building UK distance field from the same road file");
  await buildBoxDistanceFieldPng(
    UK_PACK_BOUNDS,
    UK_RES,
    roadsGz,
    fieldPath,
    loadFeatures("ne_10m_land.geojson"),
    loadFeatures("ne_10m_glaciated_areas.geojson"),
  );

  const manifest = {
    source: GRIP_SOURCE,
    roadTypes: "Highway through tertiary (GRIP types 1–4)",
    resolutionDeg: UK_RES,
    minZoom: UK_PACK_MIN_ZOOM,
    kmStep: UK_KM_STEP,
    bounds: UK_PACK_BOUNDS,
    activation: UK_ACTIVATION_BOUNDS,
    roadsFile: ROADS_OUT,
    fieldFile: FIELD_OUT,
    roadsSimplifyDeg: simplifyDeg,
  };
  writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("wrote public/uk-pack/manifest.json");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
