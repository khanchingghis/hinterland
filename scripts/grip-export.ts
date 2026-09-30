import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { finished } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";
import { GRIP_MAX_ROAD_TYPE, GRIP_REGIONS, gripRoadTypeLabel } from "../src/lib/grip-inventory";

const ROOT = path.resolve(__dirname, "..");
export const GRIP_RAW_DIR = path.join(ROOT, "data/raw/grip");
export const WORLD_ROADS_DIR = path.join(ROOT, "public/world-roads");

type Geometry = {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
};

export type GripFeature = {
  properties: Record<string, unknown>;
  geometry: Geometry | null;
};

function gripGdbPath(regionId: string): string {
  return path.join(GRIP_RAW_DIR, `GRIP4_region${regionId}.gdb`);
}

function gripLayerName(regionId: string): string {
  return `GRIP4_region${regionId}`;
}

export function assertGripRegionsPresent(): void {
  for (const region of GRIP_REGIONS) {
    const gdb = gripGdbPath(region.id);
    if (!existsSync(gdb)) {
      throw new Error(
        `Missing ${gdb}. Download GRIP4 regional FGDB zips into data/raw/grip (see README).`,
      );
    }
  }
}

function gripTypeSqlCase(): string {
  const parts: string[] = [];
  for (let code = 1; code <= GRIP_MAX_ROAD_TYPE; code++) {
    parts.push(`WHEN ${code} THEN '${gripRoadTypeLabel(code)}'`);
  }
  return `CASE GP_RTP ${parts.join(" ")} ELSE 'Other' END`;
}

export function exportGripRegionSeq(
  regionId: string,
  outPath: string,
  simplifyDeg: number,
): void {
  const gdb = gripGdbPath(regionId);
  const layer = gripLayerName(regionId);
  const sql = `SELECT ${gripTypeSqlCase()} AS type, * FROM ${layer} WHERE GP_RTP <= ${GRIP_MAX_ROAD_TYPE}`;
  execFileSync(
    "ogr2ogr",
    [
      "-f",
      "GeoJSONSeq",
      outPath,
      gdb,
      "-dialect",
      "SQLite",
      "-sql",
      sql,
      "-simplify",
      String(simplifyDeg),
      "-lco",
      "COORDINATE_PRECISION=5",
    ],
    { stdio: "inherit" },
  );
}

export function gzipFile(inPath: string, outPath: string): void {
  const raw = readFileSync(inPath);
  writeFileSync(outPath, gzipSync(raw, { level: 9 }));
}

export function writeWorldRoadsManifest(): void {
  mkdirSync(WORLD_ROADS_DIR, { recursive: true });
  const manifest = {
    source: "GRIP4 (Global Roads Inventory Project, Meijer et al. 2018, CC0)",
    roadTypes: "Highway through tertiary (GRIP types 1–4)",
    excluded: [
      "Ferry routes (not present in GRIP)",
      "Local/urban roads (GRIP type 5) omitted for bundle size",
    ],
    overviews: {
      highway: {
        file: "grip-overview-highway.ndjson.gz",
        maxZoom: 3,
        maxRoadType: 1,
      },
      major: {
        file: "grip-overview-major.ndjson.gz",
        maxZoom: 6,
        maxRoadType: 2,
      },
    },
    regions: GRIP_REGIONS.map(({ id, file, west, south, east, north }) => ({
      id,
      file,
      west,
      south,
      east,
      north,
    })),
  };
  writeFileSync(path.join(WORLD_ROADS_DIR, "manifest.json"), JSON.stringify(manifest));
}

