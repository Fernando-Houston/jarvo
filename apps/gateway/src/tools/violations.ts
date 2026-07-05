// City of Houston code-enforcement violations (Department of Neighborhoods
// IPS, Chapter 10 ordinance enforcement) via the city's CKAN datastore —
// free, structured, and keyed by HCAD account number directly.
//
// HONESTY LINE (verified 2026-07-05): the city's published feed covers
// 2014 through AUGUST 2018 and has not been updated since — this is a
// HISTORY of enforcement (chronic-problem owners, tired-owner signal, a
// gentle talking point), never current violation status. A companion
// resource holds 2003–2014 if deeper history is ever wanted.

import { kvCached } from "./kvcache";

const DATASTORE_URL = "https://data.houstontx.gov/api/3/action/datastore_search";
/** "All Code Enforcement Violations in FORMS Since 2014" (2014 – Aug 2018). */
const RESOURCE_ID = "1446a3ec-2633-4cf1-b15d-6dae9a07c4ed";

export const VIOLATIONS_SOURCE_NOTE =
  "City of Houston DON code-enforcement records; the public feed covers 2014 through August 2018 and is no longer updated — enforcement HISTORY, not current status.";

export type ViolationRecord = {
  date: string | null; // ISO date
  category: string | null;
  status: string | null;
  description: string | null;
};

export type ViolationHistory = {
  count: number;
  /** Distinct violation categories, most frequent first. */
  categories: string[];
  openCount: number;
  newest: string | null;
  oldest: string | null;
  records: ViolationRecord[];
};

type RawRow = Record<string, unknown>;

function parseRow(r: RawRow): ViolationRecord {
  const date = typeof r.RecordCreateDate === "string" ? r.RecordCreateDate.slice(0, 10) : null;
  return {
    date,
    category: (r.Violation_Category as string | null)?.trim() || null,
    status: (r.Project_Status as string | null)?.trim() || null,
    description: (r.ShortDescription as string | null)?.trim().slice(0, 120) || null,
  };
}

/** Enforcement history for one parcel, straight off the HCAD key. */
export async function violationHistory(hcadAccount: string): Promise<ViolationHistory> {
  const rows = await kvCached("violations", hcadAccount, 86_400, async () => {
    const url =
      `${DATASTORE_URL}?resource_id=${RESOURCE_ID}` +
      `&filters=${encodeURIComponent(JSON.stringify({ HCAD: hcadAccount }))}&limit=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`City datastore failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      success?: boolean;
      result?: { records?: RawRow[] };
      error?: unknown;
    };
    if (!json.success) throw new Error("City datastore returned an error");
    return (json.result?.records ?? []).map(parseRow);
  });

  // The feed repeats a project row per violation line — dedupe on the tuple.
  const seen = new Set<string>();
  const records = rows.filter((r) => {
    const k = `${r.date}|${r.category}|${r.description}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const byCat = new Map<string, number>();
  for (const r of records) {
    if (r.category) byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1);
  }
  const dates = records.map((r) => r.date).filter(Boolean).sort() as string[];
  return {
    count: records.length,
    categories: [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c),
    openCount: records.filter((r) => r.status && !/closed|complete/i.test(r.status)).length,
    newest: dates[dates.length - 1] ?? null,
    oldest: dates[0] ?? null,
    records: records.slice(0, 10),
  };
}
