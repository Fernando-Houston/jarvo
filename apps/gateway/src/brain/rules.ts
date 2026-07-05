// Keyless fallback brain: no LLM. Parses the utterance for an address or
// owner name, runs the same tools as Claude, and speaks a templated answer.
// Exists so the full pipeline (voice -> data -> voice + morph) runs with
// zero API keys. Swapped out automatically when ANTHROPIC_API_KEY is set.

import { executeTool, emitDecorated, type ToolContext } from "../tools/index";
import { lookupByOwner } from "../tools/hcad";
import type { Brain, BrainEvents } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function money(n: number | null): string {
  if (n == null) return "an unknown amount";
  if (n >= 1_000_000) return `about ${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} million dollars`;
  if (n >= 1_000) return `about ${Math.round(n / 1_000)} thousand dollars`;
  return `about ${Math.round(n)} dollars`;
}

function sqft(n: number | null): string {
  if (n == null) return "";
  if (n >= 43560) return `${(n / 43560).toFixed(1)} acres`;
  return `${Math.round(n).toLocaleString()} square feet`;
}

type CompactParcel = {
  hcad_account: string;
  address: string | null;
  owner: string | null;
  appraised_value: number | null;
  lot_sqft: number | null;
  value_per_lot_sqft: number | null;
  owned_since: string | null;
  mailing_address: string | null;
  absentee_owner: boolean | null;
};

