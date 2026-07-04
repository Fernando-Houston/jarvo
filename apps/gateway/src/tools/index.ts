// Tool registry: schemas for Claude + an executor shared by both brains.
// Tool results returned to the model are compact (no geometry); full parcel
// records (with rings) are stashed on the session so the gateway can emit
// `visual` events without bloating the model's context.

import {
  lookupByAddress,
  lookupByOwner,
  lookupByAccount,
  lookupComps,
  lookupRecentTransfers,
  type Parcel,
} from "./hcad";
import { floodCheckParcel, type FloodInfo } from "./fema";
import { chapter42Feasibility, type Ch42Result, type StreetType } from "./chapter42";
import { cityOverlaysAt } from "./cityOverlays";
import { groundAround } from "./ground";
import { getLatestDigest, runNightlyDigest } from "./digest";
import type { CompsVisual, GroundVisual } from "@hvi/shared";
import {
  checkLead,
  crmAvailable,
  ensureLead,
  addNote,
  updateStatus,
  findLeadByAccount,
  listLeads,
  normalizeStatus,
  LEAD_STATUSES,
} from "./crm";
import type { ParcelVisual } from "@hvi/shared";

export type SessionMemory = {
  /** HCAD account of the most recently discussed parcel ("this one"). */
  lastAccount: string | null;
  /** How many parcels the last address lookup matched (>3 = stacked condo —
   *  "save this" must disambiguate before writing to the CRM). */
  lastMatches: number;
  /** Parcels seen across the whole session, keyed by HCAD account. */
  knownParcels: Map<string, Parcel>;
  /** FEMA flood results already fetched this session, keyed by HCAD account. */
  floodByAccount: Map<string, FloodInfo>;
  /** CRM pipeline status per HCAD account, learned from checks and writes. */
  leadStatusByAccount: Map<string, string>;
  /** Chapter 42 plans already computed this session, keyed by HCAD account. */
  ch42ByAccount: Map<string, Ch42Result>;
  /** Median land $/sqft from comps runs, for session wrap-up notes. */
  compsMedianByAccount: Map<string, number>;
};

export type ToolContext = {
  /** Parcels found during this turn, keyed by HCAD account. */
  parcels: Map<string, Parcel>;
  memory: SessionMemory;
  emitVisual: (v: ParcelVisual | CompsVisual | GroundVisual) => void;
};

/** Resolve a parcel from this turn, session history, or live HCAD. */
async function resolveParcel(ctx: ToolContext, account: string): Promise<Parcel | null> {
  return (
    ctx.parcels.get(account) ??
    ctx.memory.knownParcels.get(account) ??
    (await lookupByAccount(account))
  );
}

