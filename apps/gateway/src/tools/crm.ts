// Land Lead Hub CRM (Supabase via Lovable Cloud) — lead intelligence for the
// voice pipeline. Two auth paths, best available wins:
//   1. Service-role key (bypasses RLS) — not obtainable on Lovable Cloud today.
//   2. Dedicated service user: publishable (anon) key + bot login. RLS applies
//      as a normal team member — read/write leads & notes, no deletes. This is
//      the recommended path per Lovable's own guidance.
// Every function degrades to a clear "unavailable" result when unconfigured.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Parcel } from "./hcad";

let client: SupabaseClient | null = null;
let signedIn = false;
let signInFailed: string | null = null;
let botUserId: string | null = null;

export function crmAvailable(): boolean {
  const url = process.env.SUPABASE_URL;
  if (!url) return false;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return true;
  return Boolean(
    process.env.SUPABASE_ANON_KEY && process.env.HVI_CRM_EMAIL && process.env.HVI_CRM_PASSWORD
  );
}

async function getClient(): Promise<SupabaseClient | null> {
  if (!crmAvailable() || signInFailed) return null;
  if (client && (signedIn || process.env.SUPABASE_SERVICE_ROLE_KEY)) return client;

  const url = process.env.SUPABASE_URL!;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    return client;
  }

  // Service-user path: sign in once; supabase-js auto-refreshes the token.
  client = createClient(url, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: process.env.HVI_CRM_EMAIL!,
    password: process.env.HVI_CRM_PASSWORD!,
  });
  if (error) {
    signInFailed = error.message;
    console.error(`[crm] service-user sign-in failed: ${error.message}`);
    client = null;
    return null;
  }
  signedIn = true;
  botUserId = data.user?.id ?? null;
  console.log("[crm] signed in as service user");
  return client;
}

export type LeadPhone = {
  number: string;
  /** e.g. "bad" — the team marked it a wrong number; never dial these. */
  status: string | null;
  badReason: string | null;
  /** Who the number traced to, when enrichment knows. */
  contactName: string | null;
  source: string | null;
  confidence: number | null;
  /** On the Do-Not-Call registry (per the trace provider) — visible, never dialable. */
  dnc: boolean;
};

export type LeadContacts = {
  phones: LeadPhone[];
  primaryPhone: string | null;
  /** Free-text contact notes from the team (sometimes holds emails). */
  contactInfo: string | null;
  source: string | null;
  matchConfidence: number | null;
  needsReview: boolean;
};

export type LeadSummary = {
  id: string;
  status: string | null;
  ownerName: string | null;
  propertyAddress: string | null;
  hasPhone: boolean;
  createdAt: string | null;
  contacts: LeadContacts | null;
};

/** Is this parcel already a lead in the team's pipeline? Keyed by HCAD account. */
export async function checkLead(hcadAccount: string): Promise<
  | { available: false }
  | { available: true; found: false }
  | { available: true; found: true; lead: LeadSummary }
> {
  const db = await getClient();
  if (!db) return { available: false };
  const { data, error } = await db
    .from("leads")
    .select(
      "id,status,owner_name,property_address,primary_phone,preferred_phone,phone_1,phone_2,phone_3,phones,contact_info,contact_source,contact_match_confidence,contact_needs_review,created_at"
    )
    .eq("hcad_account", hcadAccount)
    .maybeSingle();
  if (error) throw new Error(`CRM lead check failed: ${error.message}`);
  if (!data) return { available: true, found: false };
  return {
    available: true,
    found: true,
    lead: {
      id: data.id,
      status: data.status,
      ownerName: data.owner_name,
      propertyAddress: data.property_address,
      hasPhone: Boolean(data.primary_phone || data.phone_1),
      createdAt: data.created_at,
      contacts: parseContacts(data),
    },
  };
}

/** Normalize the CRM's contact columns (structured `phones` JSONB when the
 *  enrichment pipeline ran, legacy phone_1..3 otherwise) into one shape. */
