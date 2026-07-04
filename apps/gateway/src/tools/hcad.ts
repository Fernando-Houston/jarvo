// Live Harris County parcel lookups against HCAD's public ArcGIS layer.
// Ported from land-lead-hub_FINAL/src/lib/parcelLookup.ts (the production
// CRM's proven query patterns) and trimmed to what the voice pipeline needs.

const HCAD_PARCELS_URL =
  "https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query";

export type Parcel = {
  hcadAccount: string;
  lat: number;
  lon: number;
  rings: number[][][]; // [lon, lat] rings
  address: string | null;
  city: string | null;
  zip: string | null;
  ownerName: string | null;
  appraisedValue: number | null;
  landValue: number | null;
  buildingValue: number | null;
  lotSqft: number | null;
  legalDescription: string | null;
  ownedSince: string | null; // ISO date
  mailingAddress: string | null;
  /** Tax mail goes somewhere other than the property — null when unknowable. */
  absenteeOwner: boolean | null;
  /** HCAD land-use code, e.g. "1001" = single-family residential. */
  landUse: string | null;
  /** Texas state property class, e.g. "A1", "C1" (vacant). */
  stateClass: string | null;
};

type RawFeature = {
  attributes: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
};

const OUT_FIELDS = [
  "HCAD_NUM",
  "site_str_num",
  "site_str_pfx",
  "site_str_name",
  "site_str_sfx",
  "site_str_sfx_dir",
  "site_city",
  "site_zip",
  "owner_name_1",
  "owner_name_2",
  "total_appraised_val",
  "total_market_val",
  "land_value",
  "bld_value",
  "land_sqft",
  "acreage_1",
  "land_use",
  "state_class",
  "legal_dscr_1",
  "legal_dscr_2",
  "new_owner_date",
  "mail_addr_1",
  "mail_city",
  "mail_state",
  "mail_zip",
].join(",");

// LRU over raw query results: repeat lookups ("what's it worth" → "who owns
// it" → "save it") hit HCAD once. Values are 10 minutes fresh — appraisal
// data changes yearly, so staleness is a non-issue at this horizon.
const CACHE_MAX = 200;
const CACHE_TTL_MS = 10 * 60 * 1000;
const queryCache = new Map<string, { at: number; feats: RawFeature[] }>();

