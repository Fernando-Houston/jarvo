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

export type LeadSummary = {
  id: string;
  status: string | null;
  ownerName: string | null;
  propertyAddress: string | null;
  hasPhone: boolean;
  createdAt: string | null;
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
    .select("id,status,owner_name,property_address,primary_phone,created_at")
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
      hasPhone: Boolean(data.primary_phone),
      createdAt: data.created_at,
    },
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
