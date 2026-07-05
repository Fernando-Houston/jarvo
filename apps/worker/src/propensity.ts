// Propensity engine v1 (NEXT-HORIZON §2): score every tracked-zip parcel
// from the LATEST R2 Time Machine snapshot — no HCAD hammering; the archive
// already holds all 62 fields — and keep the top N per zip in Workers KV
// for the hot_list tool and the digest.
//
// Signals (shared weights in gateway tools/propensityScore.ts): teardown
// ratio, absentee mail, hold length, ESTATE-on-title. Tax distress is a
// radius-scale signal (LGBS can't be joined across 1.5M rows) — the digest's
// radius scan layers it on near leads; hot_list results say so honestly.
//
// Execution mirrors the snapshot DO: an alarm chain, a couple of gzipped
// NDJSON parts per run, state in DO storage. A county month is ~155 parts.
//
// Output:
//   propensity:v1:<zip>   top TOP_PER_ZIP candidates, scored + reasoned
//   propensity:meta:v1    {month, generatedAt, zips, rowsScanned, kept}

import { scorePropensity, PROPENSITY_FLOOR } from "../../gateway/src/tools/propensityScore";
import { institutionalName } from "../../gateway/src/tools/entity";
import { normalizeStreet } from "../../gateway/src/tools/hcad";

export const PARTS_PER_RUN = 2;
export const TOP_PER_ZIP = 20;

export type PropensityCandidate = {
  hcadAccount: string;
  address: string | null;
  owner: string | null;
  zip: string;
  score: number;
  reasons: string[];
  appraisedValue: number | null;
  lotSqft: number | null;
};

export type PropensityState = {
  month: string;
  /** R2 part keys still to scan. */
  queue: string[];
  partsTotal: number;
  zips: string[];
  rowsScanned: number;
  kept: number;
  startedAt: string;
  finishedAt: string | null;
  errors: string[];
};

type Attrs = Record<string, unknown>;

const str = (a: Attrs, k: string): string | null => {
  const v = a[k];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};
const num = (a: Attrs, k: string): number | null => {
  const v = a[k];
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Score one raw snapshot row (HCAD attribute names, no geometry). */
export function scoreSnapshotRow(a: Attrs): PropensityCandidate | null {
  const zip = str(a, "site_zip");
  const account = str(a, "HCAD_NUM");
  if (!zip || !account) return null;
  const owner = [str(a, "owner_name_1"), str(a, "owner_name_2")].filter(Boolean).join("; ") || null;
  if (!owner || institutionalName(owner)) return null;

  const street = [
    str(a, "site_str_num"),
    str(a, "site_str_pfx"),
    str(a, "site_str_name"),
    str(a, "site_str_sfx"),
    str(a, "site_str_sfx_dir"),
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const mailStreet = str(a, "mail_addr_1");
  const absenteeOwner = street && mailStreet ? normalizeStreet(mailStreet) !== normalizeStreet(street) : null;

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

  const appraisedValue = num(a, "total_appraised_val") ?? num(a, "total_market_val");
  const { score, reasons } = scorePropensity({
    appraisedValue,
    buildingValue: num(a, "bld_value"),
    lotSqft,
    absenteeOwner,
    ownedSince,
    ownerName: owner,
  });
  if (score < PROPENSITY_FLOOR) return null;
  const city = str(a, "site_city") ?? "Houston";
  return {
    hcadAccount: account,
    address: street ? `${street}, ${city}, TX ${zip}` : null,
    owner,
    zip,
    score,
    reasons,
    appraisedValue,
    lotSqft,
  };
}

async function gunzipLines(buf: ArrayBuffer): Promise<string[]> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return text.split("\n").filter(Boolean);
}

/** Insert into a size-capped, score-sorted top list. */
export function insertTop(list: PropensityCandidate[], c: PropensityCandidate): PropensityCandidate[] {
  list.push(c);
  list.sort((x, y) => y.score - x.score);
  return list.slice(0, TOP_PER_ZIP);
}

/** One alarm-run's worth: scan up to PARTS_PER_RUN parts, merging keepers
 *  into the caller-provided per-zip tops (persisted by the DO between runs). */
export async function propensityChunk(
  bucket: R2Bucket,
  state: PropensityState,
  zipSet: Set<string>,
  getTop: (zip: string) => Promise<PropensityCandidate[]>,
  putTop: (zip: string, list: PropensityCandidate[]) => Promise<void>
): Promise<PropensityState> {
  for (let i = 0; i < PARTS_PER_RUN; i++) {
    const key = state.queue.shift();
    if (!key) break;
    try {
      const obj = await bucket.get(key);
      if (!obj) {
        state.errors.push(`${key}: missing`);
        continue;
      }
      const lines = await gunzipLines(await obj.arrayBuffer());
      // Batch keepers per zip so DO storage sees one read+write per zip per part.
      const keepers = new Map<string, PropensityCandidate[]>();
      for (const line of lines) {
        state.rowsScanned++;
        let a: Attrs;
        try {
          a = JSON.parse(line) as Attrs;
        } catch {
          continue;
        }
        const zip = str(a, "site_zip");
        if (!zip || !zipSet.has(zip)) continue;
        const cand = scoreSnapshotRow(a);
        if (!cand) continue;
        (keepers.get(zip) ?? keepers.set(zip, []).get(zip)!).push(cand);
      }
      for (const [zip, cands] of keepers) {
        let top = await getTop(zip);
        for (const c of cands) top = insertTop(top, c);
        await putTop(zip, top);
        state.kept += cands.length;
      }
    } catch (err) {
      state.errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!state.queue.length) state.finishedAt = new Date().toISOString();
  return state;
}

/** Latest month with county parts in R2 (falls back to zip-part months). */
export async function latestSnapshotMonth(bucket: R2Bucket): Promise<{ month: string; keys: string[] } | null> {
  const byMonth = new Map<string, string[]>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "snap:v1:", cursor, limit: 1000 });
    for (const o of page.objects) {
      const m = o.key.match(/^snap:v1:(\d{4}-\d{2}):/);
      if (m) (byMonth.get(m[1]) ?? byMonth.set(m[1], []).get(m[1])!).push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const months = [...byMonth.keys()].sort().reverse();
  for (const month of months) {
    const keys = byMonth.get(month)!;
    const county = keys.filter((k) => k.includes(`:${month}:county:`));
    if (county.length) return { month, keys: county };
    if (keys.length) return { month, keys };
  }
  return null;
}