async function queryHcad(params: Record<string, string>): Promise<RawFeature[]> {
  const body = new URLSearchParams({
    outFields: OUT_FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    ...params,
  });
  const key = body.toString();
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    queryCache.delete(key);
    queryCache.set(key, hit); // LRU bump
    return hit.feats;
  }
  const res = await fetch(HCAD_PARCELS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HCAD query failed: HTTP ${res.status}`);
  const json = (await res.json()) as { features?: RawFeature[]; error?: { message?: string } };
  if (json.error) throw new Error(`HCAD query failed: ${json.error.message ?? "unknown"}`);
  const feats = json.features ?? [];
  queryCache.set(key, { at: Date.now(), feats });
  if (queryCache.size > CACHE_MAX) {
    queryCache.delete(queryCache.keys().next().value!);
  }
  return feats;
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function num(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ringsCentroid(rings: number[][][]): { lat: number; lon: number } | null {
  const ring = rings[0];
  if (!ring?.length) return null;
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-12) {
    const sum = ring.reduce((a, [x, y]) => ({ x: a.x + x, y: a.y + y }), { x: 0, y: 0 });
    return { lon: sum.x / ring.length, lat: sum.y / ring.length };
  }
  return { lon: cx / (6 * area), lat: cy / (6 * area) };
}

function parseFeature(f: RawFeature): Parcel | null {
  const rings = f.geometry?.rings;
  if (!rings?.length) return null;
  const a = f.attributes ?? {};
  const centroid = ringsCentroid(rings);
  if (!centroid) return null;

  const street = [
    str(a, "site_str_num"),
    str(a, "site_str_pfx"),
    str(a, "site_str_name"),
    str(a, "site_str_sfx"),
    str(a, "site_str_sfx_dir"),
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const city = str(a, "site_city") ?? "Houston";
  const zip = str(a, "site_zip");
  const address = street ? `${street}, ${city}, TX${zip ? " " + zip : ""}` : null;

  let lotSqft = num(a, "land_sqft");
  if (lotSqft == null) {
    const acres = num(a, "acreage_1");
    if (acres != null) lotSqft = Math.round(acres * 43560);
  }

  const ownedSince = (() => {
    const v = a["new_owner_date"];
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return null;
  })();

  const mailStreet = str(a, "mail_addr_1");
  const absenteeOwner =
    street && mailStreet ? normalizeStreet(mailStreet) !== normalizeStreet(street) : null;

  const mailingAddress = (() => {
    const s = str(a, "mail_addr_1");
    if (!s) return null;
    const tail = [str(a, "mail_city"), [str(a, "mail_state"), str(a, "mail_zip")].filter(Boolean).join(" ")]
      .filter(Boolean).join(", ");
    return tail ? `${s}, ${tail}` : s;
  })();

  return {
    hcadAccount: str(a, "HCAD_NUM") ?? "",
    lat: centroid.lat,
    lon: centroid.lon,
    rings,
    address,
    city,
    zip,
    ownerName: [str(a, "owner_name_1"), str(a, "owner_name_2")].filter(Boolean).join("; ") || null,
    appraisedValue: num(a, "total_appraised_val") ?? num(a, "total_market_val"),
    landValue: num(a, "land_value"),
    buildingValue: num(a, "bld_value"),
    lotSqft,
    legalDescription: [str(a, "legal_dscr_1"), str(a, "legal_dscr_2")].filter(Boolean).join(" ") || null,
    ownedSince,
    mailingAddress,
    absenteeOwner,
    landUse: str(a, "land_use"),
    stateClass: str(a, "state_class"),
  };
}

const sqlEscape = (s: string) => s.replace(/'/g, "''");

/** Canonical form for street comparison: uppercase, alphanumeric words,
 *  suffixes collapsed ("STREET" → "ST") so "5330 Indigo Street" == "5330 INDIGO ST". */
function normalizeStreet(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => SUFFIX_NORMALIZE[w] ?? w)
    .join(" ");
}

export type ParsedAddress = {
  streetNumber: number | null;
  streetName: string | null;
  suffix: string | null;
  zip: string | null;
};

const SUFFIXES = new Set([
  "ST", "STREET", "DR", "DRIVE", "RD", "ROAD", "LN", "LANE", "AVE", "AVENUE",
  "BLVD", "BOULEVARD", "CT", "COURT", "WAY", "CIR", "CIRCLE", "PL", "PLACE",
  "TRL", "TRAIL", "PKWY", "PARKWAY", "HWY", "HIGHWAY",
]);

const SUFFIX_NORMALIZE: Record<string, string> = {
  STREET: "ST", DRIVE: "DR", ROAD: "RD", AVENUE: "AVE", LANE: "LN",
  BOULEVARD: "BLVD", COURT: "CT", CIRCLE: "CIR", PLACE: "PL", TRAIL: "TRL",
  PARKWAY: "PKWY", HIGHWAY: "HWY",
};

// Words that mean "the address is over" in a spoken question:
// "what's 505 Westcott Street WORTH", "who OWNS 1220 Yale".
const NOISE_WORDS = new Set([
  "WORTH", "VALUE", "VALUED", "OWNER", "OWNS", "OWNED", "COST", "PRICE",
  "APPRAISED", "SELL", "SOLD", "SELLING", "SIZE", "BIG", "AND", "WHO", "WHAT",
  "HOUSTON", "TX", "TEXAS", "IN", "AT", "NEAR", "ON",
]);

/** Parse a spoken/typed address like "505 Westcott Street, Houston 77007". */
export function parseAddress(raw: string): ParsedAddress {
  const cleaned = raw.toUpperCase().replace(/[.,?!]/g, " ").replace(/\s+/g, " ").trim();
  const zipMatch = cleaned.match(/\b(77\d{3})\b/);
  const m = cleaned.match(/\b(\d{1,6})\s+([A-Z0-9 ]+)/);
  if (!m) return { streetNumber: null, streetName: null, suffix: null, zip: zipMatch?.[1] ?? null };
  const streetNumber = parseInt(m[1], 10);

  // Walk words until a suffix, noise word, or zip ends the street name.
  const nameWords: string[] = [];
  let suffix: string | null = null;
  for (const word of m[2].split(" ").filter(Boolean)) {
    if (SUFFIXES.has(word) && nameWords.length > 0) {
      suffix = SUFFIX_NORMALIZE[word] ?? word;
      break;
    }
    if (NOISE_WORDS.has(word) || /^77\d{3}$/.test(word)) break;
    nameWords.push(word);
  }

  return {
    streetNumber: Number.isFinite(streetNumber) ? streetNumber : null,
    streetName: nameWords.join(" ") || null,
    suffix,
    zip: zipMatch?.[1] ?? null,
  };
}

/** All parcels matching a situs address (stacked condos return many). */
export async function lookupByAddress(rawAddress: string): Promise<Parcel[]> {
  const parsed = parseAddress(rawAddress);
  if (!parsed.streetNumber || !parsed.streetName) return [];
  const where: string[] = [
    `site_str_num=${parsed.streetNumber}`,
    `site_str_name LIKE '${sqlEscape(parsed.streetName)}%'`,
  ];
  if (parsed.zip) where.push(`site_zip='${sqlEscape(parsed.zip)}'`);
  let feats = await queryHcad({ where: where.join(" AND "), resultRecordCount: "50" });
  // If zip over-constrained (spoken zips are error-prone), retry without it.
  if (!feats.length && parsed.zip) {
    feats = await queryHcad({
      where: where.slice(0, 2).join(" AND "),
      resultRecordCount: "50",
    });
  }
  let parcels = feats.map(parseFeature).filter((p): p is Parcel => p !== null);
  if (parsed.suffix && parcels.length > 1) {
    const withSfx = parcels.filter((p) => p.address?.toUpperCase().includes(` ${parsed.suffix} `));
    if (withSfx.length) parcels = withSfx;
  }
  return parcels;
}

export async function lookupByAccount(account: string): Promise<Parcel | null> {
  const digits = account.replace(/\D+/g, "");
  if (digits.length < 12 || digits.length > 15) return null;
  const normalized = digits.length === 13 ? digits : digits.length < 13 ? digits.padStart(13, "0") : digits.slice(-13);
  const feats = await queryHcad({ where: `HCAD_NUM='${normalized}'` });
  return feats.length ? parseFeature(feats[0]) : null;
}

export async function lookupByOwner(name: string, limit = 25): Promise<Parcel[]> {
  const cleaned = name.trim().toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 3) return [];
  const pattern = "%" + sqlEscape(cleaned.split(" ").join("%")) + "%";
  const where = ["owner_name_1", "owner_name_2"].map((c) => `UPPER(${c}) LIKE '${pattern}'`).join(" OR ");
  const feats = await queryHcad({ where, resultRecordCount: String(limit) });
  return feats.map(parseFeature).filter((p): p is Parcel => p !== null);
}

/** Every parcel whose TAX MAIL goes to a given street address — the entity
 *  resolver behind the LLC graph. Owner names lie (an LLC per deal); the
 *  mailbox is where the portfolio clusters. */
export async function lookupByMailAddress(
  mailAddr: string,
  mailZip?: string | null,
  limit = 100
): Promise<Parcel[]> {
  const words = mailAddr
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    // Suffix words flap between records ("ST" vs "STREET" vs absent) — match
    // on number + name words only.
    .filter((w) => !SUFFIXES.has(w));
  if (!words.length) return [];
  const pattern = "%" + sqlEscape(words.join("%")) + "%";
  const where: string[] = [`UPPER(mail_addr_1) LIKE '${pattern}'`];
  if (mailZip) where.push(`mail_zip LIKE '${sqlEscape(mailZip.slice(0, 5))}%'`);
  const feats = await queryHcad({ where: where.join(" AND "), resultRecordCount: String(limit) });
  return feats.map(parseFeature).filter((p): p is Parcel => p !== null);
}

/** Everything around a subject parcel, no type filters — raw material for
 *  adjacency/assemblage analysis. */
export async function lookupNeighbors(
  subject: Parcel,
  radiusMeters = 300,
  limit = 150
): Promise<Parcel[]> {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((subject.lat * Math.PI) / 180));
  const feats = await queryHcad({
    where: `HCAD_NUM<>'${sqlEscape(subject.hcadAccount)}'`,
    geometry: `${subject.lon - dLon},${subject.lat - dLat},${subject.lon + dLon},${subject.lat + dLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: String(limit),
  });
  return feats.map(parseFeature).filter((p): p is Parcel => p !== null);
}