export const toolSchemas = [
  {
    name: "property_lookup",
    description:
      "Look up Harris County property records by street address. Returns owner, appraised value, lot size, and ownership date from live HCAD data. A single street address may return MANY records when it is a condo/multi-unit building (stacked parcels). Call this whenever the user asks about a specific property.",
    input_schema: {
      type: "object" as const,
      properties: {
        address: {
          type: "string",
          description: 'Street address, e.g. "505 Westcott St" or "1220 Yale St 77008"',
        },
      },
      required: ["address"],
    },
  },
  {
    name: "owner_lookup",
    description:
      "Find Harris County parcels owned by a person or company (partial name match). Use when the user asks what someone owns.",
    input_schema: {
      type: "object" as const,
      properties: {
        owner_name: { type: "string", description: 'Owner name fragment, e.g. "Goo Cecilia" or "Camden Property"' },
      },
      required: ["owner_name"],
    },
  },
  {
    name: "flood_check",
    description:
      "Check FEMA flood status for a parcel (by 13-digit HCAD account): flood zone (X, AE, VE, A, AO...), whether it sits in the 100-year floodplain (SFHA), and floodway status. Call whenever the user asks about flooding, floodplain, flood zone, or flood risk for a property.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account number" },
      },
      required: ["hcad_account"],
    },
  },
  {
    name: "comps",
    description:
      "Find comparable parcels near a subject property (by 13-digit HCAD account): same land-use code, similar lot size, within a radius. Returns the land $/sqft distribution (median, quartiles) and scatters the comps on the map. Call when the user asks about comps, comparables, nearby values, or what land trades for in the area.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account of the subject parcel" },
        radius_m: { type: "number", description: "Search radius in meters (default 800, about half a mile)" },
      },
      required: ["hcad_account"],
    },
  },
  {
    name: "chapter42_feasibility",
    description:
      "Estimate how many single-family/townhome units fit on a parcel under Houston Chapter 42 rules (by 13-digit HCAD account, or a raw lot_sqft): unit count, lot-size ladder, density vs the 27/acre cap, parking, compensating open space, and a site plan the map assembles. Call when the user asks how many units/townhomes fit, about subdividing, developing, or Chapter 42 feasibility.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account of the site" },
        lot_sqft: { type: "number", description: "Site area in sqft, when no HCAD account applies" },
        street_type: {
          type: "string",
          description: "Fronting street: major_thoroughfare, collector, local (default), or shared_driveway",
        },
        target_lot_sqft: { type: "number", description: "Force a specific lot size instead of optimizing (min 1400)" },
      },
    },
  },
  {
    name: "recent_transfers",
    description:
      "Deal radar: parcels near a subject property (by 13-digit HCAD account) whose OWNER CHANGED recently, newest first — each one pops onto the map as a node. Call when the user asks what has sold, traded, or changed hands nearby, or about new owners in the area.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account of the subject parcel" },
        radius_m: { type: "number", description: "Search radius in meters (default 1600, about a mile)" },
        days: { type: "number", description: "Lookback window in days (default 180)" },
      },
      required: ["hcad_account"],
    },
  },
  {
    name: "pipeline_briefing",
    description:
      "Morning briefing: the team's newest hot and new leads from the CRM pipeline, each popped onto the map as a node. Call when the user asks for a briefing, a pipeline review, their hot leads, or says good morning.",
    input_schema: {
      type: "object" as const,
      properties: {
        statuses: {
          type: "array",
          items: { type: "string" },
          description: `Statuses to include (default ["hot_lead","new"]). Valid: ${LEAD_STATUSES.join(", ")}`,
        },
      },
    },
  },
  {
    name: "nightly_digest",
    description:
      "The overnight digest: fresh deed recordings HCAD picked up near the team's pipeline leads plus pipeline changes, swept nightly by cron. Call when the user asks what's new, what happened overnight, for the digest, or anything-new-since-yesterday. Returns the stored nightly run (or sweeps live if none exists yet). Deed dates are HCAD recordings that trail the courthouse by weeks to months — keep that caveat when speaking.",
    input_schema: {
      type: "object" as const,
      properties: {
        refresh: {
          type: "boolean",
          description: "Force a fresh sweep now instead of reading the stored nightly run",
        },
      },
    },
  },
  {
    name: "city_overlays",
    description:
      "Check City of Houston planning overlays at a parcel (by 13-digit HCAD account): historic districts (city = approvals/demo restrictions; national register), conservation districts, special minimum lot size / building line areas (these BLOCK small-lot townhome subdivision), market-based parking (no parking minimums), and federal opportunity zones (tax incentive). ALWAYS call this before recommending a townhome/subdivision play, and whenever the user asks about restrictions, historic status, or buildability.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account number" },
      },
      required: ["hcad_account"],
    },
  },
  {
    name: "where_is_this",
    description:
      "Geographic orientation for a parcel (by 13-digit HCAD account): distance/direction from downtown Houston, nearest named bayou and freeway — and it materializes the ground (bayous + freeways as particle streams) around the parcel on the map. Call when the user asks where something is, what's around/near it, or for orientation.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account number" },
      },
      required: ["hcad_account"],
    },
  },
  {
    name: "crm_lead_check",
    description:
      "Check whether a property (by 13-digit HCAD account) is already a lead in the Houston Land Group CRM pipeline, and its status. Call after property_lookup when discussing a specific parcel.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account number" },
      },
      required: ["hcad_account"],
    },
  },
  {
    name: "crm_add_lead",
    description:
      "Add a property to the team's CRM pipeline as a new lead (idempotent — safe if it already exists). ONLY call when the user explicitly asks to save/add a property as a lead. Optionally attach a note and/or a tag at the same time.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account of the parcel to save" },
        note: { type: "string", description: "Optional note to attach (e.g. what the user said about it)" },
        tag: { type: "string", description: 'Optional short tag, e.g. "hot" or "vacant"' },
      },
      required: ["hcad_account"],
    },
  },
  {
    name: "crm_add_note",
    description:
      "Attach a note to an existing CRM lead (by HCAD account). ONLY when the user dictates a note.",
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account of the lead" },
        note: { type: "string", description: "The note text, cleaned up from speech" },
      },
      required: ["hcad_account", "note"],
    },
  },
  {
    name: "crm_update_status",
    description: `Change a CRM lead's pipeline status. Valid statuses: ${LEAD_STATUSES.join(", ")}. "Tag it hot" means status hot_lead. ONLY on explicit user request.`,
    input_schema: {
      type: "object" as const,
      properties: {
        hcad_account: { type: "string", description: "13-digit HCAD account of the lead" },
        status: { type: "string", description: "One of the valid statuses" },
      },
      required: ["hcad_account", "status"],
    },
  },
];

