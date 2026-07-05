// The nightly digest: what moved overnight around the team's pipeline.
// Runs on a Worker cron (7am Houston), stores the result in Workers KV, and
// fans out as push notifications. Also exposed as the `nightly_digest` voice
// tool so "what's new?" speaks the same brief.
//
// Honesty contract: every transfer we report is an HCAD deed RECORDING (which
// trails the courthouse by weeks-to-months), spoken with its real month/year.
// "Fresh" means fresh TO US — newly visible in the snapshot since the last
// sweep — not "recorded last night".

import { listLeads, LEAD_STATUSES } from "./crm";
import { lookupByAccount, lookupNeighbors, lookupRecentTransfers, type Parcel } from "./hcad";
import { institutionalOwner } from "./entity";
import { scorePropensity, PROPENSITY_FLOOR } from "./propensityScore";
import { taxSaleNear, type TaxSaleRecord } from "./taxsale";

/** Minimal async KV surface — Workers KV in the cloud, in-memory in Node dev. */
export type DigestStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

// The Worker mirrors its KV binding here (gateway code can't see bindings);
// plain Node falls back to process-local memory, which is fine for dev.
const memStore = new Map<string, string>();
export function digestStore(): DigestStore {
  const kv = (globalThis as { __hviKv?: DigestStore }).__hviKv;
  if (kv) return { get: (k) => kv.get(k), put: (k, v) => kv.put(k, v) };
  return {
    get: async (k) => memStore.get(k) ?? null,
    put: async (k, v) => void memStore.set(k, v),
  };
}

const SEEN_KEY = "digest:seen:v1";
const LATEST_KEY = "digest:latest:v1";
const TRACE_KEY = "digest:trace:v1";
const SWEEP_RADIUS_M = 1600;
const MAX_AREAS = 6;
/** Propensity scan is a subrequest budget item — only the hottest areas. */
const MAX_TRACE_AREAS = 3;
const MAX_TRACE_CANDIDATES = 5;
/** Minimum propensity score to be worth offering a paid trace on. */
const TRACE_SCORE_FLOOR = PROPENSITY_FLOOR;

export type Digest = {
  generatedAt: string;
  /** One-sentence push-notification body. */
  headline: string;
  bullets: string[];
  /** The whole brief as one speakable paragraph. */
  spoken: string;
  stats: {
    pipelineLeads: number;
    hotLeads: number;
    areasSwept: number;
    freshTransfers: number;
    freshDistress: number;
    firstRun: boolean;
    /** High-propensity non-lead parcels stored for the "trace the top N" offer. */
    traceCandidates?: number;
    /** Reachability of each external source this sweep — "quiet" is only
     *  trustworthy when these are "ok". */
    sourceHealth?: { hcad: string; lgbs: string; crm: string };
  };
};

/** A parcel worth paying to trace: near the pipeline, scoring high on the
 *  sell-propensity signals, and NOT already a lead. Tracing only ever runs
 *  when the user says yes (trace_top_candidates) — never in the sweep. */
export type TraceCandidate = {
  hcadAccount: string;
  address: string | null;
  owner: string | null;
  nearLead: string | null;
  score: number;
  /** Speakable reasons, e.g. "building 6% of value", "absentee 22 years". */
  reasons: string[];
};

export async function getTraceCandidates(
  store: DigestStore = digestStore()
): Promise<{ generatedAt: string; candidates: TraceCandidate[] } | null> {
  const raw = await store.get(TRACE_KEY);
  return raw ? (JSON.parse(raw) as { generatedAt: string; candidates: TraceCandidate[] }) : null;
}

/** Sell-propensity score — the shared transparent weighted sum
 *  (propensityScore.ts), fed from a live Parcel plus the area's tax data. */
function scoreParcel(p: Parcel, inTaxPipeline: boolean): { score: number; reasons: string[] } {
  return scorePropensity({
    appraisedValue: p.appraisedValue,
    buildingValue: p.buildingValue,
    lotSqft: p.lotSqft,
    absenteeOwner: p.absenteeOwner,
    ownedSince: p.ownedSince,
    ownerName: p.ownerName,
    inTaxPipeline,
  });
}

function money(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `$${Math.round(n / 1000)}k`;
}

