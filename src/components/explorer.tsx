"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ChevronDown, ChevronUp, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MapStage, type MapStageHandle } from "@/components/map-stage";
import {
  LOCAL_BANDS,
  WORLD_BANDS,
  bandIndex,
  textOn,
  type Band,
} from "@/lib/bands";
import { formatDistance, formatKm2, formatShare } from "@/lib/format";
import { buildStudy, nearestRoad, sampleGrid, type LocalGrid, type RoadLine } from "@/lib/geo/local";
import { gridToRaster } from "@/lib/geo/paint";
import { fetchRoads } from "@/lib/overpass";
import { STUDY_PRESETS, WORLD_PRESETS, type Preset } from "@/lib/presets";
import { publicPath } from "@/lib/base-path";
import {
  ROAD_GROUPS,
  defaultGroupState,
  highwayLabel,
  selectedGroupIds,
  spanKm,
  spanLimitMessage,
  type BBox,
} from "@/lib/roads";
import { sampleWorldField, type WorldField } from "@/lib/geo/world-field";
import { preloadWorldRoadsManifest } from "@/lib/world-roads";
import type { AreaShare, WorldMeta } from "@/lib/world-types";

type LegendMode = "world" | "study";
type ColorMode = "bands" | "continuous";

type StudyState = {
  shares: { id: string; share: number }[];
  segments: number;
  cellM: number;
  requestedCellM: number;
  cols: number;
  rows: number;
  ms: number;
  signature: string;
};

const FAR_IDS = ["far", "remote", "wild"];
const GUIDE_STORAGE_KEY = "hinterland-guide-open";
const WORLD_ROADS_STORAGE_KEY = "hinterland-show-world-roads";