/** Compact, model-facing view of a parcel (no geometry). */
function compact(p: Parcel) {
  return {
    hcad_account: p.hcadAccount,
    address: p.address,
    owner: p.ownerName,
    appraised_value: p.appraisedValue,
    land_value: p.landValue,
    building_value: p.buildingValue,
    lot_sqft: p.lotSqft,
    value_per_lot_sqft:
      p.appraisedValue != null && p.lotSqft
        ? Math.round((p.appraisedValue / p.lotSqft) * 100) / 100
        : null,
    owned_since: p.ownedSince,
    legal: p.legalDescription,
    mailing_address: p.mailingAddress,
    absentee_owner: p.absenteeOwner,
  };
}

/** Build the morph visual for a set of parcels found by one lookup. */
export function parcelsToVisual(parcels: Parcel[], note?: string): ParcelVisual | null {
  if (!parcels.length) return null;
  const primary = parcels[0];
  // Combine rings across parcels (a condo building's stacked units usually
  // share a footprint; distinct lots render as multiple outlines).
  const seen = new Set<string>();
  const rings: number[][][] = [];
  for (const p of parcels.slice(0, 40)) {
    for (const ring of p.rings) {
      const key = ring.length + ":" + ring[0]?.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      rings.push(ring);
    }
  }
  const values = parcels.map((p) => p.appraisedValue).filter((v): v is number => v != null);
  return {
    kind: "parcel",
    hcadAccount: primary.hcadAccount,
    address: primary.address,
    ownerName: parcels.length === 1 ? primary.ownerName : null,
    appraisedValue:
      parcels.length === 1 ? primary.appraisedValue : values.length ? values.reduce((a, b) => a + b, 0) : null,
    lotSqft: primary.lotSqft,
    centroid: { lat: primary.lat, lon: primary.lon },
    rings,
    note,
  };
}

/** Emit a parcel visual carrying everything the session already knows about
 *  it (flood zone, pipeline status) so re-emits never lose earlier state. */