function monthYear(iso: string | null): string {
  if (!iso) return "date unknown";
  return new Date(iso + "T00:00:00Z").toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const shortAddr = (a: string | null) =>
  (a?.split(",")[0] ?? "an unaddressed lot").replace(/^0 /, "the lot on ");

/** Compose today's digest and advance the seen-baseline. */
export async function runNightlyDigest(store: DigestStore = digestStore()): Promise<Digest> {
  const bullets: string[] = [];
  let leads: Awaited<ReturnType<typeof listLeads>> = [];
  let crmOk = true;
  try {
    leads = await listLeads(["hot_lead", "new", "revisit"], 24);
  } catch {
    crmOk = false;
  }

  const hot = leads.filter((l) => l.status === "hot_lead");
  const weekAgo = Date.now() - 7 * 86400_000;
  const addedThisWeek = leads.filter(
    (l) => l.createdAt && new Date(l.createdAt).getTime() >= weekAgo
  );

  // Seen baseline: transfer identities (account + recorded date) already
  // reported. First run seeds the baseline and reports only the freshest
  // recording per area, so day one isn't a wall of old deeds.
  const seenRaw = await store.get(SEEN_KEY);
  const firstRun = seenRaw == null;
  const seen = new Set<string>(seenRaw ? (JSON.parse(seenRaw) as string[]) : []);

  // Sweep hot areas first, then the newest of the rest.
  const areas = [...hot, ...leads.filter((l) => l.status !== "hot_lead")]
    .filter((l) => l.hcadAccount)
    .slice(0, MAX_AREAS);

  let areasSwept = 0;
  let freshTransfers = 0;
  let freshDistress = 0;
  // Source-health canaries: count attempts vs failures per external source so
  // the digest can distinguish a genuinely quiet night from a BLIND one (a
  // source was down). HCAD went fully down during testing 2026-07-05 — a
  // silent "quiet night" then would have been a lie.
  const health = { hcadTry: 0, hcadFail: 0, lgbsTry: 0, lgbsFail: 0 };
  /** Hydrated area subjects + their tax-distress accounts, reused by the
   *  propensity scan below so it costs no extra HCAD/LGBS calls per signal. */
  const sweptAreas: Array<{ leadAddress: string | null; subject: Parcel; distressAccounts: Set<string> }> = [];
  for (const lead of areas) {
    let subject: Parcel | null = null;
    let transfers: Parcel[] = [];
    health.hcadTry++;
    try {
      subject = await lookupByAccount(lead.hcadAccount!);
      if (!subject) continue;
      transfers = await lookupRecentTransfers(subject, SWEEP_RADIUS_M, 8);
    } catch {
      health.hcadFail++;
      continue; // HCAD hiccup on one area shouldn't sink the digest
    }
    areasSwept++;
    const fresh = transfers.filter((t) => !seen.has(`${t.hcadAccount}:${t.ownedSince}`));
    for (const t of transfers) seen.add(`${t.hcadAccount}:${t.ownedSince}`);
    const report = firstRun ? fresh.slice(0, 1) : fresh.slice(0, 3);
    for (const t of report) {
      freshTransfers++;
      bullets.push(
        `${firstRun ? "Newest deed on record" : "Fresh deed"} near ${shortAddr(lead.address)}: ` +
          `${shortAddr(t.address)} went to ${t.ownerName ?? "a new owner"}, recorded ${monthYear(t.ownedSince)}` +
          (t.appraisedValue ? ` (appraised ${money(t.appraisedValue)})` : "") +
          "."
      );
    }

    // Tax distress: owners near this lead newly in the delinquency legal
    // pipeline (suit/judgment/auction). Same seen-baseline dance.
    let distress: TaxSaleRecord[] = [];
    health.lgbsTry++;
    try {
      distress = await taxSaleNear(subject.lat, subject.lon, SWEEP_RADIUS_M, 20);
    } catch {
      health.lgbsFail++;
      /* LGBS hiccup — skip distress for this area */
    }
    sweptAreas.push({
      leadAddress: lead.address,
      subject,
      distressAccounts: new Set(distress.map((d) => d.hcadAccount)),
    });
    const freshD = distress.filter((d) => !seen.has(`ts:${d.hcadAccount}:${d.saleType}`));
    for (const d of distress) seen.add(`ts:${d.hcadAccount}:${d.saleType}`);
    for (const d of (firstRun ? freshD.slice(0, 1) : freshD.slice(0, 3))) {
      freshDistress++;
      bullets.push(
        `Tax distress near ${shortAddr(lead.address)}: ${shortAddr(d.address)} is ${d.status.toLowerCase()}` +
          (d.saleDate ? ` — auction ${monthYear(d.saleDate)}` : "") +
          (d.minimumBid ? `, minimum bid ${money(d.minimumBid)}` : "") +
          (d.appraisedValue ? ` (appraised ${money(d.appraisedValue)})` : "") +
          "."
      );
    }
  }

  // ── Propensity scan (NEXT-HORIZON §1.2B): high-scoring NON-lead parcels
  // near the hottest areas become a trace OFFER in the digest. No lead is
  // created and no provider is called here — money and PII only move when
  // the user says "trace the top N".
  let traceCandidates: TraceCandidate[] = [];
  try {
    const allLeads = await listLeads([...LEAD_STATUSES], 500);
    const leadAccounts = new Set(allLeads.map((l) => l.hcadAccount).filter(Boolean) as string[]);
    const byAccount = new Map<string, TraceCandidate>();
    for (const area of sweptAreas.slice(0, MAX_TRACE_AREAS)) {
      let neighbors: Parcel[] = [];
      try {
        neighbors = await lookupNeighbors(area.subject, 800, 150);
      } catch {
        continue; // one area's HCAD hiccup shouldn't sink the scan
      }
      for (const p of neighbors) {
        if (leadAccounts.has(p.hcadAccount) || byAccount.has(p.hcadAccount)) continue;
        if (p.hcadAccount === area.subject.hcadAccount || institutionalOwner(p) || !p.ownerName) continue;
        const { score, reasons } = scoreParcel(p, area.distressAccounts.has(p.hcadAccount));
        if (score < TRACE_SCORE_FLOOR) continue;
        byAccount.set(p.hcadAccount, {
          hcadAccount: p.hcadAccount,
          address: p.address,
          owner: p.ownerName,
          nearLead: area.leadAddress,
          score,
          reasons,
        });
      }
    }
    traceCandidates = [...byAccount.values()].sort((a, b) => b.score - a.score).slice(0, MAX_TRACE_CANDIDATES);
    await store.put(TRACE_KEY, JSON.stringify({ generatedAt: new Date().toISOString(), candidates: traceCandidates }));
    if (traceCandidates.length) {
      const top = traceCandidates[0];
      bullets.push(
        `${traceCandidates.length} high-propensity owner${traceCandidates.length === 1 ? " is" : "s are"} un-traced near your pipeline — sharpest is ${shortAddr(top.address)} (${top.reasons.join(", ")}). Want me to trace the top ${Math.min(traceCandidates.length, 3)}? Only on your say-so.`
      );
    }
  } catch {
    /* propensity scan is a bonus — never sinks the digest */
  }

  // County-scale hot list (monthly engine over the R2 archive): one pointer
  // line when a ranking exists, so the digest teaches the habit.
  try {
    const metaRaw = await store.get("propensity:meta:v1");
    if (metaRaw) {
      const meta = JSON.parse(metaRaw) as { month?: string; zipCounts?: Record<string, number> };
      const total = Object.values(meta.zipCounts ?? {}).reduce((n, c) => n + c, 0);
      if (total) {
        bullets.push(
          `The monthly hot list holds ${total} scored prospects across your zips (${meta.month} county archive) — say "hot list" with a lead on screen to walk the top ones.`
        );
      }
    }
  } catch {
    /* pointer line only */
  }

  if (addedThisWeek.length) {
    const newest = addedThisWeek[0];
    bullets.push(
      `Pipeline: ${addedThisWeek.length} lead${addedThisWeek.length === 1 ? "" : "s"} added this week — newest ${shortAddr(newest.address)}${newest.status ? `, marked ${newest.status.replace(/_/g, " ")}` : ""}.`
    );
  }
  // ── Health canaries: a source that failed EVERY attempt was down, not
  // quiet — say so, loudly and first, so nobody trusts a blind sweep. A
  // partial failure (some areas errored) gets a softer heads-up.
  const hcadDown = health.hcadTry > 0 && health.hcadFail === health.hcadTry;
  const lgbsDown = health.lgbsTry > 0 && health.lgbsFail === health.lgbsTry;
  const hcadFlaky = !hcadDown && health.hcadFail > 0;
  const lgbsFlaky = !lgbsDown && health.lgbsFail > 0;
  const canaries: string[] = [];
  if (hcadDown) canaries.push("Harris County records (HCAD) were unreachable all through this sweep — I could not check for new deeds, so a quiet report tonight means blind, not clear.");
  if (lgbsDown) canaries.push("The county tax-sale listings were unreachable this sweep — no distress could be checked tonight.");
  if (hcadFlaky) canaries.push(`HCAD was flaky tonight — ${health.hcadFail} of ${health.hcadTry} area lookups failed, so some new deeds may be missing.`);
  if (lgbsFlaky) canaries.push(`The tax-sale listings were flaky tonight — ${health.lgbsFail} of ${health.lgbsTry} checks failed.`);
  if (!crmOk) {
    // CRM down cascades: no leads → nothing to sweep → HCAD/LGBS never even
    // tried, so this isn't "quiet", it's blind. Say so plainly.
    canaries.push(
      health.hcadTry === 0
        ? "The CRM was unreachable — I couldn't read the pipeline, so nothing could be swept tonight. This is blind, not quiet."
        : "The CRM wasn't reachable during this sweep — pipeline items may be missing."
    );
  }
  // Canaries lead the brief when present.
  if (canaries.length) bullets.unshift(...canaries);
  // "Blind" = every source we depend on was unusable: the CRM failed (so we
  // never swept), or HCAD was down with no working distress fallback.
  const allSourcesBlind =
    (!crmOk && health.hcadTry === 0) || (hcadDown && (lgbsDown || health.lgbsTry === 0) && !crmOk);
  if (!bullets.length) {
    bullets.push("Quiet night — no new recordings, no new tax distress around your tracked leads, no pipeline changes.");
  }
  if (freshTransfers) {
    bullets.push("Deed dates are HCAD recordings, which trail the courthouse by weeks to months.");
  }
  if (freshDistress) {
    bullets.push("Tax distress comes from the county collection firm's sale listings — suits and auctions only, not the full delinquent roll.");
  }

  const dateSpoken = new Date().toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });
  const moved = freshTransfers + freshDistress;
  const sourcesDown = [hcadDown && "HCAD", lgbsDown && "tax listings", !crmOk && "CRM"].filter(Boolean);
  const headline = allSourcesBlind
    ? "Data sources were down overnight — tonight's sweep is blind, not quiet."
    : moved
      ? [
          freshTransfers ? `${freshTransfers} fresh deed${freshTransfers === 1 ? "" : "s"}` : "",
          freshDistress ? `${freshDistress} new tax-distress flag${freshDistress === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(", ") + ` near your leads. ${hot.length} hot lead${hot.length === 1 ? "" : "s"} active.`
      : sourcesDown.length
        // Don't sell a "quiet night" when a source was blind — flag it in the push.
        ? `Quiet, but ${sourcesDown.join(" & ")} ${sourcesDown.length === 1 ? "was" : "were"} down — may be blind. ${hot.length} hot lead${hot.length === 1 ? "" : "s"}.`
        : `Quiet night. ${leads.length} active lead${leads.length === 1 ? "" : "s"}, ${hot.length} hot.`;
  const spoken = `Overnight digest for ${dateSpoken}. ${bullets.join(" ")}`;

  const digest: Digest = {
    generatedAt: new Date().toISOString(),
    headline,
    bullets,
    spoken,
    stats: {
      pipelineLeads: leads.length,
      hotLeads: hot.length,
      areasSwept,
      freshTransfers,
      freshDistress,
      firstRun,
      traceCandidates: traceCandidates.length,
      sourceHealth: {
        hcad: hcadDown ? "down" : hcadFlaky ? "flaky" : "ok",
        lgbs: lgbsDown ? "down" : lgbsFlaky ? "flaky" : "ok",
        crm: crmOk ? "ok" : "down",
      },
    },
  };

  // Cap the baseline so it can't grow without bound (8 per area per night).
  await store.put(SEEN_KEY, JSON.stringify([...seen].slice(-4000)));
  await store.put(LATEST_KEY, JSON.stringify(digest));
  return digest;
}

export async function getLatestDigest(store: DigestStore = digestStore()): Promise<Digest | null> {
  const raw = await store.get(LATEST_KEY);
  return raw ? (JSON.parse(raw) as Digest) : null;
}
