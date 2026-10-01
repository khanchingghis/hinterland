"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import * as maplibregl from "maplibre-gl";
import type { MapMouseEvent, RasterTileSource, GeoJSONSource } from "maplibre-gl";
import type { StudyRaster } from "@/lib/geo/paint";
import { fieldRasterForBounds, type WorldField } from "@/lib/geo/world-field";
import { isBasemapRoadLayer } from "@/lib/map-basemap";
import type { BBox } from "@/lib/roads";
import {
  loadWorldRoadGeoJson,
  worldRoadGeoJsonTolerance,
  worldRoadLineCasingWidthExpression,
  worldRoadLineColorExpression,
  worldRoadLineWidthExpression,
} from "@/lib/world-roads";
import { publicPath } from "@/lib/base-path";
import "maplibre-gl/dist/maplibre-gl.css";

// The bundled worker URL breaks once Next rewrites import.meta.url. These two
// files are the official MapLibre dist modules, copied into public/vendor.
maplibregl.setWorkerUrl(publicPath("/vendor/maplibre-gl-worker.mjs"));

const WORLD_TILES = publicPath("/tiles/{z}/{x}/{y}.png");
const WORLD_TILES_NO_ICE = publicPath("/tiles-no-ice/{z}/{x}/{y}.png");
const WORLD_ROADS_SOURCE = "hinterland-world-roads";
const WORLD_ROADS_CASING_LAYER = "hinterland-world-roads-casing";
const WORLD_ROADS_LINE_LAYER = "hinterland-world-roads-line";

export type MapNote = {
  lng: number;
  lat: number;
  title: string;
  body: string;
};

export type MapStageHandle = {
  flyTo: (center: [number, number], zoom: number) => void;
  fit: (bounds: BBox) => void;
  getBounds: () => BBox | null;
  setStudy: (raster: StudyRaster, bounds: BBox) => void;
  clearStudy: () => void;
  showNote: (note: MapNote) => void;
};

type MapStageProps = {
  ref?: Ref<MapStageHandle>;
  hideIce: boolean;
  opacity: number;
  showWorldRoads: boolean;
  worldField: WorldField | null;
  worldTileMaxZoom: number;
  studyActive: boolean;
  guideBottomInset: number;
  onView: (bounds: BBox) => void;
  onHover: (lngLat: { lng: number; lat: number }) => void;
  onClick: (lngLat: { lng: number; lat: number }) => void;
  onWorldRoadsLoadingChange?: (loading: boolean) => void;
};

function padding(guideBottomInset: number): maplibregl.PaddingOptions {
  const wide = typeof window !== "undefined" && window.innerWidth >= 960;
  return {
    left: wide ? 400 : 16,
    right: 16,
    top: 16,
    bottom: wide ? 16 : guideBottomInset,
  };
}