export async function buildGripOverviewAssets(): Promise<void> {
  mkdirSync(WORLD_ROADS_DIR, { recursive: true });
  const regionGzFiles = GRIP_REGIONS.map((region) => path.join(WORLD_ROADS_DIR, region.file));
  for (const file of regionGzFiles) {
    if (!existsSync(file)) {
      throw new Error(`Missing ${file}. Run buildGripOverlayAssets first.`);
    }
  }
  for (const { label, maxRoadType, outFile } of [
    { label: "highway", maxRoadType: 1, outFile: "grip-overview-highway.ndjson.gz" },
    { label: "major", maxRoadType: 2, outFile: "grip-overview-major.ndjson.gz" },
  ]) {
    console.log(`  overview ${label} (GP_RTP <= ${maxRoadType})`);
    const seq = path.join(WORLD_ROADS_DIR, `grip-overview-${label}.ndjson`);
    const gz = path.join(WORLD_ROADS_DIR, outFile);
    const out = createWriteStream(seq, { encoding: "utf8" });
    for (const regionGz of regionGzFiles) {
      const lines = createInterface({
        input: createReadStream(regionGz).pipe(createGunzip()),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const feature = JSON.parse(trimmed) as GripFeature;
        const rtp = Number(feature.properties.GP_RTP ?? 99);
        if (rtp > maxRoadType) continue;
        out.write(`${trimmed}\n`);
      }
    }
    out.end();
    await finished(out);
    gzipFile(seq, gz);
    unlinkSync(seq);
    console.log(`    ${outFile} ${Math.round(readFileSize(gz) / 1024 / 1024)} MB`);
  }
  writeWorldRoadsManifest();
}

export async function rasterizeGripGzFile(
  gzPath: string,
  draw: (a: [number, number], b: [number, number]) => void,
  onFeature: (type: string, lengthKm: number) => void,
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(gzPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const feature = JSON.parse(trimmed) as GripFeature;
    const geometry = feature.geometry;
    if (!geometry) continue;
    const type = String(feature.properties.type ?? "Unknown");
    const rtp = Number(feature.properties.GP_RTP ?? 99);
    if (rtp > GRIP_MAX_ROAD_TYPE) continue;
    const lineStrings =
      geometry.type === "LineString"
        ? [geometry.coordinates as number[][]]
        : geometry.type === "MultiLineString"
          ? (geometry.coordinates as number[][][])
          : [];
    let lengthKm = 0;
    for (const coords of lineStrings) {
      for (let i = 0; i < coords.length - 1; i++) {
        const a: [number, number] = [coords[i][0], coords[i][1]];
        const b: [number, number] = [coords[i + 1][0], coords[i + 1][1]];
        const dLat = (b[1] - a[1]) * (Math.PI / 180);
        const dLon = (b[0] - a[0]) * (Math.PI / 180);
        const mid = (a[1] + b[1]) / 2;
        const mPerDegLat = 111_320;
        const mPerDegLon = 111_320 * Math.cos((mid * Math.PI) / 180);
        lengthKm += Math.hypot(dLon * mPerDegLon, dLat * mPerDegLat) / 1000;
        draw(a, b);
      }
    }
    if (lengthKm > 0) onFeature(type, lengthKm);
  }
}

export async function rasterizeGripSeqFile(
  seqPath: string,
  draw: (a: [number, number], b: [number, number]) => void,
  onFeature: (type: string, lengthKm: number) => void,
): Promise<void> {
  const stream = createReadStream(seqPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const feature = JSON.parse(trimmed) as GripFeature;
    const geometry = feature.geometry;
    if (!geometry) continue;
    const type = String(feature.properties.type ?? "Unknown");
    const lineStrings =
      geometry.type === "LineString"
        ? [geometry.coordinates as number[][]]
        : geometry.type === "MultiLineString"
          ? (geometry.coordinates as number[][][])
          : [];
    let lengthKm = 0;
    for (const coords of lineStrings) {
      for (let i = 0; i < coords.length - 1; i++) {
        const a: [number, number] = [coords[i][0], coords[i][1]];
        const b: [number, number] = [coords[i + 1][0], coords[i + 1][1]];
        const dLat = (b[1] - a[1]) * (Math.PI / 180);
        const dLon = (b[0] - a[0]) * (Math.PI / 180);
        const mid = (a[1] + b[1]) / 2;
        const mPerDegLat = 111_320;
        const mPerDegLon = 111_320 * Math.cos((mid * Math.PI) / 180);
        lengthKm += Math.hypot(dLon * mPerDegLon, dLat * mPerDegLat) / 1000;
        draw(a, b);
      }
    }
    if (lengthKm > 0) onFeature(type, lengthKm);
  }
}

export function buildGripOverlayAssets(): void {
  mkdirSync(WORLD_ROADS_DIR, { recursive: true });
  const OVERLAY_SIMPLIFY = 0.05;
  for (const region of GRIP_REGIONS) {
    const seq = path.join(WORLD_ROADS_DIR, `grip-region-${region.id}.ndjson`);
    const gz = path.join(WORLD_ROADS_DIR, region.file);
    console.log(`  overlay region ${region.id}`);
    exportGripRegionSeq(region.id, seq, OVERLAY_SIMPLIFY);
    gzipFile(seq, gz);
    unlinkSync(seq);
    console.log(`    ${region.file} ${Math.round(readFileSize(gz) / 1024 / 1024)} MB`);
  }
  writeWorldRoadsManifest();
}

function readFileSize(file: string): number {
  return readFileSync(file).length;
}