export function createRulesBrain(): Brain {
  return {
    name: "rules",
    async run(userText: string, events: BrainEvents, ctx: ToolContext, signal: AbortSignal) {
      const say = (s: string) => {
        if (signal.aborted) return;
        events.onTextDelta(s + " ");
        events.onSentence(s);
      };

      // ── Voice commands against the CRM ("this one" = last parcel discussed) ──
      const mem = ctx.memory;
      const saveCmd = /\b(add|save|put)\b.*\b(lead|pipeline|crm)\b/i.test(userText)
        || /^(add|save) (it|this|that)\b/i.test(userText.trim());
      const noteCmd = userText.match(/(?:^|\b)(?:add a )?note[:,]?\s+(.{3,})/i);
      const hotCmd = /\b(tag|mark|flag)\b.*\bhot\b/i.test(userText);

      if (saveCmd || noteCmd || hotCmd) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then tell me to save it.");
          return;
        }
        // Stacked condo: "save this" is ambiguous — 34 units share the address.
        const wholeBuilding = /\bbuilding\b/i.test(userText);
        if ((saveCmd || hotCmd) && mem.lastMatches > 3 && !wholeBuilding) {
          say(
            `That address is a ${mem.lastMatches}-unit building. Ask about a specific unit and save that, or say "save the building" to track the whole thing.`
          );
          return;
        }
        try {
          if (saveCmd || hotCmd) {
            events.onTool("crm_add_lead", "start");
            const buildingNote =
              wholeBuilding && mem.lastMatches > 3
                ? `Saved as whole building — address matched ${mem.lastMatches} stacked units`
                : undefined;
            const res = JSON.parse(
              await executeTool(
                "crm_add_lead",
                { hcad_account: mem.lastAccount, ...(buildingNote ? { note: buildingNote } : {}) },
                ctx
              )
            );
            events.onTool("crm_add_lead", "end");
            if (!res.ok) {
              say(res.reason === "CRM not connected" ? "The CRM isn't connected right now." : "That didn't save — " + res.reason);
              return;
            }
            if (hotCmd) {
              await executeTool("crm_update_status", { hcad_account: mem.lastAccount, status: "hot_lead" }, ctx);
              say(res.created ? `Saved ${res.address ?? "it"} to the pipeline and marked it hot.` : `It was already in the pipeline — marked it hot.`);
            } else {
              say(res.created ? `Done — ${res.address ?? "it"} is in the pipeline as a new lead.` : `That one's already in the pipeline.`);
            }
          }
          if (noteCmd) {
            events.onTool("crm_add_note", "start");
            const res = JSON.parse(await executeTool("crm_add_note", { hcad_account: mem.lastAccount, note: noteCmd[1].trim() }, ctx));
            events.onTool("crm_add_note", "end");
            say(res.ok ? "Note added." : "Couldn't add the note — save it as a lead first.");
          }
        } catch (err) {
          say("The CRM didn't take that — " + (err instanceof Error ? err.message : "unknown error"));
        }
        return;
      }

      // ── Flood question ("is it in the floodplain?", "flood zone for 505 Westcott?") ──
      if (/flood/i.test(userText)) {
        // An address may ride along — look it up first so it becomes the focus.
        const addr = userText.match(/\d{1,6}\s+[A-Za-z0-9 .']{2,}/);
        if (addr) {
          events.onTool("property_lookup", "start");
          try {
            await executeTool("property_lookup", { address: addr[0] }, ctx);
          } catch {
            /* fall through — lastAccount may still hold a previous parcel */
          }
          events.onTool("property_lookup", "end");
        }
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can check its flood zone.");
          return;
        }
        events.onTool("flood_check", "start");
        try {
          const f = JSON.parse(await executeTool("flood_check", { hcad_account: mem.lastAccount }, ctx));
          events.onTool("flood_check", "end");
          if (f.error) {
            say("I couldn't pin down that parcel to check flooding.");
          } else if (!f.flood_zone) {
            say("FEMA doesn't have flood mapping at that spot.");
          } else if (f.in_floodway) {
            say(`Careful — that one is zone ${f.flood_zone} and sits in the regulatory floodway. That's about as wet as it gets on paper.`);
          } else if (f.in_100yr_floodplain_sfha) {
            say(`That one's in flood zone ${f.flood_zone} — inside the 100-year floodplain.`);
          } else if (String(f.zone_subtype ?? "").includes("0.2")) {
            say("It's in shaded zone X — the 500-year floodplain, but outside the 100-year.");
          } else {
            say(`It's in zone ${f.flood_zone} — minimal flood risk, outside the mapped floodplains.`);
          }
          if (f.flood_zone && !f.in_100yr_floodplain_sfha && f.parcel_touches_sfha) {
            say("Part of the lot does touch the 100-year floodplain, though.");
          }
        } catch {
          events.onTool("flood_check", "end");
          say("I couldn't reach FEMA's flood maps just now. Try again in a moment.");
        }
        return;
      }

      // ── Orientation ("where is this?") — the ground materializes ──
      if (/where (is|am|are)|what('s| is) (around|near)|orient me|show me the (area|ground)/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can show you where it sits.");
          return;
        }
        events.onTool("where_is_this", "start");
        try {
          const g = JSON.parse(await executeTool("where_is_this", { hcad_account: mem.lastAccount }, ctx));
          events.onTool("where_is_this", "end");
          if (g.error) {
            say("I couldn't pin down that parcel to orient you.");
          } else {
            say(`You're ${g.downtown}${g.zip ? `, zip ${g.zip}` : ""}.`);
            if (g.nearest_bayou) say(`${g.nearest_bayou.replace("~", "about ").replace("mi", "miles away")}.`);
            if (g.nearest_freeway) say(`${g.nearest_freeway.replace("~", "about ").replace("mi", "miles away")}.`);
            if (g.ground_features_on_map) say("The bayous and freeways are materializing on your map now.");
          }
        } catch {
          events.onTool("where_is_this", "end");
          say("The map servers didn't answer just now. Ask me where this is again in a moment.");
        }
        return;
      }

      // ── Code violations ("has the city been after them?") — 2014–2018 history ──
      if (/violation|code enforcement|city been (on|after)|cited by the city/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can pull its code-enforcement history.");
          return;
        }
        events.onTool("code_violations", "start");
        let v;
        try {
          v = JSON.parse(await executeTool("code_violations", { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool("code_violations", "end");
          say("The city's records didn't answer just now — try again in a moment.");
          return;
        }
        events.onTool("code_violations", "end");
        if (v.error) {
          say("The city's records didn't answer just now — try again in a moment.");
        } else if (!v.violation_count) {
          say("Clean sheet — no code-enforcement cases on this parcel in the city's published records. Mind that feed only runs 2014 through August 2018, so it's history, not current status.");
        } else {
          const cats = (v.categories as string[]).slice(0, 2).join(" and ").toLowerCase();
          say(
            `The city had ${v.violation_count} enforcement case${v.violation_count === 1 ? "" : "s"} on this parcel${cats ? ` — mostly ${cats}` : ""}, the latest in ${String(v.newest ?? "").slice(0, 4)}.`
          );
          say("That's a chronic-headache signal on the owner, and a gentle talking point. The public feed stops in August 2018 though — treat it as history, not what's on the property today.");
        }
        return;
      }

      // ── City overlays ("any restrictions?", "is it historic?") ──
      if (/historic|conservation|restrict|overlay|opportunity zone|preservation/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can check city restrictions on it.");
          return;
        }
        events.onTool("city_overlays", "start");
        try {
          const o = JSON.parse(await executeTool("city_overlays", { hcad_account: mem.lastAccount }, ctx));
          events.onTool("city_overlays", "end");
          if (o.error) {
            say("I couldn't pin down that parcel to check overlays.");
          } else if (!o.overlay_count) {
            say("Clean from the city's side — no historic districts, lot-size protections, or special overlays at this parcel. County deed restrictions can still apply, though.");
          } else {
            for (const h of o.overlays) {
              say(`It's in ${h.name ? `the ${h.name}` : "a"} ${h.label}.`);
            }
            if (String(o.development_risk).startsWith("RESTRICTED")) {
              say("That means extra approvals — and possibly no small-lot subdivision at all. Factor that in before running townhome numbers.");
            }
          }
        } catch {
          events.onTool("city_overlays", "end");
          say("The city's map servers didn't answer just now. Try the overlay check again in a moment.");
        }
        return;
      }

      // ── Chapter 42 feasibility ("how many townhomes fit on this?") ──
      if (/chapter\s*42|feasib|subdivid|how many.*\b(unit|townhome|town home|home|house)s?\b|\b(fit|build|put)\b.*\b(unit|townhome|town home|home|house)s?\b/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can run Chapter 42 on it.");
          return;
        }
        events.onTool("chapter42_feasibility", "start");
        try {
          const p = JSON.parse(await executeTool("chapter42_feasibility", { hcad_account: mem.lastAccount }, ctx));
          events.onTool("chapter42_feasibility", "end");
          if (p.error) {
            say("I couldn't get enough geometry on that parcel to run Chapter 42.");
          } else if (!p.units) {
            say("Under Chapter 42 that site doesn't yield a compliant subdivision — it's too small or too oddly shaped for even the reduced 1,400-square-foot lots.");
          } else {
            const lotTxt = p.avgLotSqft ? ` on roughly ${Math.round(p.avgLotSqft / 50) * 50}-square-foot lots` : "";
            say(`Under Chapter 42 urban rules you could fit about ${p.units} townhome${p.units === 1 ? "" : "s"} there${lotTxt}.`);
            say(
              p.bindingConstraint === "density"
                ? `Density is the binding constraint — that's the 27-per-acre cap, and this plan sits at ${p.densityPerAcre}.`
                : `Site geometry is the binding constraint, not density — the plan runs ${p.densityPerAcre} units per acre against the 27 cap.`
            );
            const os = p.openSpaceSqftPerLot
              ? ` and ${p.openSpaceSqftPerLot} square feet of compensating open space per lot`
              : "";
            say(`Plan for ${p.parkingSpaces} parking spaces${os}. Watch the site plan assemble on the lot.`);
          }
        } catch {
          events.onTool("chapter42_feasibility", "end");
          say("The feasibility engine hit a snag. Try that again.");
        }
        return;
      }

      // ── Comps question ("what are the comps?", "what's land trading for nearby?") ──
      if (/\b(comps?|comparables?)\b|\b(trading|selling|going)\s+for\b.*\b(near|around|nearby)|land\s+trade/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can pull comps around it.");
          return;
        }
        events.onTool("comps", "start");
        try {
          const c = JSON.parse(await executeTool("comps", { hcad_account: mem.lastAccount }, ctx));
          events.onTool("comps", "end");
          if (c.error) {
            say("I couldn't pin down that parcel to pull comps.");
          } else if (!c.comp_count) {
            say("I didn't find similar lots close by — this one may be an odd size or use for its area.");
          } else {
            const d = c.land_per_sqft;
            say(
              `I found ${c.comp_count} similar lots within about half a mile. Median land value runs ${Math.round(d.median)} dollars per square foot, with the middle half between ${Math.round(d.p25)} and ${Math.round(d.p75)}.`
            );
            if (c.subject_land_per_sqft != null) {
              const s = c.subject_land_per_sqft;
              const rel = d.median ? s / d.median : 1;
              const verdict =
                rel < 0.9 ? "below the neighborhood — worth a look" : rel > 1.1 ? "above the neighborhood" : "right in line with the neighborhood";
              say(`This one carries ${Math.round(s)} dollars per square foot of land — ${verdict}.`);
            }
            say("Keep in mind that's appraisal basis, not sale prices.");
          }
        } catch {
          events.onTool("comps", "end");
          say("Harris County records didn't answer just now. Try the comps again in a moment.");
        }
        return;
      }

      // ── Overnight digest ("what's new?", "anything overnight?") ──
      if (/\bdigest\b|overnight|what('s| is| has)? ?new\b|anything new|since yesterday|last night/i.test(userText)) {
        events.onTool("nightly_digest", "start");
        try {
          const d = JSON.parse(await executeTool("nightly_digest", {}, ctx));
          events.onTool("nightly_digest", "end");
          if (d.error) {
            say("The digest didn't come back just now — try again in a moment.");
          } else {
            if (d.swept_just_now) say("No stored digest yet, so I swept just now.");
            for (const b of d.bullets as string[]) say(b);
          }
        } catch {
          events.onTool("nightly_digest", "end");
          say("The digest didn't come back just now — try again in a moment.");
        }
        return;
      }

      // ── Morning briefing ("good morning", "brief my pipeline") ──
      if (/good morning|morning briefing|\bbriefing\b|my (hot )?leads|pipeline (review|check|status)/i.test(userText)) {
        events.onTool("pipeline_briefing", "start");
        try {
          const b = JSON.parse(await executeTool("pipeline_briefing", {}, ctx));
          events.onTool("pipeline_briefing", "end");
          if (b.error) {
            say("The pipeline didn't answer just now — try the briefing again in a moment.");
          } else if (!b.lead_count) {
            say("Pipeline's clear — no hot or new leads right now. Go find some dirt.");
          } else {
            const hot = b.leads.filter((l: { status: string }) => l.status === "hot_lead").length;
            say(
              `Morning. You've got ${b.lead_count} active lead${b.lead_count === 1 ? "" : "s"}${
                hot ? `, ${hot} of them hot` : ""
              } — the freshest are lighting up your map now.`
            );
            const newest = b.leads[0];
            if (newest?.address) {
              say(
                `Newest in the pipeline: ${String(newest.address).split(",")[0]}${
                  newest.status ? `, marked ${String(newest.status).replace(/_/g, " ")}` : ""
                }.`
              );
            }
            say(`Ask about any of them, or say "full picture" once one's in focus.`);
          }
        } catch {
          events.onTool("pipeline_briefing", "end");
          say("The pipeline didn't answer just now — try the briefing again in a moment.");
        }
        return;
      }

      // ── Deal radar ("what's changed hands around here?") ──
      if (/recent(ly)? (sold|sale|transfer|trade)|what('s| has| is)? ?(sold|traded|changed hands|transferr)|new owners? near|deal radar|radar/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll sweep the area for fresh transfers.");
          return;
        }
        events.onTool("recent_transfers", "start");
        try {
          const r = JSON.parse(await executeTool("recent_transfers", { hcad_account: mem.lastAccount }, ctx));
          events.onTool("recent_transfers", "end");
          if (r.error) {
            say("I couldn't pin down that parcel to run the radar.");
          } else if (!r.transfer_count) {
            say("Quiet zone — HCAD shows no recorded ownership changes within a mile.");
          } else {
            const monthYear = (iso: string | null) =>
              iso
                ? new Date(iso + "T00:00:00").toLocaleString("en-US", { month: "long", year: "numeric" })
                : "recently";
            say(
              `The radar found the ${Math.min(5, r.transfer_count)} freshest ownership changes within a mile — they're on your map now.`
            );
            const top = r.transfers.slice(0, 2);
            for (const t of top) {
              // "0 E 31st St" is HCAD's vacant-lot addressing — drop the zero.
              const spoken = (t.address?.split(",")[0] ?? "One").replace(/^0 /, "the lot on ");
              say(
                `${spoken} went to ${t.new_owner ?? "a new owner"} in ${monthYear(t.recorded)}${
                  t.appraised_value ? `, appraised at ${money(t.appraised_value)}` : ""
                }.`
              );
            }
            say("Those are deed recordings, not listings — and HCAD's data trails the courthouse by a few months.");
          }
        } catch {
          events.onTool("recent_transfers", "end");
          say("Harris County records didn't answer just now. Run the radar again in a moment.");
        }
        return;
      }

      // ── Session wrap-up ("wrap up the session") — note every pipeline lead ──
      if (/wrap (it |the session |this )?up|log (the |this )?session|session (summary|notes|recap)/i.test(userText)) {
        const discussed = [...mem.knownParcels.values()].filter((p) =>
          mem.leadStatusByAccount.has(p.hcadAccount)
        );
        if (!discussed.length) {
          say("Nothing to log — none of the parcels we discussed are in the pipeline yet.");
          return;
        }
        let logged = 0;
        for (const p of discussed) {
          const parts: string[] = [`HVI session recap ${new Date().toISOString().slice(0, 10)}:`];
          if (p.appraisedValue != null) {
            parts.push(
              `appraised $${Math.round(p.appraisedValue).toLocaleString()}${
                p.lotSqft ? ` ($${Math.round(p.appraisedValue / p.lotSqft)}/sqft lot)` : ""
              }`
            );
          }
          const flood = mem.floodByAccount.get(p.hcadAccount);
          if (flood) parts.push(`flood: ${flood.label}`);
          const median = mem.compsMedianByAccount.get(p.hcadAccount);
          if (median != null) parts.push(`nearby land median ~$${Math.round(median)}/sqft`);
          const ch42 = mem.ch42ByAccount.get(p.hcadAccount);
          if (ch42?.units) parts.push(`Ch.42 fit: ${ch42.units} units @ ${ch42.densityPerAcre}/acre`);
          if (p.absenteeOwner) parts.push("absentee owner");
          if (mem.user) parts.push(`logged by ${mem.user} via Jarvo`);
          events.onTool("crm_add_note", "start");
          try {
            const res = JSON.parse(
              await executeTool("crm_add_note", { hcad_account: p.hcadAccount, note: parts.join(" · ") }, ctx)
            );
            if (res.ok) logged++;
          } catch {
            /* skip this lead, keep logging the rest */
          }
          events.onTool("crm_add_note", "end");
        }
        say(
          logged
            ? `Session logged — I wrote recap notes to ${logged} lead${logged === 1 ? "" : "s"} in the pipeline.`
            : "I couldn't write the recap notes — the CRM didn't take them."
        );
        return;
      }

      // ── LLC graph ("who REALLY owns this?") — mailbox beats owner name ──
      if (/really own|actually own|same mailbox|shell (compan|game)|llc game|behind (the|this) llc|true (owner|portfolio)/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll trace who's really behind it.");
          return;
        }
        events.onTool("owner_graph", "start");
        let g;
        try {
          g = JSON.parse(await executeTool("owner_graph", { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool("owner_graph", "end");
          say("Harris County records didn't answer just now — try that again in a moment.");
          return;
        }
        events.onTool("owner_graph", "end");
        if (g.error) {
          say("I couldn't pin down that parcel to trace the owner.");
          return;
        }
        if (g.parcel_count <= 1) {
          say("As far as the mailbox trail shows, this is their only Harris County parcel.");
          return;
        }
        const names = (g.distinct_owner_names as string[]).filter((n) => n !== "unknown");
        say(
          `The mailbox behind this one controls ${g.parcel_count} Harris County parcels` +
            (names.length > 1 ? `, operating under ${names.length} different names — ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", and more" : ""}` : "") +
            `. Total appraised holdings run ${money(g.total_appraised)}. The biggest are lighting up your map.`
        );
        say("That's grouped by tax mailing address, which catches the LLC-per-deal game — and county records run a few months behind.");
        return;
      }

      // ── Assemblage ("who's assembling?", "can these lots combine?") ──
      if (/assembl|combin\w+ (the |these |two )?lots|package (the|these|it) (lots|parcels|deal)|accumulat/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll scan the block for assemblage plays.");
          return;
        }
        events.onTool("assemblage_scan", "start");
        let a;
        try {
          a = JSON.parse(await executeTool("assemblage_scan", { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool("assemblage_scan", "end");
          say("Harris County records didn't answer just now — try the scan again in a moment.");
          return;
        }
        events.onTool("assemblage_scan", "end");
        if (a.error) {
          say("I couldn't pin down that parcel to scan the block.");
          return;
        }
        const prog = a.assemblages_in_progress as Array<{ operating_names: string[]; parcel_count: number; includes_subject: boolean; addresses: (string | null)[] }>;
        const opps = a.assemblage_opportunities as Array<{ addresses: (string | null)[]; ch42_units_combined: number; ch42_units_separate: number; why_owners_look_tired: string[] }>;
        if (!prog.length && !opps.length) {
          say(`Scanned ${a.parcels_scanned} parcels around it — no multi-parcel mailboxes touching each other, and no tired-neighbor pairs that combine into a bigger Chapter 42 yield. Quiet block.`);
          return;
        }
        for (const c of prog.slice(0, 2)) {
          say(
            `${c.includes_subject ? "This owner is already assembling here" : `Someone is assembling nearby`}: ${c.parcel_count} adjacent parcels controlled from one mailbox` +
              (c.operating_names.length > 1 ? `, under names like ${c.operating_names.slice(0, 2).join(" and ")}` : "") +
              "."
          );
        }
        for (const o of opps.slice(0, 2)) {
          const streets = o.addresses.map((x) => (x ?? "").split(",")[0]).filter(Boolean).join(" and ");
          say(
            `Opportunity: ${streets} sit side by side with different tired owners — together they'd carry ${o.ch42_units_combined} Chapter 42 units where separately they only pencil to ${o.ch42_units_separate}. That package doesn't exist until someone makes the calls.`
          );
        }
        say("Adjacency and yields are county-data estimates — verify with a survey before anyone gets excited.");
        return;
      }

      // ── Owner portfolio ("what else do they own?") — nodes pop in as we speak ──
      if (/what else.*own|other (propert|parcel|holding)|owner('s)? (portfolio|holdings)|portfolio/i.test(userText)) {
        const p = mem.lastAccount ? mem.knownParcels.get(mem.lastAccount) : null;
        if (!p?.ownerName) {
          say("Ask me about a property first, then I can map the owner's other holdings.");
          return;
        }
        const primaryOwner = p.ownerName.split(";")[0].trim();
        events.onTool("owner_lookup", "start");
        let holdings;
        try {
          holdings = await lookupByOwner(primaryOwner, 12);
        } catch {
          events.onTool("owner_lookup", "end");
          say("Harris County records didn't answer just now — try the portfolio again in a moment.");
          return;
        }
        events.onTool("owner_lookup", "end");
        const others = holdings.filter((o) => o.hcadAccount !== p.hcadAccount);
        if (!others.length) {
          say(`As far as HCAD shows, this is the only Harris County parcel under ${primaryOwner}.`);
          return;
        }
        const shown = others.slice(0, 5);
        const totalValue = holdings.reduce((a, o) => a + (o.appraisedValue ?? 0), 0);
        say(
          `${primaryOwner} shows ${others.length} more parcel${others.length === 1 ? "" : "s"} in Harris County${
            others.length > shown.length ? ` — mapping the first ${shown.length}` : " — building them onto your map"
          }.`
        );
        // One node at a time, timed to feel narrated-in rather than dumped.
        for (const o of shown) {
          if (signal.aborted) return;
          ctx.parcels.set(o.hcadAccount, o);
          mem.knownParcels.set(o.hcadAccount, o);
          emitDecorated(ctx, [o]);
          await sleep(650);
        }
        // Bring focus home to the parcel we were talking about.
        emitDecorated(ctx, [p]);
        mem.lastAccount = p.hcadAccount;
        say(`All together that's ${money(totalValue)} in appraised holdings.`);
        return;
      }

      // ── Call-outcome logging ("log that call — no answer") — every call
      // makes the phones data smarter. Number status lives in the CRM. ──
      if (/\blog\b[^.]*\bcall\b|\bcall log\b|log (it|that|this) as/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Which property was the call about? Pull it up first, then log the call.");
          return;
        }
        const outcome = /wrong number|not (him|her|them)\b|wrong person/i.test(userText)
          ? "wrong_number"
          : /bad number|disconnect|not in service|dead number|out of service/i.test(userText)
            ? "bad_number"
            : /no answer|no-answer|didn'?t (pick|answer)|voice ?mail|left a message/i.test(userText)
              ? "no_answer"
              : /talked|spoke|connected|got (a ?hold|through)|reached (him|her|them)/i.test(userText)
                ? "talked"
                : null;
        if (!outcome) {
          say("Log it as what — no answer, wrong number, or did you talk to them?");
          return;
        }
        const lastDigits = userText.match(/(?:ending|ends)\s*(?:in\s*)?(\d{2,4})/i)?.[1] ?? null;
        events.onTool("log_call_outcome", "start");
        let r;
        try {
          r = JSON.parse(
            await executeTool(
              "log_call_outcome",
              { hcad_account: mem.lastAccount, outcome, ...(lastDigits ? { phone_last_digits: lastDigits } : {}) },
              ctx
            )
          );
        } catch {
          events.onTool("log_call_outcome", "end");
          say("The CRM didn't take the call log — try again in a moment.");
          return;
        }
        events.onTool("log_call_outcome", "end");
        if (!r.ok) {
          say(String(r.reason ?? "Couldn't log that call."));
          return;
        }
        const spokenNum = String(r.number).replace(/\D+/g, "").slice(-4);
        say(
          outcome === "wrong_number" || outcome === "bad_number"
            ? `Logged — the number ending ${spokenNum} is marked bad now, it won't come up to dial again.`
            : outcome === "talked"
              ? `Logged as a live conversation on the number ending ${spokenNum}. Say "note:" if you want to dictate what they said.`
              : `Logged — no answer on the number ending ${spokenNum}.`
        );
        return;
      }

      // ── Skip trace ("trace the owner", "trace the top three") — CRM-first,
      // provider only when the CRM has nothing, write-back into the lead. ──
      if (/skip.?trace|\btrace\b/i.test(userText)) {
        const topN = userText.match(/top\s+(one|two|three|four|five|\d+)/i)?.[1]?.toLowerCase() ?? null;
        if (topN) {
          const wordMap: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
          const parsed = wordMap[topN] ?? parseInt(topN, 10);
          const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
          say(`On it — saving and tracing the top ${count}. Give me a moment.`);
          events.onTool("trace_top_candidates", "start");
          let t;
          try {
            t = JSON.parse(await executeTool("trace_top_candidates", { count }, ctx));
          } catch {
            events.onTool("trace_top_candidates", "end");
            say("The trace run hit a snag — try again in a moment.");
            return;
          }
          events.onTool("trace_top_candidates", "end");
          if (!t.ok) {
            say(String(t.reason ?? "No candidates to trace."));
            return;
          }
          let hits = 0;
          let mock = false;
          for (const r of t.results as Array<{ address?: string | null; trace?: { phones_found?: number; mock_test_data?: boolean } }>) {
            if (r.trace?.phones_found) hits++;
            if (r.trace?.mock_test_data) mock = true;
          }
          say(
            `Done — ${t.candidates_processed} candidate${t.candidates_processed === 1 ? "" : "s"} saved as leads and traced; numbers came back on ${hits} of them.`
          );
          if (mock) say("Heads up: that ran on the MOCK trace provider — fabricated test data, not real numbers, until a real provider key is configured.");
          return;
        }
        if (!mem.lastAccount) {
          say("Ask me about a property first, then say trace it and I'll hunt down the owner's number.");
          return;
        }
        const force = /again|anyway|re-?trace|fresh/i.test(userText);
        events.onTool("skip_trace", "start");
        let s;
        try {
          s = JSON.parse(await executeTool("skip_trace", { hcad_account: mem.lastAccount, ...(force ? { force: true } : {}) }, ctx));
        } catch {
          events.onTool("skip_trace", "end");
          say("The trace didn't come back — try again in a moment.");
          return;
        }
        events.onTool("skip_trace", "end");
        if (s.error) {
          say("I couldn't pin down that parcel to trace.");
          return;
        }
        if (s.needs_lead) {
          say(`${String(s.address ?? "That one").split(",")[0]} isn't a lead yet — traced numbers live on the lead. Say "save it" first, then trace.`);
          return;
        }
        if (!s.ok) {
          say(String(s.reason ?? "The trace didn't come back."));
          return;
        }
        if (s.from_crm) {
          say(
            `Already have ${s.dialable_numbers_on_file} good number${s.dialable_numbers_on_file === 1 ? "" : "s"} on file — no trace charged, never pay twice. They're on the card. Say "trace it again" if you want a fresh pull anyway.`
          );
          return;
        }
        if (!s.phones_found && !s.emails_found) {
          say(
            s.entity_owner
              ? `The owner of record is a company, and a person trace can't touch a company — no lookup was charged. Say "who really owns this" and I'll chase the mailbox trail; when a human name surfaces, say trace it again.`
              : `${s.provider} came up empty on this owner — no numbers, no emails. The letter is the play here.`
          );
          return;
        }
        const conf = s.match_confidence != null ? `, match confidence about ${Math.round(s.match_confidence * 100)} percent` : "";
        say(
          `Found ${s.phones_found} number${s.phones_found === 1 ? "" : "s"}${s.emails_found ? ` and ${s.emails_found} email${s.emails_found === 1 ? "" : "s"}` : ""}${conf}.`
        );
        if (s.dnc_flagged) {
          say(`${s.dnc_flagged} of them ${s.dnc_flagged === 1 ? "is" : "are"} on the Do-Not-Call registry — ${s.dnc_flagged === 1 ? "it renders" : "they render"} locked on the card and never get dialed.`);
        }
        say(
          s.written_to_crm
            ? "They're written into the CRM and on the card now."
            : `Nothing was written to the CRM — ${String(s.write_note ?? "the write-back didn't run")}.`
        );
        if (s.mock_test_data) {
          say("And straight up: that came from the MOCK provider — fabricated test data, not real contact info, until a real trace provider is configured.");
        }
        return;
      }

      // ── Propensity hot list ("who's most likely to sell around here?") ──
      if (/hot ?list|hottest (prospect|parcel)|top prospects|most likely to sell|propensity/i.test(userText)) {
        const zipMatch = userText.match(/\b(77\d{3})\b/)?.[1];
        if (!zipMatch && !mem.lastAccount) {
          say("Give me a zip, or pull up a property first, and I'll read you its hot list.");
          return;
        }
        events.onTool("hot_list", "start");
        let h;
        try {
          h = JSON.parse(
            await executeTool("hot_list", zipMatch ? { zip: zipMatch } : { hcad_account: mem.lastAccount }, ctx)
          );
        } catch {
          events.onTool("hot_list", "end");
          say("The hot list didn't come back — try again in a moment.");
          return;
        }
        events.onTool("hot_list", "end");
        if (!h.ok) {
          say(String(h.reason ?? "No hot list for that area yet."));
          return;
        }
        say(
          `Zip ${h.zip} has ${h.on_list} scored prospect${h.on_list === 1 ? "" : "s"} above the floor${h.scored_month ? `, ranked from the ${h.scored_month} county archive` : ""} — the top ${h.shown.length} are on your map.`
        );
        for (const c of h.shown.slice(0, 2)) {
          say(
            `${(c.address ?? "One").split(",")[0]} scores ${c.score}: ${c.why}${c.appraised_value ? `, appraised ${money(c.appraised_value)}` : ""}.`
          );
        }
        say("Scores don't include tax distress — say tax radar to layer that on. Say save it or trace it on any of them and I'll move.");
        return;
      }

      // ── Owner contacts ("what's the owner's number?") — from the CRM ──
      if (/owner('s)? (number|phone|contact)|phone number|how do i reach|contact info/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can pull the owner's contact info.");
          return;
        }
        events.onTool("crm_lead_check", "start");
        let lc;
        try {
          lc = JSON.parse(await executeTool("crm_lead_check", { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool("crm_lead_check", "end");
          say("The CRM didn't answer just now — try again in a moment.");
          return;
        }
        events.onTool("crm_lead_check", "end");
        if (!lc.found) {
          say("That one isn't a lead yet, so there's no contact record. Say save it, then say trace it and I'll go find a number.");
          return;
        }
        const c = lc.lead?.contacts;
        if (!c || (!c.primary_phone && !c.good_phones?.length)) {
          say("It's in the pipeline, but no good number's on file for the owner yet. Say trace it and I'll go hunting.");
          return;
        }
        const speakNum = (n: string) => n.replace(/\D+/g, "").split("").join(" ");
        say(`Primary number is ${speakNum(c.primary_phone ?? c.good_phones[0].number)} — it's on the card, tap it to dial.`);
        const extra = (c.good_phones ?? []).filter((p: { number: string }) => p.number !== c.primary_phone);
        if (extra.length) say(`There ${extra.length === 1 ? "is one more good number" : `are ${extra.length} more good numbers`} on file.`);
        if (c.bad_phones?.length) say(`${c.bad_phones.length} number${c.bad_phones.length === 1 ? " is" : "s are"} marked bad — don't redial those.`);
        return;
      }

      // ── Voice documents: draft to the preview panel, file on approval ──
      const docDraft = userText.match(/draft|write|prep(are)?/i)
        ? /letter|write to the owner/i.test(userText)
          ? "draft_letter"
          : /call sheet|for the call|before i call/i.test(userText)
            ? "call_sheet"
            : /offer (summary|write.?up)|summarize the offer/i.test(userText)
              ? "offer_summary"
              : null
        : /call sheet/i.test(userText)
          ? "call_sheet"
          : null;
      if (docDraft && !/deal memo/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll draft it.");
          return;
        }
        events.onTool(docDraft, "start");
        let d;
        try {
          d = JSON.parse(await executeTool(docDraft, { hcad_account: mem.lastAccount, guidance: userText }, ctx));
        } catch {
          events.onTool(docDraft, "end");
          say("The drafting engine hit a snag — try that again in a moment.");
          return;
        }
        events.onTool(docDraft, "end");
        if (d.error) {
          say(String(d.error).includes("API key") ? "Drafting needs the full brain, which isn't configured right now." : "The draft didn't come together — try again in a moment.");
          return;
        }
        say(`${d.title} is on your screen. Read it over — say "file it" to save it to the lead, or tell me what to change.`);
        return;
      }
      // "file it", "looks good, send it", "file the letter" — anywhere in the
      // utterance, so approval phrasing stays natural.
      if (/\b(file|send) (it|that|the (letter|sheet|summary|doc(ument)?))\b/i.test(userText)) {
        events.onTool("file_document", "start");
        let f;
        try {
          f = JSON.parse(await executeTool("file_document", {}, ctx));
        } catch {
          events.onTool("file_document", "end");
          say("Filing hit a snag — try again in a moment.");
          return;
        }
        events.onTool("file_document", "end");
        say(f.ok ? "Filed — it's on the lead in the CRM." : String(f.reason ?? "Couldn't file it."));
        return;
      }

      // ── Deal memo ("write me the deal memo") — the considered write-up ──
      if (/deal memo|write (me )?(a |the )?memo|memo (it|this) (up)?/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll write the memo on it.");
          return;
        }
        say("Working the memo up — give me half a minute, the map builds while I do.");
        events.onTool("deal_memo", "start");
        let m;
        try {
          m = JSON.parse(await executeTool("deal_memo", { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool("deal_memo", "end");
          say("The memo engine hit a snag — try that again in a moment.");
          return;
        }
        events.onTool("deal_memo", "end");
        if (m.error) {
          say(String(m.error).includes("API key") ? "Deal memos need the full brain, which isn't configured right now." : "The memo didn't come together — try again in a moment.");
          return;
        }
        const thesis = String(m.memo).match(/THESIS:\s*([^\n]+)/)?.[1];
        const number = String(m.memo).match(/THE NUMBER:\s*([^\n]+)/)?.[1];
        say(`Memo's done${m.saved_to_crm ? " and filed on the lead" : ""}.`);
        if (thesis) say(`Thesis: ${thesis}`);
        if (number) say(`The number: ${number}`);
        if (!m.saved_to_crm) say("It's not a lead yet, so the memo isn't filed anywhere — say save it first if you want it kept.");
        return;
      }

      // ── Accountability ("which leads have gone cold?") ──
      if (/stale|gone cold|going cold|haven't (been )?(touch|call|contact)|follow.?ups? (due|owed|outstanding)|not.*touched in/i.test(userText)) {
        events.onTool("stale_leads", "start");
        let s2;
        try {
          s2 = JSON.parse(await executeTool("stale_leads", {}, ctx));
        } catch {
          events.onTool("stale_leads", "end");
          say("The pipeline didn't answer just now — try again in a moment.");
          return;
        }
        events.onTool("stale_leads", "end");
        if (s2.error) {
          say("The pipeline didn't answer just now — try again in a moment.");
        } else if (!s2.stale_count) {
          say(`Nothing's going cold — every hot and follow-up lead has been touched inside ${s2.quiet_threshold_days} days. Tight ship.`);
        } else {
          say(`${s2.stale_count} lead${s2.stale_count === 1 ? " is" : "s are"} going cold — quiet for ${s2.quiet_threshold_days} days or more.`);
          for (const l of s2.stale.slice(0, 3)) {
            say(
              `${(l.address ?? "One").split(",")[0]}, marked ${String(l.status).replace(/_/g, " ")}, ${
                l.days_quiet != null ? `${l.days_quiet} days quiet` : "no activity ever recorded"
              }.`
            );
          }
        }
        return;
      }

      // ── Teardown radar ("what's trading as dirt around here?") ──
      if (/teardown|tear.?down|scrape|trading as (dirt|land)|land play/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll sweep the block for teardowns.");
          return;
        }
        events.onTool("teardown_radar", "start");
        let t2;
        try {
          t2 = JSON.parse(await executeTool("teardown_radar", { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool("teardown_radar", "end");
          say("Harris County records didn't answer just now — run the teardown sweep again in a moment.");
          return;
        }
        events.onTool("teardown_radar", "end");
        if (t2.error) {
          say("I couldn't pin down that parcel to sweep for teardowns.");
        } else if (!t2.teardown_count) {
          say(`Scanned ${t2.parcels_scanned} parcels within half a mile — nothing trading as dirt. The structures around here still carry their value.`);
        } else {
          say(
            `Found ${t2.teardown_count} teardown-grade parcel${t2.teardown_count === 1 ? "" : "s"} within half a mile — buildings carrying under fifteen percent of the appraisal${
              t2.absentee_among_them ? `, ${t2.absentee_among_them} with absentee owners` : ""
            }. The closest are on your map.`
          );
          const top = t2.teardowns[0];
          if (top?.address) {
            say(
              `Sharpest: ${String(top.address).split(",")[0]} — structure is ${top.building_share_pct} percent of a ${money(top.appraised_value)} appraisal${
                top.held_years ? `, held ${top.held_years} years` : ""
              }${top.absentee_owner ? ", absentee" : ""}.`
            );
          }
          say("That's an appraisal-basis screen, not a condition report.");
        }
        return;
      }

      // ── Tax delinquency ("behind on taxes?", "tax sales near here?") ──
      if (/tax (sale|auction|delinquen|suit)|delinquent|behind on .*tax|owes? .*tax|distress/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I can check the tax-sale pipeline around it.");
          return;
        }
        const radar = /\b(near|nearby|around|area|close|radar)\b/i.test(userText);
        const tool = radar ? "tax_sale_radar" : "tax_sale_check";
        events.onTool(tool, "start");
        let t;
        try {
          t = JSON.parse(await executeTool(tool, { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool(tool, "end");
          say("The tax-sale listings didn't answer just now — try again in a moment.");
          return;
        }
        events.onTool(tool, "end");
        if (t.error) {
          say("The tax-sale listings didn't answer just now — try again in a moment.");
        } else if (!radar) {
          if (t.in_tax_sale_pipeline) {
            say(
              `Yes — this one is in the delinquent-tax legal pipeline: ${String(t.status).toLowerCase()}` +
                (t.auction_date ? `, with an auction set for ${t.auction_date}` : "") +
                (t.minimum_bid ? `, minimum bid ${money(t.minimum_bid)}` : "") +
                ". That's a motivated seller with a clock running."
            );
          } else {
            say(
              "No tax suit or auction on record with the county's collection firm. That doesn't prove taxes are current — owners merely behind, short of a lawsuit, don't show in these listings."
            );
          }
        } else {
          if (!t.distressed_count) {
            say("No tax suits or scheduled auctions within a mile — clean on the distress radar.");
          } else {
            say(
              `Found ${t.distressed_count} propert${t.distressed_count === 1 ? "y" : "ies"} in the delinquent-tax pipeline within a mile — the closest are on your map now.`
            );
            for (const d of t.distressed.slice(0, 2)) {
              say(
                `${(d.address ?? "One").split(",")[0]} is ${String(d.status).toLowerCase()}` +
                  (d.auction_date ? `, auction ${d.auction_date}` : "") +
                  (d.minimum_bid ? `, minimum bid ${money(d.minimum_bid)}` : "") +
                  "."
              );
            }
            say("Those come from the collection firm's sale listings — suits and auctions, not the full delinquent roll.");
          }
        }
        return;
      }

      // ── The Verdict ("should we pursue this?") — the kill-chain, one answer ──
      if (/\bverdict\b|should (we|i) (pursue|buy|chase|go after)|worth (pursuing|chasing|buying|going after)|go.or.no.go|is (this|it) (a deal|worth it)|(pursue|chase) (this|it)\b/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll run the verdict on it.");
          return;
        }
        events.onTool("verdict", "start");
        let v;
        try {
          v = JSON.parse(await executeTool("verdict", { hcad_account: mem.lastAccount }, ctx));
        } catch {
          events.onTool("verdict", "end");
          say("The verdict engine hit a snag — try that again in a moment.");
          return;
        }
        events.onTool("verdict", "end");
        if (v.error) {
          say("I couldn't pin down that parcel to run the verdict.");
          return;
        }
        const addr = v.address ? ` on ${String(v.address).split(",")[0]}` : "";
        say(`The verdict${addr}: ${v.verdict === "GREEN" ? "green — pursue it" : v.verdict === "YELLOW" ? "yellow — pursue with eyes open" : "red — walk unless the price says otherwise"}.`);
        const h = v.headline;
        if (h.land_basis_per_buildable_unit && h.buildable_units) {
          say(
            `The number that matters: about ${money(h.land_basis_per_buildable_unit)} of basis per buildable unit, across ${h.buildable_units} Chapter 42 units.`
          );
        }
        if (h.subject_land_per_sqft != null && h.comps_land_median_per_sqft != null) {
          say(
            `The dirt runs ${Math.round(h.subject_land_per_sqft)} dollars a square foot against a ${Math.round(h.comps_land_median_per_sqft)}-dollar neighborhood median.`
          );
        }
        const flagged = (v.signals as Array<{ status: string; detail: string }>).filter((s) => s.status !== "green");
        for (const s of flagged.slice(0, 4)) say(s.detail);
        if (!flagged.length) say("Overlays, flood, yield, pricing, and structure all come back clean.");
        say("That's a screen from county records at appraisal basis — not underwriting.");
        return;
      }

      // ── "Give me the full picture" — chain every tool on the focus parcel ──
      if (/full (picture|workup|report|story)|run (everything|it all|the works)|brief me|work (it|this) up/i.test(userText)) {
        if (!mem.lastAccount) {
          say("Ask me about a property first, then I'll run the full workup.");
          return;
        }
        const p = mem.knownParcels.get(mem.lastAccount);
        say(`Here's the full picture${p?.address ? ` on ${p.address.split(",")[0]}` : ""}.`);
        if (p?.appraisedValue != null) {
          const pps = p.lotSqft ? ` — about ${Math.round(p.appraisedValue / p.lotSqft)} dollars per square foot of lot` : "";
          say(`Appraised at ${money(p.appraisedValue)}${pps}.`);
        }
        const run = async (tool: string, args: Record<string, unknown>) => {
          events.onTool(tool, "start");
          try {
            const res = JSON.parse(await executeTool(tool, args, ctx));
            events.onTool(tool, "end");
            return res;
          } catch {
            events.onTool(tool, "end");
            return null;
          }
        };
        const flood = await run("flood_check", { hcad_account: mem.lastAccount });
        if (flood?.flood_zone) {
          say(
            flood.in_100yr_floodplain_sfha
              ? `Flood-wise it's zone ${flood.flood_zone} — inside the 100-year floodplain.`
              : `Flood-wise it's zone ${flood.flood_zone} — outside the 100-year floodplain.`
          );
        }
        const comps = await run("comps", { hcad_account: mem.lastAccount });
        if (comps?.comp_count) {
          say(
            `Nearby land runs about ${Math.round(comps.land_per_sqft.median)} dollars a square foot across ${comps.comp_count} similar lots${
              comps.subject_land_per_sqft != null ? `; this one carries ${Math.round(comps.subject_land_per_sqft)}` : ""
            }.`
          );
        }
        const plan = await run("chapter42_feasibility", { hcad_account: mem.lastAccount });
        if (plan?.units) {
          say(`Chapter 42 pencils out to ${plan.units} townhomes at ${plan.densityPerAcre} per acre.`);
        }
        const crm = await run("crm_lead_check", { hcad_account: mem.lastAccount });
        if (crm?.found) {
          say(`And it's already in your pipeline, marked ${String(crm.lead?.status ?? "new").replace(/_/g, " ")}.`);
        } else if (crm && crm.found === false) {
          say(`It's not in the pipeline yet — say "save it" if you want it in.`);
        }
        return;
      }

      const addressMatch = userText.match(/\d{1,6}\s+[A-Za-z0-9 .']{2,}/);

      // ── Follow-ups about the parcel in focus ("who owns it", "how big is it") ──
      if (!addressMatch && mem.lastAccount) {
        const p = mem.knownParcels.get(mem.lastAccount);
        if (p) {
          if (/who owns|who is the owner|owner\b/i.test(userText)) {
            const since = p.ownedSince ? ` They've had it since ${p.ownedSince.slice(0, 4)}.` : "";
            const abs = p.absenteeOwner && p.mailingAddress ? ` Tax mail goes elsewhere — looks like an absentee owner.` : "";
            say(`The owner on record is ${p.ownerName ?? "not listed"}.${since}${abs}`.trim());
            return;
          }
          if (/worth|value|apprais|cost|price/i.test(userText)) {
            const pps = p.appraisedValue != null && p.lotSqft ? ` — ${Math.round(p.appraisedValue / p.lotSqft)} dollars per square foot of lot` : "";
            say(`It's appraised at ${money(p.appraisedValue)}${pps}.`);
            return;
          }
          if (/how (big|large)|lot size|square (feet|footage)|acreage/i.test(userText)) {
            say(p.lotSqft ? `The lot is ${sqft(p.lotSqft)}.` : "HCAD doesn't list a lot size for it.");
            return;
          }
          if (/mailing address|where.*(mail|owner live)/i.test(userText)) {
            say(p.mailingAddress ? `Tax mail goes to ${p.mailingAddress}.` : "No mailing address on record.");
            return;
          }
        }
      }

      if (!addressMatch) {
        say(
          "I didn't catch a property in that. Give me a street address — try: what's 505 Westcott Street worth? Or say comps, floodplain, or townhomes about the parcel on screen."
        );
        return;
      }

      events.onTool("property_lookup", "start");
      let parsed: { matches: number; parcels?: CompactParcel[] };
      try {
        const raw = await executeTool("property_lookup", { address: addressMatch[0] }, ctx);
        parsed = JSON.parse(raw);
      } catch {
        events.onTool("property_lookup", "end");
        say("I couldn't reach Harris County records just now. Give me a second and try again.");
        return;
      }
      events.onTool("property_lookup", "end");

      if (!parsed.matches || !parsed.parcels?.length) {
        say("I didn't find that address in Harris County records. Could you repeat the street name?");
        return;
      }

      if (parsed.matches === 1) {
        const p = parsed.parcels[0];
        const lot = p.lot_sqft ? ` The lot is ${sqft(p.lot_sqft)}.` : "";
        const since = p.owned_since ? ` They've owned it since ${p.owned_since.slice(0, 4)}.` : "";
        const pps = p.value_per_lot_sqft;
        const perSqft = pps
          ? ` That works out to about ${pps >= 10 ? Math.round(pps) : pps.toFixed(1)} dollars per square foot of lot.`
          : "";
        say(`${p.address ?? "That property"} is appraised at ${money(p.appraised_value)}.${perSqft}`.trim());
        say(`The owner on record is ${p.owner ?? "not listed"}.${since}${lot}`.trim());
        if (p.absentee_owner && p.mailing_address) {
          // Speak street + city; drop zip and state ("1216 Yale St, Houston").
          const mailSpoken = p.mailing_address
            .replace(/,?\s*\b\d{5}(-\d{4})?\b/g, "")
            .replace(/,\s*TX\s*$/i, "")
            .trim();
          say(`Tax mail goes to ${mailSpoken || p.mailing_address} — looks like an absentee owner.`);
        }
        // Pipeline check — the CRM knows things HCAD doesn't.
        try {
          const crm = JSON.parse(await executeTool("crm_lead_check", { hcad_account: p.hcad_account }, ctx));
          if (crm.found) {
            say(`Heads up — this one is already in your pipeline, marked ${String(crm.lead?.status ?? "unknown").replace(/_/g, " ")}.`);
          }
        } catch {
          /* CRM hiccup — skip the pipeline note */
        }
      } else {
        const values = parsed.parcels
          .map((p) => p.appraised_value)
          .filter((v): v is number => v != null)
          .sort((a, b) => a - b);
        const range =
          values.length > 1 ? ` Unit values run from ${money(values[0])} up to ${money(values[values.length - 1])}.` : "";
        say(
          `That address matches ${parsed.matches} records, so it's likely a condo or multi-unit building.${range}`
        );
        say("Ask about a specific unit if you want an owner name.");
      }
    },
    reset() {},
  };
}
