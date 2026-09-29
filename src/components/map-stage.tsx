"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import * as maplibregl from "maplibre-gl";
import type { MapMouseEvent, RasterTileSource } from "maplibre-gl";
import type { StudyRaster } from "@/lib/geo/paint";
import type { BBox } from "@/lib/roads";
import { publicPath } from "@/lib/base-path";
import "maplibre-gl/dist/maplibre-gl.css";

// The bundled worker URL breaks once Next rewrites import.meta.url. These two
// files are the official MapLibre dist modules, copied into public/vendor.
maplibregl.setWorkerUrl(publicPath("/vendor/maplibre-gl-worker.mjs"));

const WORLD_TILES = publicPath("/tiles/{z}/{x}/{y}.png");
const WORLD_TILES_NO_ICE = publicPath("/tiles-no-ice/{z}/{x}/{y}.png");

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
  onView: (bounds: BBox) => void;
  onHover: (lngLat: { lng: number; lat: number }) => void;
  onClick: (lngLat: { lng: number; lat: number }) => void;
};

function padding(): maplibregl.PaddingOptions {
  const wide = typeof window !== "undefined" && window.innerWidth >= 960;
  return {
    left: wide ? 400 : 16,
    right: 16,
    top: 16,
    bottom: wide ? 16 : 220,
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

function paintStudy(
  map: maplibregl.Map | null,
  canvas: HTMLCanvasElement | null,
  image: HTMLCanvasElement | null,
  bounds: BBox | null,
) {
  if (!canvas || !map) return;
  const box = map.getContainer();
  const width = box.clientWidth;
  const height = box.clientHeight;
  if (width < 1 || height < 1) return;
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
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
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

export function MapStage({ ref, hideIce, opacity, onView, onHover, onClick }: MapStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const readyRef = useRef(false);
  const studyImageRef = useRef<HTMLCanvasElement | null>(null);
  const studyBoundsRef = useRef<BBox | null>(null);
  const hideIceRef = useRef(hideIce);
  const opacityRef = useRef(opacity);
  const onViewRef = useRef(onView);
  const onHoverRef = useRef(onHover);
  const onClickRef = useRef(onClick);

  useEffect(() => {
    hideIceRef.current = hideIce;
    opacityRef.current = opacity;
    onViewRef.current = onView;
    onHoverRef.current = onHover;
    onClickRef.current = onClick;
  });

  const redraw = () => {
    paintStudy(mapRef.current, overlayRef.current, studyImageRef.current, studyBoundsRef.current);
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
        { padding: padding(), duration: 900, essential: true },
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
      redraw();
    },
    clearStudy() {
      studyBoundsRef.current = null;
      studyImageRef.current = null;
      popupRef.current?.remove();
      redraw();
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
    map.setPadding(padding());
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

    map.on("load", () => {
      map.addSource("distance", {
        type: "raster",
        tiles: [hideIceRef.current ? WORLD_TILES_NO_ICE : WORLD_TILES],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 5,
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
      publishView();
      paintStudy(map, overlay, studyImageRef.current, studyBoundsRef.current);
    });

    const redrawOverlay = () => {
      paintStudy(map, overlay, studyImageRef.current, studyBoundsRef.current);
    };
    map.on("render", redrawOverlay);
    map.on("moveend", publishView);
    map.on("mousemove", (event: MapMouseEvent) => {
      onHoverRef.current(event.lngLat);
    });
    map.on("click", (event: MapMouseEvent) => {
      onClickRef.current(event.lngLat);
    });

    const onResize = () => {
      map.setPadding(padding());
      paintStudy(map, overlay, studyImageRef.current, studyBoundsRef.current);
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
  }, [hideIce]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getLayer("distance")) return;
    map.setPaintProperty("distance", "raster-opacity", opacity);
  }, [opacity]);

  return <div ref={containerRef} className="absolute inset-0" aria-label="World map" />;
}