/** Similar parcels around a subject: same land-use code, lot size ±40%,
 *  within radiusMeters of the centroid. The raw material for a comps read. */
export async function lookupComps(
  subject: Parcel,
  radiusMeters = 800,
  limit = 60
): Promise<Parcel[]> {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((subject.lat * Math.PI) / 180));
  const where: string[] = [`HCAD_NUM<>'${sqlEscape(subject.hcadAccount)}'`];
  if (subject.landUse) where.push(`land_use='${sqlEscape(subject.landUse)}'`);
  if (subject.lotSqft) {
    where.push(
      `land_sqft>=${Math.round(subject.lotSqft * 0.6)}`,
      `land_sqft<=${Math.round(subject.lotSqft * 1.4)}`
    );
  }
  const feats = await queryHcad({
    where: where.join(" AND "),
    geometry: `${subject.lon - dLon},${subject.lat - dLat},${subject.lon + dLon},${subject.lat + dLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: String(limit),
  });
  return feats.map(parseFeature).filter((p): p is Parcel => p !== null);
}

/** Parcels near a subject with the most recent owner changes — the deal
 *  radar. Sorted newest first. NOTE: HCAD's snapshot lags reality by months,
 *  so we take the newest on record rather than filtering by a hard date
 *  (a "last 90 days" clause can land entirely inside the data gap). */
export async function lookupRecentTransfers(
  subject: Parcel,
  radiusMeters = 1600,
  limit = 8
): Promise<Parcel[]> {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((subject.lat * Math.PI) / 180));
  const feats = await queryHcad({
    where: `new_owner_date IS NOT NULL AND HCAD_NUM<>'${sqlEscape(subject.hcadAccount)}'`,
    geometry: `${subject.lon - dLon},${subject.lat - dLat},${subject.lon + dLon},${subject.lat + dLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    orderByFields: "new_owner_date DESC",
    resultRecordCount: String(limit),
  });
  return feats.map(parseFeature).filter((p): p is Parcel => p !== null);
}

export async function lookupNearest(lat: number, lon: number, radiusMeters = 60): Promise<Parcel | null> {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const feats = await queryHcad({
    geometry: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: "25",
  });
  const parcels = feats.map(parseFeature).filter((p): p is Parcel => p !== null);
  if (!parcels.length) return null;
  const dist = (p: Parcel) => {
    const dx = (p.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dy = (p.lat - lat) * 111320;
    return Math.hypot(dx, dy);
  };
  return parcels.sort((a, b) => dist(a) - dist(b))[0];
}
