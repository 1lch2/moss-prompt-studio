/** Editor-only colors: never add these to LayoutRegion or a model/export payload. */
export const REGION_COLORS = [
  "#2563EB", "#C2410C", "#15803D", "#BE185D", "#7C3AED", "#0E7490",
  "#DC2626", "#6B7414", "#4338CA", "#0F766E", "#A16207", "#A21CAF",
  "#475569", "#9F1239", "#166534", "#854D0E", "#0369A1", "#9333EA",
  "#B91C1C", "#4D7C0F", "#115E59", "#9D174D", "#6D28D9", "#57534E",
] as const;

export type RegionColors = Readonly<Record<string, string>>;

export function nextRegionColor(colors: RegionColors): string | undefined {
  const used = new Set(Object.values(colors));
  return REGION_COLORS.find((color) => !used.has(color));
}

/** Allocate by identity, not list position or region type. Surviving IDs never change. */
export function assignRegionColor(colors: RegionColors, id: string): RegionColors {
  if (colors[id]) return colors;
  const color = nextRegionColor(colors);
  if (!color) throw new Error("All 24 region colors are in use.");
  return { ...colors, [id]: color };
}

export function releaseRegionColor(colors: RegionColors, id: string): RegionColors {
  const next = { ...colors };
  delete next[id];
  return next;
}