function parseContacts(d: Record<string, unknown>): LeadContacts | null {
  const phones: LeadPhone[] = [];
  const seen = new Set<string>();
  const push = (p: Partial<LeadPhone> & { number?: string | null }) => {
    const num = (p.number ?? "").trim();
    if (!num || seen.has(num)) return;
    seen.add(num);
    phones.push({
      number: num,
      status: p.status ?? null,
      badReason: p.badReason ?? null,
      contactName: p.contactName ?? null,
      source: p.source ?? null,
      confidence: p.confidence ?? null,
      dnc: p.dnc ?? false,
    });
  };
  if (Array.isArray(d.phones)) {
    for (const raw of d.phones as Array<Record<string, unknown>>) {
      push({
        number: raw.number as string,
        status: (raw.status as string) ?? null,
        badReason: (raw.bad_reason as string) ?? null,
        contactName: (raw.contact_name as string) ?? null,
        source: (raw.source as string) ?? null,
        confidence: typeof raw.confidence === "number" ? raw.confidence : null,
        dnc: raw.dnc === true,
      });
    }
  }
  for (const col of ["phone_1", "phone_2", "phone_3"] as const) {
    if (typeof d[col] === "string") push({ number: d[col] as string, source: d.contact_source as string | null });
  }
  const primary = (d.preferred_phone ?? d.primary_phone) as string | null;
  const contactInfo = (d.contact_info as string | null)?.trim() || null;
  if (!phones.length && !contactInfo) return null;
  // Good numbers first, primary at the very front; DNC then bad sink to the end.
  phones.sort((a, b) => {
    const rank = (p: LeadPhone) =>
      p.status === "bad" ? 3 : p.dnc ? 2 : p.number === primary ? 0 : 1;
    return rank(a) - rank(b);
  });
  // The team's preferred/primary column wins ONLY when that number is an
  // actual entry on file AND still dialable. A stale preferred_phone (one no
  // longer present in the phones array, or since gone bad/DNC) must never be
  // promoted to tap-to-dial — fall back to the best dialable entry instead.
  // (Compliance: never surface a number we haven't vetted or that's no-dial.)
  const primaryEntry = primary ? phones.find((p) => p.number === primary) : undefined;
  const primaryDialable = Boolean(primaryEntry) && primaryEntry!.status !== "bad" && !primaryEntry!.dnc;
  return {
    phones,
    primaryPhone:
      (primaryDialable ? primary : null) ??
      phones.find((p) => p.status !== "bad" && !p.dnc)?.number ??
      null,
    contactInfo,
    source: (d.contact_source as string) ?? null,
    matchConfidence: typeof d.contact_match_confidence === "number" ? d.contact_match_confidence : null,
    needsReview: Boolean(d.contact_needs_review),
  };
}

/** Newest leads in given statuses — fuel for the morning briefing. */
export async function listLeads(
  statuses: string[],
  limit = 8
): Promise<Array<{ hcadAccount: string | null; status: string | null; address: string | null; createdAt: string | null }>> {
  const db = await getClient();
  if (!db) return [];
  const { data, error } = await db
    .from("leads")
    .select("hcad_account,status,property_address,created_at")
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`CRM lead list failed: ${error.message}`);
  return (data ?? []).map((d) => ({
    hcadAccount: d.hcad_account,
    status: d.status,
    address: d.property_address,
    createdAt: d.created_at,
  }));
}

/** Decision evidence for the buy-box distiller: every lead's status + the
 *  numbers that shaped the call. */
export async function listLeadsForBuyBox(limit = 120): Promise<
  Array<{ status: string | null; address: string | null; appraisedValue: number | null; lotSqft: number | null; createdAt: string | null }>
