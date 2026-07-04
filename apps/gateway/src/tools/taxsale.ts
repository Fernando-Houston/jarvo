// Tax-delinquency signal via the LGBS tax-sale listings (taxsales.lgbs.com —
// Linebarger, Harris County's delinquent-tax collection firm). These are
// parcels where delinquency has gone LEGAL: suit filed, judgment taken, or
// auction scheduled/struck off. It is the sharpest motivated-seller signal
// publicly visible — but it is NOT the full delinquent roll (owners merely
// behind on taxes, short of a lawsuit, don't appear). Speak that honestly.

const LGBS_URL = "https://taxsales.lgbs.com/api/property_sales/";

export type TaxSaleRecord = {
  hcadAccount: string;
  saleType: string; // SALE | RESALE | STRUCK OFF | FUTURE SALE
  status: string; // e.g. "Scheduled for Auction", "Available for Future Sale"
  saleDate: string | null; // "2026-08-04"
  minimumBid: number | null;
  causeNumber: string | null;
  address: string | null;
  zip: string | null;
  appraisedValue: number | null;
  lat: number | null;
  lon: number | null;
};

type LgbsRow = {
  account_nbr?: string;
  sale_type?: string;
  status?: string;
  sale_date_only?: string | null;
  minimum_bid?: string | number | null;
  cause_nbr?: string | null;
  prop_address_one?: string;
  prop_city?: string;
  prop_zipcode?: string;
  value?: string | number | null;
  geometry?: { coordinates?: [number, number] } | null;
};

function parseRow(r: LgbsRow): TaxSaleRecord | null {
  if (!r.account_nbr) return null;
  const num = (v: string | number | null | undefined) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const zip = r.prop_zipcode?.slice(0, 5) ?? null;
  return {
    hcadAccount: r.account_nbr,
    saleType: r.sale_type ?? "UNKNOWN",
    status: r.status ?? "unknown",
    saleDate: r.sale_date_only ?? null,
    minimumBid: num(r.minimum_bid),
    causeNumber: r.cause_nbr || null,
    address: r.prop_address_one
      ? `${r.prop_address_one}, ${r.prop_city ?? "Houston"}, TX${zip ? " " + zip : ""}`
      : null,
    zip,
    appraisedValue: num(r.value),
    lat: r.geometry?.coordinates?.[1] ?? null,
    lon: r.geometry?.coordinates?.[0] ?? null,
  };
}

async function queryLgbs(params: Record<string, string>): Promise<TaxSaleRecord[]> {
  const search = new URLSearchParams({
    county: "HARRIS COUNTY",
    state: "TX",
    ...params,
  });
  const res = await fetch(`${LGBS_URL}?${search}`, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Tax-sale lookup failed: HTTP ${res.status}`);
  const json = (await res.json()) as { results?: LgbsRow[] };
  return (json.results ?? []).map(parseRow).filter((r): r is TaxSaleRecord => r !== null);
}

/** Is this specific parcel in the tax-sale pipeline? */
export async function taxSaleCheck(hcadAccount: string): Promise<TaxSaleRecord | null> {
  const digits = hcadAccount.replace(/\D+/g, "");
  const rows = await queryLgbs({ account_nbr: digits, limit: "3" });
  return rows[0] ?? null;
}

/** Distressed parcels near a point — the motivated-seller radar. */
export async function taxSaleNear(
  lat: number,
  lon: number,
  radiusMeters = 1600,
  limit = 20
): Promise<TaxSaleRecord[]> {
  const dLat = radiusMeters / 111320;
  const dLon = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const rows = await queryLgbs({
    in_bbox: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    limit: String(limit),
  });
  // Nearest first, scheduled auctions before future sales.
  const rank = (r: TaxSaleRecord) => (r.saleDate ? 0 : 1);
  const dist = (r: TaxSaleRecord) =>
    r.lat != null && r.lon != null
      ? Math.hypot((r.lon - lon) * Math.cos((lat * Math.PI) / 180), r.lat - lat)
      : Infinity;
  return rows.sort((a, b) => rank(a) - rank(b) || dist(a) - dist(b));
}

export const TAX_SALE_SOURCE_NOTE =
  "source: Linebarger tax-sale listings (suits/judgments/auctions) — owners merely behind on taxes without a lawsuit do NOT appear";
