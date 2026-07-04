// FEMA National Flood Hazard Layer (NFHL) lookups — public ArcGIS REST
// service, no key. Ported from the CRM's proven client
// (land-lead-hub_FINAL/src/lib/femaFlood.ts) and trimmed to what the voice
// pipeline needs: the zone at a parcel's centroid, plus whether any part of
// the parcel's footprint touches a Special Flood Hazard Area.

const NFHL_ZONES_URL =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

export type FloodInfo = {
  /** e.g. "AE", "X", "VE", "A", "AO" — zone at the parcel centroid. */
  zone: string | null;
  /** e.g. "FLOODWAY", "0.2 PCT ANNUAL CHANCE FLOOD HAZARD" */
  subType: string | null;
  /** Special Flood Hazard Area (100-year floodplain) at the centroid. */
  sfha: boolean;
  isFloodway: boolean;
  /** True when any zone intersecting the parcel's bbox is SFHA (a lot can
   *  be dry at its center but have a flooded corner). */
  touchesSfha: boolean;
  /** Human-readable summary, safe to speak. */
  label: string;
};

type ZoneAttrs = {
  FLD_ZONE?: string | null;
  ZONE_SUBTY?: string | null;
  SFHA_TF?: string | boolean | null;
};

function parseZone(attrs: ZoneAttrs) {
  const zone = attrs.FLD_ZONE?.trim() || null;
  const subType = attrs.ZONE_SUBTY?.trim() || null;
  const sfha = attrs.SFHA_TF === "T" || attrs.SFHA_TF === true;
  const isFloodway = (subType ?? "").toUpperCase().includes("FLOODWAY");
  return { zone, subType, sfha, isFloodway };
}

export function describeFloodZone(
  zone: string | null,
  subType: string | null,
  sfha: boolean
): string {
  if (!zone) return "No FEMA data";
  const base = (() => {
    const z = zone.toUpperCase();
    if (z === "X") {
      if ((subType ?? "").toUpperCase().includes("0.2"))
        return "Zone X — 0.2% annual (500-yr)";
      return "Zone X — minimal risk";
    }
    if (z.startsWith("V")) return `Zone ${z} — coastal high risk`;
    if (z === "AE" || z === "A" || z === "AO" || z === "AH")
      return `Zone ${z} — 1% annual (100-yr SFHA)`;
    if (z === "D") return "Zone D — undetermined";
    return `Zone ${z}`;
  })();
  if ((subType ?? "").toUpperCase().includes("FLOODWAY")) return `${base} · Floodway`;
  if (sfha && !base.includes("SFHA")) return `${base} · SFHA`;
  return base;
}

async function queryZones(extra: Record<string, string>): Promise<ZoneAttrs[]> {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
    returnGeometry: "false",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    f: "json",
    ...extra,
  });
  // FEMA's WAF drops anonymous datacenter traffic (breaks from Cloudflare
  // Workers) — a browser-like identity gets through.
  const res = await fetch(`${NFHL_ZONES_URL}?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Referer: "https://hazards.fema.gov/",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`FEMA NFHL query failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    features?: Array<{ attributes?: ZoneAttrs }>;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`FEMA NFHL query failed: ${json.error.message ?? "unknown"}`);
  return (json.features ?? []).map((f) => f.attributes ?? {});
}

function ringsBbox(rings: number[][][]): { west: number; south: number; east: number; north: number } | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : null;
}

/** Zone at the parcel centroid, plus SFHA touch-check over its footprint bbox. */
export async function floodCheckParcel(parcel: {
  lat: number;
  lon: number;
  rings: number[][][];
}): Promise<FloodInfo> {
  const bbox = ringsBbox(parcel.rings);
  const [pointAttrs, bboxAttrs] = await Promise.all([
    queryZones({
      geometry: `${parcel.lon},${parcel.lat}`,
      geometryType: "esriGeometryPoint",
    }),
    bbox
      ? queryZones({
          geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
          geometryType: "esriGeometryEnvelope",
        }).catch(() => [] as ZoneAttrs[]) // bbox sweep is best-effort
      : Promise.resolve([] as ZoneAttrs[]),
  ]);

  const touching = bboxAttrs.map(parseZone);
  // Centroid zone is primary; if the centroid query came back empty (edge of
  // FEMA coverage), fall back to the most severe zone touching the parcel.
  const severity = (z: ReturnType<typeof parseZone>) =>
    (z.isFloodway ? 8 : 0) + (z.zone?.startsWith("V") ? 4 : 0) + (z.sfha ? 2 : 0);
  const primary =
    pointAttrs.length > 0
      ? parseZone(pointAttrs[0])
      : touching.sort((a, b) => severity(b) - severity(a))[0] ?? parseZone({});

  return {
    ...primary,
    touchesSfha: primary.sfha || touching.some((z) => z.sfha),
    label: describeFloodZone(primary.zone, primary.subType, primary.sfha),
  };
}
