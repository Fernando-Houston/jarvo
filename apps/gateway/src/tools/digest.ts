// The nightly digest: what moved overnight around the team's pipeline.
// Runs on a Worker cron (7am Houston), stores the result in Workers KV, and
// fans out as push notifications. Also exposed as the `nightly_digest` voice
// tool so "what's new?" speaks the same brief.
//
// Honesty contract: every transfer we report is an HCAD deed RECORDING (which
// trails the courthouse by weeks-to-months), spoken with its real month/year.
// "Fresh" means fresh TO US — newly visible in the snapshot since the last
// sweep — not "recorded last night".

import { listLeads } from "./crm";
import { lookupByAccount, lookupRecentTransfers, type Parcel } from "./hcad";

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
const SWEEP_RADIUS_M = 1600;
const MAX_AREAS = 6;

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
    firstRun: boolean;
  };
};

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
  for (const lead of areas) {
    let subject: Parcel | null = null;
    let transfers: Parcel[] = [];
    try {
      subject = await lookupByAccount(lead.hcadAccount!);
      if (!subject) continue;
      transfers = await lookupRecentTransfers(subject, SWEEP_RADIUS_M, 8);
    } catch {
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
  }

  if (addedThisWeek.length) {
    const newest = addedThisWeek[0];
    bullets.push(
      `Pipeline: ${addedThisWeek.length} lead${addedThisWeek.length === 1 ? "" : "s"} added this week — newest ${shortAddr(newest.address)}${newest.status ? `, marked ${newest.status.replace(/_/g, " ")}` : ""}.`
    );
  }
  if (!crmOk) bullets.push("The CRM wasn't reachable during this sweep — pipeline items may be missing.");
  if (!bullets.length) bullets.push("Quiet night — no new recordings around your tracked leads, no pipeline changes.");
  if (freshTransfers) {
    bullets.push("Deed dates are HCAD recordings, which trail the courthouse by weeks to months.");
  }

  const dateSpoken = new Date().toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });
  const headline = freshTransfers
    ? `${freshTransfers} fresh deed recording${freshTransfers === 1 ? "" : "s"} near your leads, ${hot.length} hot lead${hot.length === 1 ? "" : "s"} active.`
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
      firstRun,
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
