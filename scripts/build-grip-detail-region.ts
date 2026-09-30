/**
 * Export one regional high-zoom road overlay (0.012° simplify) when GRIP GDBs are present.
 * Usage: npx tsx scripts/build-grip-detail-region.ts 4
 */
import path from "node:path";
import { exportGripRegionSeq, gzipFile, gripGdbPath, writeWorldRoadsManifest, WORLD_ROADS_DIR } from "./grip-export";
import { GRIP_REGIONS } from "../src/lib/grip-inventory";
import { existsSync, unlinkSync } from "node:fs";

const DETAIL_SIMPLIFY = 0;
const DETAIL_MAX_ROAD_TYPE = 2;

const regionId = process.argv[2];
if (!regionId || !GRIP_REGIONS.some((r) => r.id === regionId)) {
  console.error("Usage: npx tsx scripts/build-grip-detail-region.ts <region-id 1-7>");
  process.exit(1);
}

const region = GRIP_REGIONS.find((r) => r.id === regionId)!;
const gdb = gripGdbPath(region.id);
if (!existsSync(gdb)) {
  console.error(`Missing ${gdb}. Download GRIP4_region${region.id} FGDB into data/raw/grip.`);
  process.exit(1);
}
const detailFile = region.detailFile ?? `grip-region-${region.id}-detail.ndjson.gz`;
const seq = path.join(WORLD_ROADS_DIR, `grip-region-${region.id}-detail.ndjson`);
const gz = path.join(WORLD_ROADS_DIR, detailFile);

console.log(
  `Exporting ${detailFile} (types 1–${DETAIL_MAX_ROAD_TYPE}, simplify ${DETAIL_SIMPLIFY === 0 ? "none" : DETAIL_SIMPLIFY})`,
);
exportGripRegionSeq(region.id, seq, DETAIL_SIMPLIFY, DETAIL_MAX_ROAD_TYPE);
gzipFile(seq, gz);
unlinkSync(seq);
writeWorldRoadsManifest();
console.log(`Wrote ${gz}`);