export function Explorer() {
  const mapRef = useRef<MapStageHandle>(null);
  const gridRef = useRef<LocalGrid | null>(null);
  const roadsRef = useRef<RoadLine[]>([]);
  const fieldRef = useRef<WorldField | null>(null);
  const [worldField, setWorldField] = useState<WorldField | null>(null);
  const hoverRef = useRef("");
  const [meta, setMeta] = useState<WorldMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [hideIce, setHideIce] = useState(false);
  const [worldRoadsLoading, setWorldRoadsLoading] = useState(false);
  const [showWorldRoads, setShowWorldRoads] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(WORLD_ROADS_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [opacity, setOpacity] = useState(86);
  const [groups, setGroups] = useState(defaultGroupState);
  const [cellM, setCellM] = useState(70);
  const [colorMode, setColorMode] = useState<ColorMode>("bands");
  const [isolate, setIsolate] = useState<string | null>(null);
  const [legend, setLegend] = useState<LegendMode>("world");
  const [view, setView] = useState<BBox | null>(null);
  const [study, setStudy] = useState<StudyState | null>(null);
  const [status, setStatus] = useState<"idle" | "loading">("idle");
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState("Move across the map");
  const [fieldReady, setFieldReady] = useState(false);
  const [guideOpen, setGuideOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem(GUIDE_STORAGE_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [isWide, setIsWide] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 960px)");
    const onChange = () => setIsWide(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setGuideOpenPersisted = useCallback((open: boolean) => {
    setGuideOpen(open);
    try {
      localStorage.setItem(GUIDE_STORAGE_KEY, String(open));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const setShowWorldRoadsPersisted = useCallback((on: boolean) => {
    setShowWorldRoads(on);
    try {
      localStorage.setItem(WORLD_ROADS_STORAGE_KEY, String(on));
    } catch {
      /* storage unavailable */
    }
  }, []);

  const guideBottomInset = isWide ? 16 : guideOpen ? 220 : 56;
  const worldTileMaxZoom = meta?.tileMaxZoom ?? 6;

  useEffect(() => {
    let cancelled = false;
    fetch(publicPath("/world-meta.json"))
      .then((response) => {
        if (!response.ok) throw new Error("missing");
        return response.json() as Promise<WorldMeta>;
      })
      .then((body) => {
        if (!cancelled) setMeta(body);
      })
      .catch(() => {
        if (!cancelled) setMetaError("The world summary did not load.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void preloadWorldRoadsManifest();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await fetch(publicPath("/world-field.png"));
      if (!response.ok) return;
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      if (cancelled) return;
      const loaded = { width: canvas.width, height: canvas.height, data: image.data };
      fieldRef.current = loaded;
      setWorldField(loaded);
      setFieldReady(true);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const grid = gridRef.current;
    const map = mapRef.current;
    if (!grid || !map || !study) return;
    map.setStudy(gridToRaster(grid, LOCAL_BANDS, colorMode, isolate), {
      west: grid.west,
      south: grid.south,
      east: grid.east,
      north: grid.north,
    });
  }, [colorMode, isolate, study]);

  const groupIds = selectedGroupIds(groups);
  const signature = `${groupIds.join(",")}|${cellM}`;
  const viewMessage = view ? spanLimitMessage(view, groupIds) : null;
  const dirty = study != null && study.signature !== signature;

  const worldShares = hideIce ? meta?.areaNoIce : meta?.areaWithIce;
  const beyondHundred = shareOf(worldShares, FAR_IDS);

  const roadMix = useMemo(() => {
    if (!meta) return [];
    const entries = Object.entries(meta.roads.kmByType).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, entry) => sum + entry[1], 0) || 1;
    return entries.map(([type, km]) => ({
      type: roadTypeLabel(type),
      share: km / total,
      km,
    }));
  }, [meta]);

  function rememberHover(text: string) {
    if (hoverRef.current === text) return;
    hoverRef.current = text;
    setHover(text);
  }

  function describePointer(lngLat: { lng: number; lat: number }): { title: string; body: string } | null {
    const grid = gridRef.current;
    if (grid) {
      const meters = sampleGrid(grid, lngLat.lng, lngLat.lat);
      if (meters != null) {
        const band = LOCAL_BANDS[bandIndex(meters, LOCAL_BANDS)];
        return {
          title: formatDistance(meters),
          body: `${band.label} from the nearest selected road`,
        };
      }
    }
    const field = fieldRef.current;
    if (!field) return null;
    const sample = sampleWorldField(field, lngLat.lng, lngLat.lat, meta?.kmStep ?? 20);
    if (sample.kind === "water") return { title: "Open water", body: "Ocean is left unpainted" };
    if (hideIce && sample.ice) return { title: "Ice sheet", body: "Hidden on this layer" };
    const band = WORLD_BANDS[sample.band];
    const km = sample.km;
    return {
      title: band.label,
      body:
        km < 20
          ? "Under 20 km from a mapped road in this layer"
          : `About ${km.toLocaleString("en-US")} km from a mapped road in this layer`,
    };
  }

  function handleHover(lngLat: { lng: number; lat: number }) {
    const described = describePointer(lngLat);
    if (!described) {
      rememberHover(fieldReady ? "Open water" : "Loading the world grid…");
      return;
    }
    rememberHover(`${described.title} · ${described.body}`);
  }

  function handleClick(lngLat: { lng: number; lat: number }) {
    const grid = gridRef.current;
    if (grid) {
      const meters = sampleGrid(grid, lngLat.lng, lngLat.lat);
      if (meters != null) {
        const nearest = nearestRoad(roadsRef.current, lngLat.lng, lngLat.lat);
        const band = LOCAL_BANDS[bandIndex(meters, LOCAL_BANDS)];
        mapRef.current?.showNote({
          lng: lngLat.lng,
          lat: lngLat.lat,
          title: formatDistance(meters),
          body: nearest
            ? `${band.label} from a ${highwayLabel(nearest.highway)}`
            : band.detail,
        });
        return;
      }
    }
    const described = describePointer(lngLat);
    if (!described) return;
    mapRef.current?.showNote({
      lng: lngLat.lng,
      lat: lngLat.lat,
      title: described.title,
      body: described.body,
    });
  }

  async function runStudy(box: BBox, state: Record<string, boolean>, requestedCell: number) {
    const ids = selectedGroupIds(state);
    const limit = spanLimitMessage(box, ids);
    if (limit) {
      setError(limit);
      setStatus("idle");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(null);
    setStatusText("Fetching roads from OpenStreetMap…");
    try {
      const segments = await fetchRoads(box, ids, controller.signal);
      if (controller.signal.aborted) return;
      setStatusText("Measuring distance to the nearest road…");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const measured = buildStudy(segments, box, requestedCell, LOCAL_BANDS);
      const grid = measured.grid;
      gridRef.current = grid;
      roadsRef.current = segments;
      mapRef.current?.setStudy(gridToRaster(grid, LOCAL_BANDS, colorMode, null), box);
      setIsolate(null);
      setStudy({
        shares: measured.shares,
        segments: segments.length,
        cellM: grid.cellM,
        requestedCellM: requestedCell,
        cols: grid.cols,
        rows: grid.rows,
        ms: measured.ms,
        signature: `${ids.join(",")}|${requestedCell}`,
      });
      setLegend("study");
      setStatus("idle");
      setStatusText("");
    } catch (caught) {
      if (controller.signal.aborted) return;
      setStatus("idle");
      setStatusText("");
      setError(caught instanceof Error ? caught.message : "The study failed.");
    }
  }

  function applyPreset(preset: Preset) {
    if (preset.kind === "world") {
      mapRef.current?.flyTo(preset.center, preset.zoom);
      setLegend("world");
      return;
    }
    const next = defaultGroupState();
    for (const group of ROAD_GROUPS) next[group.id] = preset.groups.includes(group.id);
    setGroups(next);
    mapRef.current?.fit(preset.bounds);
    void runStudy(preset.bounds, next, cellM);
  }

  function clearStudy() {
    abortRef.current?.abort();
    gridRef.current = null;
    roadsRef.current = [];
    mapRef.current?.clearStudy();
    setStudy(null);
    setIsolate(null);
    setLegend("world");
    setStatus("idle");
    setStatusText("");
    setError(null);
  }

  const activeBands = legend === "study" ? LOCAL_BANDS : WORLD_BANDS;
  const activeShares =
    legend === "study"
      ? study?.shares
      : worldShares?.map((share) => ({ id: share.id, share: share.share }));

  return (
    <div className="relative h-dvh overflow-hidden bg-[#d4cec2] text-[#2a241c]">
      <MapStage
        ref={mapRef}
        hideIce={hideIce}
        opacity={opacity / 100}
        showWorldRoads={showWorldRoads}
        worldField={worldField}
        worldTileMaxZoom={worldTileMaxZoom}
        studyActive={study != null}
        guideBottomInset={guideBottomInset}
        onView={setView}
        onHover={handleHover}
        onClick={handleClick}
        onWorldRoadsLoadingChange={setWorldRoadsLoading}
      />

      <div className="pointer-events-none absolute top-4 left-1/2 z-10 max-w-[min(92vw,420px)] -translate-x-1/2 rounded-full border border-black/10 bg-[#f6f1e7]/92 px-3 py-1.5 text-center text-xs shadow-sm backdrop-blur-md md:left-[calc(50%+186px)]">
        <p className="tabular-nums">{hover}</p>
      </div>

      {!guideOpen && (
        <div className="absolute z-20 flex flex-col gap-2 bottom-3 left-3 md:top-3 md:bottom-auto">
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border border-black/10 bg-[#f6f1e7]/95 px-3 py-2 text-sm font-medium text-[#241c14] shadow-md backdrop-blur-md"
            onClick={() => setGuideOpenPersisted(true)}
            aria-expanded={false}
            aria-label="Open map guide and legend"
          >
            <PanelLeftOpen className="size-4 shrink-0" aria-hidden />
            Guide
          </button>
          <label className="flex cursor-pointer items-center gap-2 rounded-full border border-black/10 bg-[#f6f1e7]/95 px-3 py-2 text-sm text-[#241c14] shadow-md backdrop-blur-md">
            <Switch
              checked={showWorldRoads}
              onCheckedChange={setShowWorldRoadsPersisted}
              disabled={study != null}
              aria-label="Show roads used for world distance"
            />
            <span className="font-medium">Roads used</span>
          </label>
        </div>
      )}

      {guideOpen && (
      <aside className="absolute inset-x-3 bottom-3 z-20 flex max-h-[min(54vh,580px)] flex-col overflow-hidden rounded-2xl border border-black/10 bg-[#f6f1e7]/95 shadow-[0_18px_50px_rgba(42,32,18,0.18)] backdrop-blur-md md:inset-x-auto md:top-3 md:bottom-3 md:left-3 md:w-[372px] md:max-h-none">
        <div className="shrink-0 px-4 pt-4 pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] tracking-[0.16em] text-[#7a6d5d] uppercase">Distance from a road</p>
              <h1 className="font-display mt-1 text-[2rem] leading-none text-[#241c14]">Hinterland</h1>
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="shrink-0 text-[#5c5348]"
              onClick={() => setGuideOpenPersisted(false)}
              aria-expanded={true}
              aria-label="Minimize guide and legend"
            >
              <ChevronDown className="size-4 md:hidden" aria-hidden />
              <ChevronUp className="hidden size-4 md:block" aria-hidden />
            </Button>
          </div>
          <p className="mt-2 text-sm leading-5 text-[#5c5348]">
            Land sorted by straight-line distance to the nearest mapped road in each layer. Warm is close. Deep teal
            and ink are far. The world layer uses GRIP4 (highway through tertiary), not every OpenStreetMap street.
          </p>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 px-4 pb-5">
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">
                  {legend === "study" ? "This view" : hideIce ? "World, ice hidden" : "World"}
                </h2>
                {study && (
                  <div className="grid grid-cols-2 rounded-lg bg-[#ebe4d6] p-0.5">
                    <Button
                      size="xs"
                      variant={legend === "world" ? "default" : "ghost"}
                      onClick={() => setLegend("world")}
                    >
                      World
                    </Button>
                    <Button
                      size="xs"
                      variant={legend === "study" ? "default" : "ghost"}
                      onClick={() => setLegend("study")}
                    >
                      View
                    </Button>
                  </div>
                )}
              </div>
              {legend === "world" && meta && (
                <p className="mb-2 text-sm leading-5">
                  <span className="font-medium tabular-nums">{formatShare(beyondHundred)}</span> of{" "}
                  {hideIce ? "land outside the ice sheets" : "land"} is more than 100 km from the nearest GRIP road
                  in this layer. {formatKm2(hideIce ? iceFreeKm(meta) : meta.landKm2)} classified.
                </p>
              )}
              {legend === "world" && metaError && <p className="mb-2 text-sm text-[#8a3d32]">{metaError}</p>}
              {legend === "study" && study && (
                <p className="mb-2 text-sm leading-5 text-[#5c5348]">
                  {study.segments.toLocaleString("en-US")} roads · {Math.round(study.cellM)} m cells · measured in{" "}
                  {study.ms} ms. Shares are of this rectangle, water included.
                </p>
              )}
              <ShareBar bands={activeBands} shares={activeShares} isolate={legend === "study" ? isolate : null} />
              <ul className="mt-2 flex flex-col">
                {activeBands.map((band) => {
                  const share = activeShares?.find((item) => item.id === band.id)?.share ?? 0;
                  const selected = legend === "study" && isolate === band.id;
                  return (
                    <li key={band.id}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs ${selected ? "bg-[#ebe4d6]" : "hover:bg-[#efe8da]"}`}
                        onClick={() => {
                          if (legend !== "study") return;
                          setIsolate((current) => (current === band.id ? null : band.id));
                        }}
                      >
                        <span
                          className="size-3 shrink-0 rounded-sm border border-black/10"
                          style={{ backgroundColor: `rgb(${band.color.join(",")})` }}
                        />
                        <span className="w-[6.75rem] shrink-0">{band.label}</span>
                        <span className="min-w-0 flex-1 truncate text-[#6d6458]">{band.detail}</span>
                        <span className="tabular-nums text-[#3d362e]">{formatShare(share)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {legend === "study" && (
                <p className="mt-1 text-[11px] text-[#7a6d5d]">Select a class to fade the others.</p>
              )}
            </section>

            <Separator />

            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="show-world-roads" className="text-sm font-medium">
                  Show roads used
                </Label>
                <Switch
                  id="show-world-roads"
                  checked={showWorldRoads}
                  onCheckedChange={setShowWorldRoadsPersisted}
                  disabled={study != null}
                />
              </div>
              {showWorldRoads && worldRoadsLoading && (
                <p className="text-xs leading-4 text-[#6d6458]">Loading road lines… the global overview can take a minute.</p>
              )}
              <p className="text-xs leading-4 text-[#6d6458]">
                Overlays the GRIP lines burned into the world distance field (types 1–4; local GRIP roads omitted for
                size). These are not Positron basemap streets. At city zoom the basemap hides OSM roads so the overlay
                stays honest; turn this on to see the inventory behind the colors.
                {study ? " Hidden while a local OpenStreetMap study is active." : ""}
              </p>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="hide-ice" className="text-sm font-medium">
                  Hide ice sheets
                </Label>
                <Switch id="hide-ice" checked={hideIce} onCheckedChange={setHideIce} />
              </div>
              <p className="text-xs leading-4 text-[#6d6458]">
                Antarctica and Greenland fill the farthest class. Hiding them shows the rest of the land.
                {meta ? ` Ice in this mask is about ${formatKm2(meta.iceKm2)}.` : ""}
              </p>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="opacity">Layer strength</Label>
                <span className="text-xs tabular-nums text-[#6d6458]">{opacity}%</span>
              </div>
              <Slider
                id="opacity"
                min={30}
                max={100}
                value={[opacity]}
                onValueChange={(value) => {
                  const next = Array.isArray(value) ? value[0] : value;
                  setOpacity(next ?? 86);
                }}
              />
            </section>

            <Separator />

            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Places</h2>
              <div className="flex flex-wrap gap-1.5">
                {WORLD_PRESETS.map((preset) => (
                  <Button key={preset.id} size="xs" variant="outline" onClick={() => applyPreset(preset)}>
                    {preset.name}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {STUDY_PRESETS.map((preset) => (
                  <Tooltip key={preset.id}>
                    <TooltipTrigger
                      className="inline-flex h-6 items-center rounded-[min(var(--radius-md),10px)] border border-border bg-background px-2 text-xs hover:bg-muted"
                      onClick={() => applyPreset(preset)}
                    >
                      {preset.name}
                    </TooltipTrigger>
                    <TooltipContent>{preset.blurb}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
              {meta && (
                <div className="mt-1 flex flex-col gap-1">
                  {meta.samples.map((sample) => (
                    <button
                      key={sample.id}
                      type="button"
                      className="flex items-baseline justify-between gap-3 rounded-md px-1 py-1 text-left text-xs hover:bg-[#efe8da]"
                      onClick={() => mapRef.current?.flyTo([sample.lon, sample.lat], sample.zoom)}
                    >
                      <span>
                        {sample.name}
                        <span className="text-[#7a6d5d]"> · {sample.region}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {sample.km == null ? "water" : `${sample.km.toLocaleString("en-US")} km`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <Separator />

            <section className="flex flex-col gap-3">
              <div>
                <h2 className="text-sm font-medium">Classify this view</h2>
                <p className="mt-1 text-xs leading-4 text-[#6d6458]">
                  Pulls OpenStreetMap roads for the current frame and measures every cell. Streets need a close
                  view. Major roads can cover a wider one.
                  {view ? ` This frame is about ${Math.round(spanKm(view))} km across.` : ""}
                </p>
              </div>
              <ul className="flex flex-col gap-2">
                {ROAD_GROUPS.map((group) => (
                  <li key={group.id}>
                    <label className="flex items-start gap-2.5">
                      <Checkbox
                        className="mt-0.5"
                        checked={groups[group.id]}
                        onCheckedChange={(checked) =>
                          setGroups((current) => ({ ...current, [group.id]: checked }))
                        }
                      />
                      <span>
                        <span className="block text-sm leading-4">{group.label}</span>
                        <span className="block text-xs leading-4 text-[#6d6458]">{group.hint}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="cell-size">Cell size</Label>
                <span className="text-xs tabular-nums text-[#6d6458]">{cellM} m</span>
              </div>
              <Slider
                id="cell-size"
                min={40}
                max={180}
                step={10}
                value={[cellM]}
                onValueChange={(value) => {
                  const next = Array.isArray(value) ? value[0] : value;
                  setCellM(next ?? 70);
                }}
              />
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#ebe4d6] p-0.5">
                <Button
                  size="sm"
                  variant={colorMode === "bands" ? "default" : "ghost"}
                  onClick={() => setColorMode("bands")}
                >
                  Classes
                </Button>
                <Button
                  size="sm"
                  variant={colorMode === "continuous" ? "default" : "ghost"}
                  onClick={() => setColorMode("continuous")}
                >
                  Continuous
                </Button>
              </div>
              <p className="text-[11px] leading-4 text-[#7a6d5d]">
                Continuous uses a log ramp, so a city block and a 20 km gap can both show. The world layer stays
                in classes.
              </p>
              <Button
                className="h-10 w-full"
                disabled={status === "loading" || Boolean(viewMessage)}
                onClick={() => {
                  const bounds = mapRef.current?.getBounds();
                  if (bounds) void runStudy(bounds, groups, cellM);
                }}
              >
                {status === "loading" ? statusText : "Classify this view"}
              </Button>
              {viewMessage && status !== "loading" && (
                <p className="text-xs leading-4 text-[#6d6458]">{viewMessage}</p>
              )}
              {dirty && status !== "loading" && (
                <p className="text-xs leading-4 text-[#6d6458]">
                  Road classes or cell size changed. Classify again to update the rectangle.
                </p>
              )}
              {error && <p className="text-xs leading-4 text-[#8a3d32]">{error}</p>}
              {study && (
                <Button variant="outline" onClick={clearStudy}>
                  Clear this study
                </Button>
              )}
            </section>

            <Separator />

            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Decisions still open</h2>
              <ol className="flex list-decimal flex-col gap-2 pl-4 text-xs leading-4 text-[#3f382f]">
                <li>
                  <span className="font-medium">What counts as a road.</span> The checkboxes above are the local
                  answer. The world layer uses GRIP4 types 1–4 (highway through tertiary). Local GRIP roads and ferries
                  are not in this static layer; use Classify this view for street-level OpenStreetMap.
                </li>
                <li>
                  <span className="font-medium">Straight line or a journey.</span> Every number here is Euclidean
                  distance to a centerline. Drive time, walk time, and terrain are a different map.
                </li>
                <li>
                  <span className="font-medium">Water and ice.</span> Ocean is clear. Large lakes cut out of the
                  land mask are clear too. The ice switch shows how much the farthest class is Greenland and
                  Antarctica.
                </li>
                <li>
                  <span className="font-medium">Planet or place.</span> The world grid is about 5 km. Streets
                  appear only in a study. One of these should probably lead.
                </li>
                <li>
                  <span className="font-medium">Classes or a continuous field.</span> Classes are easier to compare.
                  The continuous ramp is on the study control.
                </li>
              </ol>
              {roadMix.length > 0 && (
                <p className="text-[11px] leading-4 text-[#7a6d5d]">
                  World roads by length:{" "}
                  {roadMix
                    .slice(0, 4)
                    .map((item) => `${item.type} ${formatShare(item.share)}`)
                    .join(", ")}
                  .
                </p>
              )}
            </section>

            <details className="text-xs leading-4 text-[#5c5348]">
              <summary className="cursor-pointer text-sm font-medium text-[#2a241c]">Method</summary>
              <div className="mt-2 flex flex-col gap-2">
                <p>
                  The map is MapLibre GL, on OpenFreeMap&apos;s Positron style, which is OpenStreetMap data. The
                  world roads are GRIP4 (CC0); land and ice are Natural Earth 1:10 million, public domain.
                </p>
                <p>
                  Distance is a Euclidean distance transform: roads are burned into a grid, then each cell takes
                  the straight-line distance to the nearest burned cell. It is the same family as GRASS{" "}
                  <span className="font-medium">r.grow.distance</span> and GDAL proximity. Latitude bands use a
                  local meter scale, because a degree of longitude shrinks toward the poles. The antimeridian is
                  padded so Alaska and Chukotka can see each other&apos;s roads.
                </p>
                <p>
                  Zoomed out, a pixel shows the median class of the cells inside it, so thin corridors survive.
                  Zoomed in, the pixel is the cell itself. A study replaces that with live OpenStreetMap roads from
                  the Overpass API and a finer grid, still Euclidean, still in the browser.
                </p>
                <p>
                  GRIP local/urban roads (type 5) are omitted here to keep the GitHub Pages bundle practical. A further
                  step would add them, or match OpenStreetMap highway classes globally.
                </p>
              </div>
            </details>
          </div>
        </ScrollArea>
      </aside>
      )}
    </div>
  );
}

function ShareBar({
  bands,
  shares,
  isolate,
}: {
  bands: Band[];
  shares: { id: string; share: number }[] | undefined;
  isolate: string | null;
}) {
  return (
    <div className="flex h-3 overflow-hidden rounded-full border border-black/10">
      {bands.map((band) => {
        const share = shares?.find((item) => item.id === band.id)?.share ?? 0;
        if (share <= 0) return null;
        return (
          <span
            key={band.id}
            style={{
              width: `${share * 100}%`,
              backgroundColor: `rgb(${band.color.join(",")})`,
              color: textOn(band.color),
              opacity: isolate && isolate !== band.id ? 0.35 : 1,
            }}
          />
        );
      })}
    </div>
  );
}

function shareOf(shares: AreaShare[] | undefined, ids: string[]): number {
  if (!shares) return 0;
  return shares.filter((share) => ids.includes(share.id)).reduce((sum, share) => sum + share.share, 0);
}

function iceFreeKm(meta: WorldMeta): number {
  return meta.areaNoIce.reduce((sum, share) => sum + share.km2, 0);
}

function roadTypeLabel(type: string): string {
  switch (type) {
    case "Major Highway":
      return "major highways";
    case "Secondary Highway":
      return "secondary highways";
    case "Road":
      return "other roads";
    case "Unknown":
      return "unclassified source roads";
    case "Beltway":
      return "beltways";
    case "Track":
      return "tracks";
    case "Bypass":
      return "bypasses";
    default:
      return type.toLowerCase();
  }
}

