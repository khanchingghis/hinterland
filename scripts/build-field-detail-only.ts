/**
 * Build regional high-zoom field PNGs without recomputing the global raster.
 * Run: npx tsx scripts/build-field-detail-only.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildRegionalFieldDetails, fieldDetailMetaForWorldMeta } from "./field-detail";
import type { WorldMeta } from "../src/lib/world-types";

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data/raw");

async function ensureNaturalEarthRaw(): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  const sources: Record<string, string> = {
    "ne_10m_land.geojson":
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson",
    "ne_10m_glaciated_areas.geojson":
      "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_glaciated_areas.geojson",
  };
  for (const [file, url] of Object.entries(sources)) {
    const dest = path.join(RAW, file);
    if (existsSync(dest)) continue;
    console.log(`  downloading ${file}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url} (${response.status}).`);
    writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  }
}

function loadFeatures(file: string) {
  const json = JSON.parse(readFileSync(path.join(RAW, file), "utf8")) as {
    features: unknown[];
  };
  return json.features;
}

async function main(): Promise<void> {
  await ensureNaturalEarthRaw();
  const land = loadFeatures("ne_10m_land.geojson");
  const ice = loadFeatures("ne_10m_glaciated_areas.geojson");
  console.log("building regional field detail assets");
  const regions = await buildRegionalFieldDetails(land as never, ice as never);
  const metaPath = path.join(ROOT, "public/world-meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as WorldMeta;
  meta.fieldDetail = fieldDetailMetaForWorldMeta(regions);
  writeFileSync(metaPath, JSON.stringify(meta));
  console.log("updated world-meta.json fieldDetail");
}

void main();
