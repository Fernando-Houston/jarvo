// The ground layer: named bayous (USGS NHD flowlines) and freeways (TxDOT
// roadways) around a parcel, as decimated polylines the orb renders as faint
// particle streams — plus the spoken orientation ("where is this?").

const NHD_FLOWLINES =
  "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query";
const TXDOT_ROADWAYS =
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_Roadways/FeatureServer/0/query";

const DOWNTOWN = { lat: 29.7604, lon: -95.3698 };

export type GroundFeature = {
  kind: "water" | "road";
  name: string;
  /** [lon, lat] vertices, decimated. */
  path: [number, number][];
};

export type GroundContext = {
  features: GroundFeature[];
  nearestWater: { name: string; miles: number } | null;
  nearestRoad: { name: string; miles: number } | null;
  downtownMiles: number;
  downtownDirection: string;
};

const UA = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

async function queryLines(
  url: string,
  where: string,
  bbox: string,
  outFields: string,
  cap: number
): Promise<Array<{ attributes: Record<string, unknown>; paths: [number, number][][] }>> {
  const params = new URLSearchParams({
    where,
    geometry: bbox,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: "true",
    geometryPrecision: "5",
    resultRecordCount: String(cap),
    f: "json",
  });
  const res = await fetch(`${url}?${params.toString()}`, {
    headers: UA,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`ground query failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    features?: Array<{ attributes?: Record<string, unknown>; geometry?: { paths?: [number, number][][] } }>;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`ground query failed: ${json.error.message ?? "unknown"}`);
  return (json.features ?? [])
    .filter((f) => f.geometry?.paths?.length)
    .map((f) => ({ attributes: f.attributes ?? {}, paths: f.geometry!.paths! }));
}

function decimate(path: [number, number][], maxPts = 36): [number, number][] {
  if (path.length <= maxPts) return path;
  const step = Math.ceil(path.length / maxPts);
  const out: [number, number][] = [];
  for (let i = 0; i < path.length; i += step) out.push(path[i]);
  if (out[out.length - 1] !== path[path.length - 1]) out.push(path[path.length - 1]);
  return out;
}

function milesTo(lat: number, lon: number, path: [number, number][]): number {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const [plon, plat] of path) {
    const dx = (plon - lon) * 69.17 * kx;
    const dy = (plat - lat) * 68.7;
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

function roadLabel(a: Record<string, unknown>): string {
  const prfx = String(a.RTE_PRFX ?? "");
  const nbr = String(a.RTE_NBR ?? "").replace(/^0+/, "");
  if (prfx === "IH") return `I-${nbr}`;
  if (prfx === "US") return `US-${nbr}`;
  if (prfx === "SH") return `SH-${nbr}`;
  return `${prfx}-${nbr}`;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

export async function groundAround(lat: number, lon: number, radiusM = 2000): Promise<GroundContext> {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`;

  const [waterRaw, roadRaw] = await Promise.all([
    queryLines(NHD_FLOWLINES, "gnis_name IS NOT NULL", bbox, "gnis_name", 40).catch(() => []),
    queryLines(TXDOT_ROADWAYS, "RTE_PRFX IN ('IH','US','SH')", bbox, "RTE_NM,RTE_PRFX,RTE_NBR", 60).catch(
      () => []
    ),
  ]);

  const features: GroundFeature[] = [];
  const perName = new Map<string, number>();
  const push = (kind: "water" | "road", name: string, path: [number, number][]) => {
    const n = perName.get(kind + name) ?? 0;
    if (n >= 6 || features.length >= 40 || path.length < 2) return;
    perName.set(kind + name, n + 1);
    features.push({ kind, name, path: decimate(path) });
  };
  for (const f of waterRaw) {
    const name = String(f.attributes.gnis_name ?? "").trim();
    for (const p of f.paths) push("water", name, p as [number, number][]);
  }
  for (const f of roadRaw) {
    for (const p of f.paths) push("road", roadLabel(f.attributes), p as [number, number][]);
  }

  const nearest = (kind: "water" | "road") => {
    let best: { name: string; miles: number } | null = null;
    for (const f of features.filter((x) => x.kind === kind)) {
      const mi = milesTo(lat, lon, f.path);
      if (!best || mi < best.miles) best = { name: f.name, miles: Math.round(mi * 10) / 10 };
    }
    return best;
  };

  const kx = Math.cos((lat * Math.PI) / 180);
  const dxMi = (DOWNTOWN.lon - lon) * 69.17 * kx;
  const dyMi = (DOWNTOWN.lat - lat) * 68.7;
  // Direction FROM downtown TO the parcel (how a land guy says it).
  const angle = (Math.atan2(-dxMi, -dyMi) * 180) / Math.PI;
  const dir = COMPASS[Math.round((((angle + 360) % 360) / 45)) % 8];

  return {
    features,
    nearestWater: nearest("water"),
    nearestRoad: nearest("road"),
    downtownMiles: Math.round(Math.hypot(dxMi, dyMi) * 10) / 10,
    downtownDirection: dir,
  };
}
