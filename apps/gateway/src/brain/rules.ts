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
