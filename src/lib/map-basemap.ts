type BasemapLayer = {
  id: string;
  type: string;
  "source-layer"?: string;
};

/** OpenFreeMap Positron draws OSM streets; the world layer uses GRIP4 roads (types 1–4). */
export function isBasemapRoadLayer(layer: BasemapLayer): boolean {
  if (layer.type !== "line") return false;
  const sourceLayer = layer["source-layer"];
  if (sourceLayer === "transportation") return true;
  const id = layer.id;
  return (
    id.startsWith("highway_") ||
    id.startsWith("road_") ||
    id.startsWith("tunnel_") ||
    id.startsWith("bridge_") ||
    id === "railway" ||
    id.startsWith("railway_")
  );
}