function asBounds(bounds: maplibregl.LngLatBounds): BBox | null {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  if (![west, east, south, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

function resizeOverlayCanvas(
  map: maplibregl.Map,
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  const box = map.getContainer();
  const width = box.clientWidth;
  const height = box.clientHeight;
  if (width < 1 || height < 1) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const bitmapWidth = Math.round(width * ratio);
  const bitmapHeight = Math.round(height * ratio);
  if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function paintOverlay(
  map: maplibregl.Map | null,
  canvas: HTMLCanvasElement | null,
  image: HTMLCanvasElement | null,
  bounds: BBox | null,
  outlineStudy: boolean,
) {
  if (!canvas || !map) return;
  const context = resizeOverlayCanvas(map, canvas);
  if (!context) return;
  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  const ratio = window.devicePixelRatio || 1;
  context.clearRect(0, 0, width, height);
  if (!image || !bounds) return;

  const northWest = map.project([bounds.west, bounds.north]);
  const northEast = map.project([bounds.east, bounds.north]);
  const southWest = map.project([bounds.west, bounds.south]);
  const southEast = map.project([bounds.east, bounds.south]);

  context.save();
  context.setTransform(
    ((northEast.x - northWest.x) / image.width) * ratio,
    ((northEast.y - northWest.y) / image.width) * ratio,
    ((southWest.x - northWest.x) / image.height) * ratio,
    ((southWest.y - northWest.y) / image.height) * ratio,
    northWest.x * ratio,
    northWest.y * ratio,
  );
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
  context.restore();

  if (!outlineStudy) return;

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.beginPath();
  context.moveTo(northWest.x, northWest.y);
  context.lineTo(northEast.x, northEast.y);
  context.lineTo(southEast.x, southEast.y);
  context.lineTo(southWest.x, southWest.y);
  context.closePath();
  context.strokeStyle = "#6b2a16";
  context.lineWidth = 2.5;
  context.stroke();
}

function rasterImage(raster: StudyRaster): HTMLCanvasElement | null {
  const image = document.createElement("canvas");
  image.width = raster.width;
  image.height = raster.height;
  const context = image.getContext("2d");
  if (!context) return null;
  const pixels = context.createImageData(raster.width, raster.height);
  pixels.data.set(raster.rgba);
  context.putImageData(pixels, 0, 0);
  return image;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function MapStage({
  ref,
  hideIce,
  opacity,
  showWorldRoads,
  worldField,
  worldTileMaxZoom,
  studyActive,
  guideBottomInset,
  onView,
  onHover,
  onClick,
  onWorldRoadsLoadingChange,
}: MapStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const readyRef = useRef(false);
  const studyImageRef = useRef<HTMLCanvasElement | null>(null);
  const studyBoundsRef = useRef<BBox | null>(null);
  const worldImageRef = useRef<HTMLCanvasElement | null>(null);
  const worldBoundsRef = useRef<BBox | null>(null);
  const roadLayerIdsRef = useRef<string[]>([]);
  const worldRoadsLoadRef = useRef(0);
  const worldRoadsAbortRef = useRef<AbortController | null>(null);
  const worldRoadsModeRef = useRef<string>("");
  /** Prevents abort/restart loops while a tier is still streaming (mode ref updates only after setData). */
  const worldRoadsInFlightModeRef = useRef<string | null>(null);
  const showWorldRoadsRef = useRef(showWorldRoads);
  const hideIceRef = useRef(hideIce);
  const opacityRef = useRef(opacity);
  const worldFieldRef = useRef(worldField);
  const worldRoadsToleranceRef = useRef<number | null>(null);
  const worldTileMaxZoomRef = useRef(worldTileMaxZoom);
  const studyActiveRef = useRef(studyActive);
  const guideBottomInsetRef = useRef(guideBottomInset);
  const onViewRef = useRef(onView);
  const onHoverRef = useRef(onHover);
  const onClickRef = useRef(onClick);
  const onWorldRoadsLoadingChangeRef = useRef(onWorldRoadsLoadingChange);

  useEffect(() => {
    hideIceRef.current = hideIce;
    opacityRef.current = opacity;
    showWorldRoadsRef.current = showWorldRoads;
    worldFieldRef.current = worldField;
    worldTileMaxZoomRef.current = worldTileMaxZoom;
    studyActiveRef.current = studyActive;
    guideBottomInsetRef.current = guideBottomInset;
    onViewRef.current = onView;
    onHoverRef.current = onHover;
    onClickRef.current = onClick;
    onWorldRoadsLoadingChangeRef.current = onWorldRoadsLoadingChange;
  });

  const usesWorldDetailOverlay = (map: maplibregl.Map): boolean => {
    if (studyActiveRef.current || studyImageRef.current) return false;
    if (!worldFieldRef.current) return false;
    return map.getZoom() > worldTileMaxZoomRef.current;
  };

  const shouldDrawWorldRoads = (map: maplibregl.Map): boolean => {
    if (!showWorldRoadsRef.current) return false;
    if (studyActiveRef.current || studyImageRef.current) return false;
    return true;
  };

  const syncBasemapAndTiles = (map: maplibregl.Map) => {
    if (!map.getLayer("distance")) return;
    const worldDetail = usesWorldDetailOverlay(map);
    const worldOverlayReady = Boolean(worldImageRef.current && worldBoundsRef.current);
    const study = Boolean(studyImageRef.current);
    map.setLayoutProperty(
      "distance",
      "visibility",
      (worldDetail && worldOverlayReady) || study ? "none" : "visible",
    );
    const hideRoads = worldDetail && worldOverlayReady && !study;
    for (const id of roadLayerIdsRef.current) {
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(id, "visibility", hideRoads ? "none" : "visible");
    }
  };

  const clearWorldRoadOverlay = (map: maplibregl.Map) => {
    worldRoadsAbortRef.current?.abort();
    worldRoadsAbortRef.current = null;
    worldRoadsModeRef.current = "";
    worldRoadsInFlightModeRef.current = null;
    onWorldRoadsLoadingChangeRef.current?.(false);
    const source = map.getSource(WORLD_ROADS_SOURCE) as GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features: [] });
    for (const id of [WORLD_ROADS_CASING_LAYER, WORLD_ROADS_LINE_LAYER]) {
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(id, "visibility", "none");
    }
  };

  const resetWorldRoadSource = (map: maplibregl.Map) => {
    for (const id of [WORLD_ROADS_LINE_LAYER, WORLD_ROADS_CASING_LAYER]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(WORLD_ROADS_SOURCE)) map.removeSource(WORLD_ROADS_SOURCE);
    worldRoadsToleranceRef.current = null;
  };

  const ensureWorldRoadLayers = (map: maplibregl.Map) => {
    const tolerance = worldRoadGeoJsonTolerance(map.getZoom());
    if (map.getSource(WORLD_ROADS_SOURCE) && worldRoadsToleranceRef.current !== tolerance) {
      resetWorldRoadSource(map);
    }
    if (!map.getSource(WORLD_ROADS_SOURCE)) {
      worldRoadsToleranceRef.current = tolerance;
      map.addSource(WORLD_ROADS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        tolerance,
      });
      map.addLayer({
        id: WORLD_ROADS_CASING_LAYER,
        type: "line",
        source: WORLD_ROADS_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "rgba(255,248,240,0.85)",
          "line-width": worldRoadLineCasingWidthExpression(),
        },
      });
      map.addLayer({
        id: WORLD_ROADS_LINE_LAYER,
        type: "line",
        source: WORLD_ROADS_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": worldRoadLineColorExpression(),
          "line-opacity": 0.95,
          "line-width": worldRoadLineWidthExpression(),
        },
      });
    }
    for (const id of [WORLD_ROADS_CASING_LAYER, WORLD_ROADS_LINE_LAYER]) {
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(id, "visibility", "visible");
    }
  };

  const roadLoadModeKey = (map: maplibregl.Map, bounds: BBox): string => {
    const zoom = map.getZoom();
    if (zoom <= 3) return "overview-highway";
    if (zoom <= 6) return "overview-major";
    const q = (value: number) => (Math.round(value * 4) / 4).toFixed(2);
    return `regional:${q(bounds.west)},${q(bounds.south)},${q(bounds.east)},${q(bounds.north)}`;
  };

  const refreshWorldRoadInventory = (map: maplibregl.Map) => {
    if (!shouldDrawWorldRoads(map)) {
      clearWorldRoadOverlay(map);
      return;
    }
    const bounds = asBounds(map.getBounds());
    if (!bounds) return;
    const modeKey = roadLoadModeKey(map, bounds);
    if (modeKey === worldRoadsModeRef.current) return;
    if (modeKey === worldRoadsInFlightModeRef.current) return;
    const token = worldRoadsLoadRef.current + 1;
    worldRoadsLoadRef.current = token;
    worldRoadsAbortRef.current?.abort();
    const abort = new AbortController();
    worldRoadsAbortRef.current = abort;
    worldRoadsInFlightModeRef.current = modeKey;
    onWorldRoadsLoadingChangeRef.current?.(true);
    ensureWorldRoadLayers(map);
    const zoom = map.getZoom();
    void loadWorldRoadGeoJson(bounds, zoom, abort.signal)
      .then((collection) => {
        worldRoadsInFlightModeRef.current = null;
        onWorldRoadsLoadingChangeRef.current?.(false);
        if (worldRoadsLoadRef.current !== token || !shouldDrawWorldRoads(map)) return;
        worldRoadsModeRef.current = modeKey;
        const active = map.getSource(WORLD_ROADS_SOURCE) as GeoJSONSource | undefined;
        active?.setData(collection);
      })
      .catch((error: unknown) => {
        worldRoadsInFlightModeRef.current = null;
        onWorldRoadsLoadingChangeRef.current?.(false);
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error(error);
      });
  };

  const refreshWorldOverlay = (map: maplibregl.Map) => {
    if (!usesWorldDetailOverlay(map)) {
      worldImageRef.current = null;
      worldBoundsRef.current = null;
      return;
    }
    const field = worldFieldRef.current;
    const bounds = asBounds(map.getBounds());
    if (!field || !bounds) return;
    const painted = fieldRasterForBounds(field, bounds, hideIceRef.current, opacityRef.current);
    if (!painted) {
      worldImageRef.current = null;
      worldBoundsRef.current = null;
      return;
    }
    worldBoundsRef.current = painted.bounds;
    worldImageRef.current = rasterImage(painted.raster);
  };

  const redraw = () => {
    const map = mapRef.current;
    const canvas = overlayRef.current;
    if (!map || !canvas) return;
    const study = studyImageRef.current && studyBoundsRef.current;
    if (study) {
      paintOverlay(map, canvas, studyImageRef.current, studyBoundsRef.current, true);
      return;
    }
    paintOverlay(map, canvas, worldImageRef.current, worldBoundsRef.current, false);
  };

  const refreshView = () => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    refreshWorldOverlay(map);
    syncBasemapAndTiles(map);
    refreshWorldRoadInventory(map);
    redraw();
  };

  useImperativeHandle(ref, () => ({
    flyTo(center, zoom) {
      mapRef.current?.flyTo({ center, zoom, essential: true, speed: 0.8 });
    },
    fit(bounds) {
      mapRef.current?.fitBounds(
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
        { padding: padding(guideBottomInsetRef.current), duration: 900, essential: true },
      );
    },
    getBounds() {
      const map = mapRef.current;
      if (!map) return null;
      return asBounds(map.getBounds());
    },
    setStudy(raster, bounds) {
      studyBoundsRef.current = bounds;
      studyImageRef.current = rasterImage(raster);
      refreshView();
    },
    clearStudy() {
      studyBoundsRef.current = null;
      studyImageRef.current = null;
      popupRef.current?.remove();
      refreshView();
    },
    showNote(note) {
      const map = mapRef.current;
      const popup = popupRef.current;
      if (!map || !popup) return;
      popup
        .setLngLat([note.lng, note.lat])
        .setHTML(
          `<p class="popup-title">${escapeHtml(note.title)}</p><p class="popup-body">${escapeHtml(note.body)}</p>`,
        )
        .addTo(map);
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = new maplibregl.Map({
      container,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [18, 14],
      zoom: 1.45,
      minZoom: 1,
      maxZoom: 16,
      attributionControl: { compact: true },
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.setPadding(padding(guideBottomInsetRef.current));
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-right");

    const overlay = document.createElement("canvas");
    overlay.className = "hinterland-study";
    overlay.setAttribute("aria-hidden", "true");
    map.getContainer().appendChild(overlay);
    overlayRef.current = overlay;

    popupRef.current = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: "260px",
      className: "hinterland-popup",
      offset: 14,
    });
    map.getCanvas().style.cursor = "crosshair";

    const publishView = () => {
      const bounds = asBounds(map.getBounds());
      if (bounds) onViewRef.current(bounds);
    };

    const onMapChange = () => {
      refreshWorldOverlay(map);
      syncBasemapAndTiles(map);
      refreshWorldRoadInventory(map);
      publishView();
    };

    map.on("load", () => {
      roadLayerIdsRef.current = (map.getStyle()?.layers ?? [])
        .filter((layer) => isBasemapRoadLayer(layer))
        .map((layer) => layer.id);

      map.addSource("distance", {
        type: "raster",
        tiles: [hideIceRef.current ? WORLD_TILES_NO_ICE : WORLD_TILES],
        tileSize: 256,
        minzoom: 0,
        maxzoom: worldTileMaxZoomRef.current,
      });
      map.addLayer({
        id: "distance",
        type: "raster",
        source: "distance",
        paint: {
          "raster-opacity": opacityRef.current,
          "raster-fade-duration": 0,
          "raster-resampling": "nearest",
        },
      });
      readyRef.current = true;
      onMapChange();
      redraw();
    });

    const onMapMotion = () => {
      refreshWorldOverlay(map);
      syncBasemapAndTiles(map);
      if (shouldDrawWorldRoads(map)) {
        const tolerance = worldRoadGeoJsonTolerance(map.getZoom());
        if (map.getSource(WORLD_ROADS_SOURCE) && worldRoadsToleranceRef.current !== tolerance) {
          worldRoadsModeRef.current = "";
          refreshWorldRoadInventory(map);
        }
      }
      redraw();
    };

    map.on("render", redraw);
    map.on("move", onMapMotion);
    map.on("zoom", onMapMotion);
    map.on("moveend", onMapChange);
    map.on("zoomend", onMapChange);
    map.on("mousemove", (event: MapMouseEvent) => {
      onHoverRef.current(event.lngLat);
    });
    map.on("click", (event: MapMouseEvent) => {
      onClickRef.current(event.lngLat);
    });

    const onResize = () => {
      map.setPadding(padding(guideBottomInsetRef.current));
      refreshView();
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      readyRef.current = false;
      overlay.remove();
      overlayRef.current = null;
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource("distance") as RasterTileSource | undefined;
    source?.setTiles([hideIce ? WORLD_TILES_NO_ICE : WORLD_TILES]);
    refreshView();
  }, [hideIce]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getLayer("distance")) return;
    map.setPaintProperty("distance", "raster-opacity", opacity);
    refreshView();
  }, [opacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPadding(padding(guideBottomInset));
    refreshView();
  }, [guideBottomInset]);

  useEffect(() => {
    refreshView();
  }, [worldField, worldTileMaxZoom, studyActive, showWorldRoads]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (!showWorldRoads) {
      worldRoadsLoadRef.current += 1;
      clearWorldRoadOverlay(map);
      refreshView();
      return;
    }
    worldRoadsModeRef.current = "";
    refreshWorldRoadInventory(map);
  }, [showWorldRoads]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="World map" />;
}