export function emitDecorated(ctx: ToolContext, parcels: Parcel[], note?: string) {
  const visual = parcelsToVisual(parcels, note);
  if (!visual) return;
  const flood = ctx.memory.floodByAccount.get(visual.hcadAccount);
  if (flood) {
    visual.floodZone = flood.zone;
    visual.sfha = flood.sfha || flood.isFloodway;
    visual.floodLabel = flood.label;
  }
  const leadStatus = ctx.memory.leadStatusByAccount.get(visual.hcadAccount);
  if (leadStatus) visual.leadStatus = leadStatus;
  const ch42 = ctx.memory.ch42ByAccount.get(visual.hcadAccount);
  if (ch42) {
    visual.ch42 = {
      units: ch42.units,
      avgLotSqft: ch42.avgLotSqft,
      densityPerAcre: ch42.densityPerAcre,
      parkingSpaces: ch42.parkingSpaces,
      openSpaceSqftPerLot: ch42.openSpaceSqftPerLot,
      siteWidthFt: ch42.siteWidthFt,
      siteDepthFt: ch42.siteDepthFt,
      rects: ch42.rects,
    };
  }
  ctx.emitVisual(visual);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  switch (name) {
    case "property_lookup": {
      const parcels = await lookupByAddress(String(input.address ?? ""));
      for (const p of parcels) {
        ctx.parcels.set(p.hcadAccount, p);
        ctx.memory.knownParcels.set(p.hcadAccount, p);
      }
      if (parcels[0]) {
        ctx.memory.lastAccount = parcels[0].hcadAccount;
        ctx.memory.lastMatches = parcels.length;
      }
      const note = parcels.length > 3 ? `${parcels.length} stacked units at this address` : undefined;
      emitDecorated(ctx, parcels, note);
      if (!parcels.length) {
        return JSON.stringify({ matches: 0, hint: "No HCAD parcel matched. The address may be outside Harris County or misheard — ask the user to repeat the street name." });
      }
      return JSON.stringify({ matches: parcels.length, parcels: parcels.slice(0, 10).map(compact) });
    }
    case "owner_lookup": {
      const parcels = await lookupByOwner(String(input.owner_name ?? ""));
      for (const p of parcels) {
        ctx.parcels.set(p.hcadAccount, p);
        ctx.memory.knownParcels.set(p.hcadAccount, p);
      }
      if (parcels[0]) {
        ctx.memory.lastAccount = parcels[0].hcadAccount;
        ctx.memory.lastMatches = 1; // distinct lots, not a condo stack
      }
      emitDecorated(ctx, parcels, parcels.length > 1 ? `${parcels.length} parcels` : undefined);
      return JSON.stringify({ matches: parcels.length, parcels: parcels.slice(0, 10).map(compact) });
    }
    case "flood_check": {
      const account = String(input.hcad_account ?? "");
      const parcel = await resolveParcel(ctx, account);
      if (!parcel) return JSON.stringify({ error: `No parcel found for HCAD ${account}` });
      let flood = ctx.memory.floodByAccount.get(parcel.hcadAccount);
      if (!flood) {
        flood = await floodCheckParcel(parcel);
        ctx.memory.floodByAccount.set(parcel.hcadAccount, flood);
      }
      ctx.memory.lastAccount = parcel.hcadAccount;
      ctx.memory.lastMatches = 1; // focus narrowed to one specific parcel
      // Repaint the morph: same parcel, now carrying flood state (blue tint on SFHA).
      emitDecorated(ctx, [parcel]);
      return JSON.stringify({
        hcad_account: parcel.hcadAccount,
        address: parcel.address,
        flood_zone: flood.zone,
        zone_subtype: flood.subType,
        in_100yr_floodplain_sfha: flood.sfha,
        in_floodway: flood.isFloodway,
        parcel_touches_sfha: flood.touchesSfha,
        summary: flood.label,
      });
    }
    case "comps": {
      const account = String(input.hcad_account ?? "");
      const subject = await resolveParcel(ctx, account);
      if (!subject) return JSON.stringify({ error: `No parcel found for HCAD ${account}` });
      const radius = typeof input.radius_m === "number" && input.radius_m > 0
        ? Math.min(input.radius_m, 3200)
        : 800;
      const found = await lookupComps(subject, radius);
      const landPerSqft = (p: Parcel) =>
        p.lotSqft
          ? p.landValue != null
            ? p.landValue / p.lotSqft
            : p.appraisedValue != null
              ? p.appraisedValue / p.lotSqft
              : null
          : null;
      const comps = found
        .map((p) => ({ p, v: landPerSqft(p) }))
        .filter((c) => c.v != null && c.v! > 0);
      const values = comps.map((c) => c.v!).sort((a, b) => a - b);
      const pct = (q: number) =>
        values.length ? Math.round(values[Math.min(values.length - 1, Math.floor(q * values.length))] * 100) / 100 : null;
      const median = pct(0.5);
      if (median != null) ctx.memory.compsMedianByAccount.set(subject.hcadAccount, median);
      ctx.memory.lastAccount = subject.hcadAccount;
      ctx.memory.lastMatches = 1;
      ctx.emitVisual({
        kind: "comps",
        hcadAccount: subject.hcadAccount,
        comps: comps.slice(0, 40).map((c) => ({
          lat: c.p.lat,
          lon: c.p.lon,
          valuePerSqft: Math.round(c.v! * 100) / 100,
        })),
        medianPerSqft: median,
      });
      return JSON.stringify({
        subject_hcad: subject.hcadAccount,
        subject_land_per_sqft: landPerSqft(subject) != null ? Math.round(landPerSqft(subject)! * 100) / 100 : null,
        radius_m: radius,
        comp_count: values.length,
        land_per_sqft: { median, p25: pct(0.25), p75: pct(0.75), min: pct(0), max: pct(1) },
        note: "land $/sqft = HCAD land_value / lot sqft (appraisal basis, not sale prices)",
      });
    }
    case "chapter42_feasibility": {
      const account = input.hcad_account ? String(input.hcad_account) : null;
      const parcel = account ? await resolveParcel(ctx, account) : null;
      if (account && !parcel) return JSON.stringify({ error: `No parcel found for HCAD ${account}` });
      const lotSqft = parcel?.lotSqft ?? (typeof input.lot_sqft === "number" ? input.lot_sqft : null);
      if (!lotSqft || lotSqft <= 0) {
        return JSON.stringify({ error: "Need a parcel with lot size, or an explicit lot_sqft." });
      }
      // Site proportions from the parcel footprint's bbox (meters → feet).
      let siteWidthFt: number | undefined;
      let siteDepthFt: number | undefined;
      if (parcel?.rings?.length) {
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const ring of parcel.rings) {
          for (const [lon, lat] of ring) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
        const kx = Math.cos((parcel.lat * Math.PI) / 180);
        siteWidthFt = (maxLon - minLon) * 111320 * kx * 3.28084;
        siteDepthFt = (maxLat - minLat) * 110574 * 3.28084;
      }
      const street = typeof input.street_type === "string" && input.street_type in { major_thoroughfare: 1, collector: 1, local: 1, shared_driveway: 1 }
        ? (input.street_type as StreetType)
        : undefined;
      const plan = chapter42Feasibility({
        lotSqft,
        siteWidthFt,
        siteDepthFt,
        streetType: street,
        targetLotSqft: typeof input.target_lot_sqft === "number" ? input.target_lot_sqft : undefined,
      });
      if (parcel) {
        ctx.memory.ch42ByAccount.set(parcel.hcadAccount, plan);
        ctx.memory.lastAccount = parcel.hcadAccount;
        ctx.memory.lastMatches = 1;
        emitDecorated(ctx, [parcel]);
      }
      const { rects, ...summary } = plan;
      return JSON.stringify({ ...summary, note: "planning estimate from HCAD geometry — not a survey or permit determination" });
    }
    case "recent_transfers": {
      const account = String(input.hcad_account ?? "");
      const subject = await resolveParcel(ctx, account);
      if (!subject) return JSON.stringify({ error: `No parcel found for HCAD ${account}` });
      const radius = typeof input.radius_m === "number" && input.radius_m > 0 ? Math.min(input.radius_m, 5000) : 1600;
      const days = typeof input.days === "number" && input.days > 0 ? Math.min(input.days, 730) : 180;
      const transfers = await lookupRecentTransfers(subject, radius);
      const cutoff = Date.now() - days * 86400_000;
      const inWindow = transfers.filter(
        (t) => t.ownedSince && new Date(t.ownedSince + "T00:00:00Z").getTime() >= cutoff
      ).length;
      // Radar sweep: each fresh transfer pops onto the constellation, paced
      // so the map visibly builds while the answer is spoken; then focus
      // returns to the subject.
      const shown = transfers.slice(0, 5);
      for (const t of shown) {
        ctx.parcels.set(t.hcadAccount, t);
        ctx.memory.knownParcels.set(t.hcadAccount, t);
        emitDecorated(ctx, [t]);
        await new Promise((r) => setTimeout(r, 600));
      }
      if (shown.length) emitDecorated(ctx, [subject]);
      ctx.memory.lastAccount = subject.hcadAccount;
      ctx.memory.lastMatches = 1;
      return JSON.stringify({
        subject_hcad: subject.hcadAccount,
        radius_m: radius,
        lookback_days: days,
        transfer_count: transfers.length,
        transfers_within_window: inWindow,
        freshest_recorded: transfers[0]?.ownedSince ?? null,
        data_lag_note: "HCAD's snapshot trails live recordings by weeks-to-months",
        transfers: transfers.map((t) => ({
          address: t.address,
          new_owner: t.ownerName,
          recorded: t.ownedSince,
          appraised_value: t.appraisedValue,
          hcad_account: t.hcadAccount,
        })),
        note: "recording dates from HCAD new_owner_date — deeds, not listings",
      });
    }
    case "pipeline_briefing": {
      const statuses =
        Array.isArray(input.statuses) && input.statuses.length
          ? input.statuses.map(String).filter((s) => (LEAD_STATUSES as readonly string[]).includes(s))
          : ["hot_lead", "new"];
      let leads;
      try {
        leads = await listLeads(statuses, 8);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      if (!leads.length) return JSON.stringify({ lead_count: 0, statuses });
      // Hydrate + pop the freshest few onto the map, newest last so the most
      // recent lead ends up in focus.
      const toShow = leads.filter((l) => l.hcadAccount).slice(0, 5).reverse();
      let focused: Parcel | null = null;
      for (const lead of toShow) {
        if (lead.status) ctx.memory.leadStatusByAccount.set(lead.hcadAccount!, lead.status);
        const parcel = await resolveParcel(ctx, lead.hcadAccount!);
        if (!parcel) continue;
        ctx.memory.knownParcels.set(parcel.hcadAccount, parcel);
        emitDecorated(ctx, [parcel]);
        focused = parcel;
        await new Promise((r) => setTimeout(r, 600));
      }
      if (focused) {
        ctx.memory.lastAccount = focused.hcadAccount;
        ctx.memory.lastMatches = 1;
      }
      return JSON.stringify({
        lead_count: leads.length,
        statuses,
        leads: leads.map((l) => ({
          address: l.address,
          status: l.status,
          hcad_account: l.hcadAccount,
          created: l.createdAt?.slice(0, 10) ?? null,
        })),
      });
    }
    case "nightly_digest": {
      try {
        let digest = input.refresh ? null : await getLatestDigest();
        let freshlyRun = false;
        if (!digest) {
          digest = await runNightlyDigest();
          freshlyRun = true;
        }
        return JSON.stringify({
          generated_at: digest.generatedAt,
          swept_just_now: freshlyRun,
          bullets: digest.bullets,
          stats: digest.stats,
          note: "deed dates are HCAD recordings, weeks-to-months behind the courthouse",
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    case "city_overlays": {
      const account = String(input.hcad_account ?? "");
      const parcel = await resolveParcel(ctx, account);
      if (!parcel) return JSON.stringify({ error: `No parcel found for HCAD ${account}` });
      const hits = await cityOverlaysAt(parcel.lat, parcel.lon);
      const blocking = hits.filter((h) =>
        ["historic_district_city", "special_min_lot_size", "special_min_building_line", "conservation_district"].includes(h.key)
      );
      return JSON.stringify({
        hcad_account: parcel.hcadAccount,
        address: parcel.address,
        overlay_count: hits.length,
        overlays: hits,
        development_risk: blocking.length
          ? "RESTRICTED: " + blocking.map((h) => h.label + (h.name ? ` (${h.name})` : "")).join("; ")
          : "no city development restrictions found at this point",
        note: "point-in-polygon at the parcel centroid; deed restrictions recorded with the county are NOT covered",
      });
    }
    case "where_is_this": {
      const account = String(input.hcad_account ?? "");
      const parcel = await resolveParcel(ctx, account);
      if (!parcel) return JSON.stringify({ error: `No parcel found for HCAD ${account}` });
      const g = await groundAround(parcel.lat, parcel.lon);
      ctx.memory.lastAccount = parcel.hcadAccount;
      if (g.features.length) {
        ctx.emitVisual({ kind: "ground", hcadAccount: parcel.hcadAccount, features: g.features });
      }
      return JSON.stringify({
        hcad_account: parcel.hcadAccount,
        address: parcel.address,
        zip: parcel.zip,
        downtown: `${g.downtownMiles} miles ${g.downtownDirection} of downtown Houston`,
        nearest_bayou: g.nearestWater ? `${g.nearestWater.name} ~${g.nearestWater.miles} mi` : null,
        nearest_freeway: g.nearestRoad ? `${g.nearestRoad.name} ~${g.nearestRoad.miles} mi` : null,
        ground_features_on_map: g.features.length,
      });
    }
    case "crm_lead_check": {
      const account = String(input.hcad_account ?? "");
      const result = await checkLead(account);
      if (!("found" in result)) {
        return JSON.stringify({ available: false, note: "CRM not connected in this environment; do not mention the CRM." });
      }
      if (result.found) {
        // Badge the on-screen parcel: "IN PIPELINE · <status>".
        ctx.memory.leadStatusByAccount.set(account, result.lead.status ?? "new");
        const parcel = await resolveParcel(ctx, account);
        if (parcel) emitDecorated(ctx, [parcel]);
      } else {
        ctx.memory.leadStatusByAccount.delete(account);
      }
      return JSON.stringify(result);
    }
    case "crm_add_lead": {
      const account = String(input.hcad_account ?? "");
      const parcel = await resolveParcel(ctx, account);
      if (!parcel) return JSON.stringify({ ok: false, reason: `No parcel found for HCAD ${account}` });
      const result = await ensureLead(parcel, {
        note: input.note ? String(input.note) : undefined,
        tag: input.tag ? String(input.tag) : undefined,
      });
      if (result.ok) {
        if (!ctx.memory.leadStatusByAccount.has(parcel.hcadAccount)) {
          ctx.memory.leadStatusByAccount.set(parcel.hcadAccount, "new");
        }
        emitDecorated(ctx, [parcel]);
      }
      return JSON.stringify(result.ok ? { ...result, address: parcel.address } : result);
    }
    case "crm_add_note": {
      const lead = await findLeadByAccount(String(input.hcad_account ?? ""));
      if (!lead) {
        return JSON.stringify({ ok: false, reason: "Not a lead yet — use crm_add_lead first (or ask the user)." });
      }
      await addNote(lead.id, String(input.note ?? ""));
      return JSON.stringify({ ok: true });
    }
    case "crm_update_status": {
      const status = normalizeStatus(String(input.status ?? ""));
      if (!status) {
        return JSON.stringify({ ok: false, reason: `Invalid status. Valid: ${LEAD_STATUSES.join(", ")}` });
      }
      const lead = await findLeadByAccount(String(input.hcad_account ?? ""));
      if (!lead) {
        return JSON.stringify({ ok: false, reason: "Not a lead yet — use crm_add_lead first (or ask the user)." });
      }
      const change = await updateStatus(lead.id, status);
      const account = String(input.hcad_account ?? "");
      ctx.memory.leadStatusByAccount.set(account, change.to);
      const parcel = await resolveParcel(ctx, account);
      if (parcel) emitDecorated(ctx, [parcel]);
      return JSON.stringify({ ok: true, from: change.from, to: change.to });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

export function describeCapabilities() {
  return { crm: crmAvailable() };
}
