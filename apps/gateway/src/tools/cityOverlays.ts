// City of Houston planning overlays — the layers that make or break a deal
// before Chapter 42 math even matters: historic/conservation districts
// (approvals, demo restrictions), special minimum lot size / building line
// areas (block small-lot subdivision), market-based parking (no minimums),
// opportunity zones (tax incentive). One identify call checks them all.

import { kvCached } from "./kvcache";

const IDENTIFY_URL =
  "https://mycity2.houstontx.gov/pubgis02/rest/services/HoustonMap/Planning_and_Development/MapServer/identify";

const LAYERS: Record<number, { key: string; label: string }> = {
  3: { key: "conservation_district", label: "Conservation District" },
  8: { key: "historic_district_city", label: "City of Houston Historic District" },
  9: { key: "historic_district_national", label: "National Register Historic District" },
  12: { key: "special_min_building_line", label: "Special Minimum Building Line area" },
  13: { key: "special_min_lot_size", label: "Special Minimum Lot Size area" },
  35: { key: "market_based_parking", label: "Market-Based Parking area" },
  40: { key: "opportunity_zone", label: "Federal Opportunity Zone" },
};

export type OverlayHit = { key: string; label: string; name: string | null };

export async function cityOverlaysAt(lat: number, lon: number): Promise<OverlayHit[]> {
  // District boundaries move at city-council speed — a day of team-wide cache
  // is safe. 5 decimal places ≈ 1m, plenty for point-in-polygon identity.
  return kvCached("coh", `${lat.toFixed(5)},${lon.toFixed(5)}`, 86_400, () =>
    cityOverlaysLive(lat, lon)
  );
}

async function cityOverlaysLive(lat: number, lon: number): Promise<OverlayHit[]> {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: `all:${Object.keys(LAYERS).join(",")}`,
    tolerance: "0",
    mapExtent: `${lon - 0.01},${lat - 0.01},${lon + 0.01},${lat + 0.01}`,
    imageDisplay: "400,400,96",
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(`${IDENTIFY_URL}?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      // Same WAF story as FEMA: anonymous datacenter traffic gets dropped.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`City overlays query failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: Array<{ layerId: number; attributes?: Record<string, unknown> }>;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`City overlays query failed: ${json.error.message ?? "unknown"}`);

  const hits: OverlayHit[] = [];
  const seen = new Set<string>();
  for (const r of json.results ?? []) {
    const meta = LAYERS[r.layerId];
    if (!meta || seen.has(meta.key)) continue;
    seen.add(meta.key);
    const a = r.attributes ?? {};
    const name =
      (a.NAME as string) ??
      (a.Name as string) ??
      (a.DISTRICT_NAME as string) ??
      (a.AREA_NAME as string) ??
      null;
    hits.push({ key: meta.key, label: meta.label, name: typeof name === "string" ? name.trim() : null });
  }
  return hits;
}