> {
  const db = await getClient();
  if (!db) return [];
  const { data, error } = await db
    .from("leads")
    .select("status,property_address,hcad_appraisal_value,lot_sqft,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`CRM buy-box read failed: ${error.message}`);
  return (data ?? []).map((d) => ({
    status: d.status,
    address: d.property_address,
    appraisedValue: d.hcad_appraisal_value,
    lotSqft: d.lot_sqft,
    createdAt: d.created_at,
  }));
}

/** Recent dictated/typed notes — where the team's reasoning (and closed
 *  prices) actually live. */
export async function listRecentNotes(limit = 80): Promise<
  Array<{ body: string; createdAt: string | null; leadAddress: string | null; leadStatus: string | null }>
> {
  const db = await getClient();
  if (!db) return [];
  const { data, error } = await db
    .from("lead_notes")
    .select("body,created_at,leads(property_address,status)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`CRM notes read failed: ${error.message}`);
  return (data ?? []).map((d) => {
    const lead = (Array.isArray(d.leads) ? d.leads[0] : d.leads) as
      | { property_address: string | null; status: string | null }
      | null;
    return {
      body: d.body as string,
      createdAt: d.created_at as string | null,
      leadAddress: lead?.property_address ?? null,
      leadStatus: lead?.status ?? null,
    };
  });
}

/** Accountability: leads in the given statuses with no recorded activity in
 *  `days` — the ones quietly going cold. */
export async function listStaleLeads(
  statuses: string[],
  days: number,
  limit = 10
): Promise<
  Array<{ hcadAccount: string | null; status: string | null; address: string | null; lastTouch: string | null; daysQuiet: number }>
> {
  const db = await getClient();
  if (!db) return [];
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await db
    .from("leads")
    .select("hcad_account,status,property_address,latest_activity_at,updated_at,created_at")
    .in("status", statuses)
    .or(`latest_activity_at.is.null,latest_activity_at.lt.${cutoff}`)
    .order("latest_activity_at", { ascending: true, nullsFirst: true })
    .limit(limit * 2); // null-activity rows need the created_at fallback filter below
  if (error) throw new Error(`CRM stale-lead scan failed: ${error.message}`);
  const now = Date.now();
  return (data ?? [])
    .map((d) => {
      const last = (d.latest_activity_at ?? d.updated_at ?? d.created_at) as string | null;
      return {
        hcadAccount: d.hcad_account,
        status: d.status,
        address: d.property_address,
        lastTouch: last?.slice(0, 10) ?? null,
        daysQuiet: last ? Math.floor((now - new Date(last).getTime()) / 86400_000) : 9999,
      };
    })
    .filter((l) => l.daysQuiet >= days)
    .sort((a, b) => b.daysQuiet - a.daysQuiet)
    .slice(0, limit);
}

// ── Writes (RLS: team members can insert/update; deletes stay admin-only) ──

/** Valid lead statuses (from the CRM's lead_status enum). */
export const LEAD_STATUSES = [
  "new", "contacted", "no_answer", "hard_no", "revisit",
  "hot_lead", "need_numbers", "new_numbers_added",
] as const;

export function normalizeStatus(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((LEAD_STATUSES as readonly string[]).includes(s)) return s;
  if (s === "hot") return "hot_lead";
  if (s === "no_answer" || s === "noanswer") return "no_answer";
  if (s === "dead" || s === "no" || s === "pass") return "hard_no";
  if (s === "follow_up" || s === "followup" || s === "later") return "revisit";
  return null;
}

export async function findLeadByAccount(
  hcadAccount: string
): Promise<{ id: string; status: string | null } | null> {
  const db = await getClient();
  if (!db) return null;
  const { data, error } = await db
    .from("leads")
    .select("id,status")
    .eq("hcad_account", hcadAccount)
    .maybeSingle();
  if (error) throw new Error(`CRM lookup failed: ${error.message}`);
  return data ?? null;
}

/**
 * Add a parcel to the pipeline as a new lead (idempotent: returns the
 * existing lead if the HCAD account is already in the CRM).
 */
export async function ensureLead(
  parcel: Parcel,
  opts: { note?: string; tag?: string } = {}
): Promise<{ ok: true; created: boolean; leadId: string } | { ok: false; reason: string }> {
  const db = await getClient();
  if (!db) return { ok: false, reason: "CRM not connected" };

  const existing = await findLeadByAccount(parcel.hcadAccount);
  let leadId: string;
  let created = false;
  if (existing) {
    leadId = existing.id;
  } else {
    const { data, error } = await db
      .from("leads")
      .insert({
        hcad_account: parcel.hcadAccount,
        property_address: parcel.address,
        owner_name: parcel.ownerName,
        mailing_address: parcel.mailingAddress,
        latitude: parcel.lat,
        longitude: parcel.lon,
        lot_sqft: parcel.lotSqft,
        hcad_appraisal_value: parcel.appraisedValue,
        status: "new",
        parcel_geometry: { rings: parcel.rings },
        created_by: botUserId,
      })
      .select("id")
      .single();
    if (error) return { ok: false, reason: error.message };
    leadId = data.id;
    created = true;
  }
  if (opts.note) await addNote(leadId, opts.note);
  if (opts.tag) await tagLead(leadId, opts.tag);
  return { ok: true, created, leadId };
}

export async function addNote(leadId: string, body: string): Promise<void> {
  const db = await getClient();
  if (!db) throw new Error("CRM not connected");
  const { error } = await db
    .from("lead_notes")
    .insert({ lead_id: leadId, body, created_by: botUserId });
  if (error) throw new Error(`Note failed: ${error.message}`);
}

export async function tagLead(leadId: string, tag: string): Promise<void> {
  const db = await getClient();
  if (!db) throw new Error("CRM not connected");
  const { error } = await db
    .from("lead_tags")
    .insert({ lead_id: leadId, tag: tag.trim().toLowerCase(), created_by: botUserId });
  // Duplicate tags are harmless — ignore unique violations.
  if (error && !/duplicate|unique/i.test(error.message)) {
    throw new Error(`Tag failed: ${error.message}`);
  }
}

export async function updateStatus(
  leadId: string,
  status: string
): Promise<{ from: string | null; to: string }> {
  const db = await getClient();
  if (!db) throw new Error("CRM not connected");
  const { data: current, error: readErr } = await db
    .from("leads")
    .select("status")
    .eq("id", leadId)
    .single();
  if (readErr) throw new Error(`Status read failed: ${readErr.message}`);
  const from = current?.status ?? null;
  const { error } = await db.from("leads").update({ status }).eq("id", leadId);
  if (error) throw new Error(`Status update failed: ${error.message}`);
  // Note: the CRM has its own trigger that appends to lead_status_history on
  // status updates (verified in prod) — no manual history insert needed.
  return { from, to: status };
}

// ── Contact engine: skip-trace write-back + call-outcome logging ───────────
// The phones JSONB entry shape below is EXACTLY what the team's enrichment
// pipeline and CRM UI already write/read (verified against prod rows):
// {type,label,notes,number,source,status,bad_reason,confidence,accepted_at,
//  contact_name,marked_bad_at,marked_bad_by} — we add `dnc` (boolean), which
// rides along harmlessly for the CRM UI and drives Jarvo's no-dial rendering.

const digitsOf = (n: string) => n.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

type PhoneRow = Record<string, unknown> & { number?: string };

async function readPhonesRow(
  db: SupabaseClient,
  leadId: string
): Promise<{ phones: PhoneRow[]; contactInfo: string | null; preferred: string | null }> {
  const { data, error } = await db
    .from("leads")
    .select("phones,contact_info,preferred_phone,primary_phone")
    .eq("id", leadId)
    .single();
  if (error) throw new Error(`CRM phones read failed: ${error.message}`);
  return {
    phones: Array.isArray(data.phones) ? (data.phones as PhoneRow[]) : [],
    contactInfo: (data.contact_info as string | null) ?? null,
    preferred: (data.preferred_phone ?? data.primary_phone) as string | null,
  };
}

/** The number the card presents as primary: the preferred column when it's a
 *  present, dialable entry, else the first dialable entry — kept in lockstep
 *  with parseContacts so "log that call" targets the number the user saw. */
function primaryDialableNumber(phones: PhoneRow[], preferred: string | null): PhoneRow | undefined {
  const dialable = (p: PhoneRow) => p.status !== "bad" && p.dnc !== true;
  const pref = preferred ? phones.find((p) => p.number === preferred) : undefined;
  if (pref && dialable(pref)) return pref;
  return phones.find(dialable) ?? phones[0];
}

/** Merge a skip-trace result into the lead: new numbers append to the phones
 *  JSONB in the team's shape; emails land in contact_info (the CRM has no
 *  structured email column yet). Existing numbers are never duplicated or
 *  overwritten — the team's outcome history on them is the asset. */
export async function writeTracedContacts(
  leadId: string,
  traced: {
    phones: Array<{ number: string; type: string | null; confidence: number | null; dnc: boolean; contactName?: string | null }>;
    emails: string[];
    provider: string;
  }
): Promise<{ phonesAdded: number; phonesAlreadyKnown: number; emailsAdded: number }> {
  const db = await getClient();
  if (!db) throw new Error("CRM not connected");
  const { phones, contactInfo } = await readPhonesRow(db, leadId);
  const known = new Set(phones.map((p) => digitsOf(String(p.number ?? ""))).filter(Boolean));
  const now = new Date().toISOString();
  let added = 0;
  for (const t of traced.phones) {
    const d = digitsOf(t.number);
    if (!d || known.has(d)) continue;
    known.add(d);
    added++;
    phones.push({
      type: t.type,
      label: null,
      notes: null,
      number: t.number,
      source: `skiptrace:${traced.provider}`,
      status: null,
      bad_reason: null,
      confidence: t.confidence,
      accepted_at: now,
      contact_name: t.contactName ?? null,
      marked_bad_at: null,
      marked_bad_by: null,
      dnc: t.dnc,
    });
  }
  // Emails: contact_info free text until the CRM grows an email column.
  const freshEmails = traced.emails.filter((e) => e && !(contactInfo ?? "").includes(e));
  let newInfo = contactInfo;
  if (freshEmails.length) {
    const line = `Emails (skip trace ${traced.provider} ${now.slice(0, 10)}): ${freshEmails.join(", ")}`;
    newInfo = contactInfo ? `${contactInfo}\n${line}` : line;
  }
  if (added || freshEmails.length) {
    const { error } = await db
      .from("leads")
      .update({ phones, ...(newInfo !== contactInfo ? { contact_info: newInfo } : {}) })
      .eq("id", leadId);
    if (error) throw new Error(`CRM trace write-back failed: ${error.message}`);
  }
  return { phonesAdded: added, phonesAlreadyKnown: traced.phones.length - added, emailsAdded: freshEmails.length };
}

export type CallOutcome = "no_answer" | "wrong_number" | "bad_number" | "talked";

/** Update one number's status in the phones JSONB from a spoken call outcome
 *  ("log that call — no answer"). Every call makes the dataset smarter. */
export async function logCallOutcome(
  leadId: string,
  outcome: CallOutcome,
  matchDigits: string | null
): Promise<{ ok: true; number: string; nowMarked: string } | { ok: false; reason: string }> {
  const db = await getClient();
  if (!db) return { ok: false, reason: "CRM not connected" };
  const { phones, preferred } = await readPhonesRow(db, leadId);
  if (!phones.length) return { ok: false, reason: "no phone numbers on file for this lead" };
  // Which number? Explicit spoken digits win. Otherwise default to the SAME
  // primary the card presented, so the log lands on the number the user
  // actually dialed — not just whatever sits first in storage order.
  let entry: PhoneRow | undefined;
  if (matchDigits) {
    const matches = phones.filter((p) => digitsOf(String(p.number ?? "")).endsWith(matchDigits));
    if (!matches.length) return { ok: false, reason: `no number ending in ${matchDigits} on file` };
    // Ambiguous suffix (short spoken tail matching two lines) → don't guess
    // for a destructive outcome; ask for more digits. Non-destructive logs
    // fall to the primary among the matches.
    if (matches.length > 1) {
      if (outcome === "wrong_number" || outcome === "bad_number") {
        return { ok: false, reason: `more than one number ends in ${matchDigits} — say a few more digits so I mark the right one bad` };
      }
      entry = primaryDialableNumber(matches, preferred) ?? matches[0];
    } else {
      entry = matches[0];
    }
  } else {
    entry = primaryDialableNumber(phones, preferred);
  }
  if (!entry) return { ok: false, reason: "couldn't pick a number to log against" };
  const now = new Date().toISOString();
  entry.last_outcome = outcome;
  entry.last_outcome_at = now;
  entry.attempts = (typeof entry.attempts === "number" ? entry.attempts : 0) + 1;
  let nowMarked = "logged";
  if (outcome === "wrong_number" || outcome === "bad_number") {
    entry.status = "bad";
    entry.bad_reason = outcome === "wrong_number" ? "wrong_number" : "disconnected";
    entry.marked_bad_at = now;
    entry.marked_bad_by = botUserId;
    nowMarked = "marked bad — it won't be dialed again";
  } else if (outcome === "talked") {
    nowMarked = "logged as a live conversation";
  } else {
    nowMarked = "logged as no answer";
  }
  const { error } = await db.from("leads").update({ phones }).eq("id", leadId);
  if (error) return { ok: false, reason: `CRM outcome write failed: ${error.message}` };
  return { ok: true, number: String(entry.number ?? ""), nowMarked };
}
