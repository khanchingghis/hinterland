export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

export function formatShare(share: number): string {
  const pct = share * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}

export function formatKm2(km2: number): string {
  if (km2 >= 1_000_000) return `${(km2 / 1_000_000).toFixed(1)} million km²`;
  if (km2 >= 10_000) return `${Math.round(km2 / 1000)} thousand km²`;
  return `${Math.round(km2).toLocaleString("en-US")} km²`;
}
