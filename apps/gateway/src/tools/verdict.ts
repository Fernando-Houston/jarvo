// The Verdict: "should we pursue this?" distilled to one screen — the whole
// kill-chain (city overlays → flood → Chapter 42 → comps) collapsed into
// GREEN / YELLOW / RED plus the number that matters: land basis per buildable
// unit against the neighborhood's land median.
//
// Discipline (INTELLIGENCE-ROADMAP §4): this is a RANKING aid with receipts,
// not an oracle. Every signal carries its detail; blockers go red, judgment
// calls go yellow, and the caveat that it's appraisal-basis screening — not
// underwriting — rides on every result.

import type { Parcel } from "./hcad";

export type Signal = {
  factor: "overlays" | "flood" | "chapter42" | "pricing" | "structure" | "distress";
  status: "green" | "yellow" | "red";
  detail: string;
};

export type Verdict = {
  hcad_account: string;
  address: string | null;
  verdict: "GREEN" | "YELLOW" | "RED";
  /** The one number: what each buildable unit's dirt costs at the asking basis. */
  headline: {
    land_basis_per_buildable_unit: number | null;
    buildable_units: number | null;
    subject_land_per_sqft: number | null;
    comps_land_median_per_sqft: number | null;
    premium_vs_median_pct: number | null;
  };
  signals: Signal[];
  note: string;
};

// Sub-tool JSON shapes (as returned by executeTool cases).
type OverlaysResult = {
  error?: string;
  overlay_count?: number;
  overlays?: Array<{ key: string; label: string; name: string | null }>;
  development_risk?: string;
};
type FloodResult = {
  error?: string;
  flood_zone?: string | null;
  in_100yr_floodplain_sfha?: boolean;
  in_floodway?: boolean;
  parcel_touches_sfha?: boolean;
};
type Ch42Result = { error?: string; units?: number; densityPerAcre?: number; bindingConstraint?: string };
type CompsResult = {
  error?: string;
  comp_count?: number;
  subject_land_per_sqft?: number | null;
  land_per_sqft?: { median: number | null };
};
type TaxSaleResult = {
  error?: string;
  in_tax_sale_pipeline?: boolean;
  sale_type?: string;
  status?: string;
  auction_date?: string | null;
};

export function composeVerdict(inputs: {
  parcel: Parcel;
  overlays: OverlaysResult | null;
  flood: FloodResult | null;
  ch42: Ch42Result | null;
  comps: CompsResult | null;
  taxSale?: TaxSaleResult | null;
}): Verdict {
  const { parcel, overlays, flood, ch42, comps, taxSale } = inputs;
  const signals: Signal[] = [];

  // ── City overlays: the play-killers come first ──
  if (!overlays || overlays.error) {
    signals.push({ factor: "overlays", status: "yellow", detail: "Couldn't verify city overlays — check before committing." });
  } else if (overlays.development_risk?.startsWith("RESTRICTED")) {
    signals.push({
      factor: "overlays",
      status: "red",
      detail: overlays.development_risk.replace(/^RESTRICTED:\s*/, "Restricted: "),
    });
  } else if (overlays.overlay_count) {
    signals.push({
      factor: "overlays",
      status: "yellow",
      detail: "Non-blocking overlays present: " + (overlays.overlays ?? []).map((o) => o.label).join(", "),
    });
  } else {
    signals.push({ factor: "overlays", status: "green", detail: "No city development restrictions at the parcel." });
  }

  // ── Flood ──
  if (!flood || flood.error) {
    signals.push({ factor: "flood", status: "yellow", detail: "FEMA flood status couldn't be verified." });
  } else if (flood.in_floodway) {
    signals.push({ factor: "flood", status: "red", detail: `Regulatory floodway (zone ${flood.flood_zone}) — as wet as it gets on paper.` });
  } else if (flood.in_100yr_floodplain_sfha) {
    signals.push({ factor: "flood", status: "yellow", detail: `Inside the 100-year floodplain (zone ${flood.flood_zone}).` });
  } else if (flood.parcel_touches_sfha) {
    signals.push({ factor: "flood", status: "yellow", detail: `Zone ${flood.flood_zone} at the centroid, but part of the lot touches the 100-year floodplain.` });
  } else {
    signals.push({ factor: "flood", status: "green", detail: `Zone ${flood.flood_zone ?? "X"} — outside the mapped floodplains.` });
  }

  // ── Chapter 42 yield ──
  const units = ch42 && !ch42.error && typeof ch42.units === "number" ? ch42.units : null;
  if (units == null) {
    signals.push({ factor: "chapter42", status: "yellow", detail: "Chapter 42 yield couldn't be computed from the parcel geometry." });
  } else if (units === 0) {
    signals.push({ factor: "chapter42", status: "red", detail: "No compliant subdivision fits — too small or too oddly shaped even at 1,400-sf lots." });
  } else {
    signals.push({
      factor: "chapter42",
      status: "green",
      detail: `${units} townhome${units === 1 ? "" : "s"} fit at ${ch42?.densityPerAcre ?? "?"}/acre (${ch42?.bindingConstraint === "density" ? "density-bound" : "geometry-bound"}).`,
    });
  }

  // ── Pricing vs the neighborhood ──
  const subjectPerSqft = comps?.subject_land_per_sqft ?? null;
  const median = comps?.land_per_sqft?.median ?? null;
  let premiumPct: number | null = null;
  if (!comps || comps.error || !comps.comp_count) {
    signals.push({ factor: "pricing", status: "yellow", detail: "Thin comps — no similar lots nearby to anchor the land value." });
  } else if (subjectPerSqft != null && median != null && median > 0) {
    premiumPct = Math.round(((subjectPerSqft - median) / median) * 100);
    if (premiumPct > 15) {
      signals.push({ factor: "pricing", status: "yellow", detail: `Dirt carries ${premiumPct}% above the neighborhood land median ($${Math.round(subjectPerSqft)} vs $${Math.round(median)}/sqft).` });
    } else if (premiumPct < -10) {
      signals.push({ factor: "pricing", status: "green", detail: `Dirt sits ${-premiumPct}% below the neighborhood land median ($${Math.round(subjectPerSqft)} vs $${Math.round(median)}/sqft) — worth a look.` });
    } else {
      signals.push({ factor: "pricing", status: "green", detail: `Dirt is in line with the neighborhood ($${Math.round(subjectPerSqft)} vs $${Math.round(median)}/sqft median).` });
    }
  } else {
    signals.push({ factor: "pricing", status: "yellow", detail: "Couldn't compute the subject's land $/sqft." });
  }

  // ── Structure: are you paying for a building you'd scrape? ──
  if (parcel.appraisedValue && parcel.buildingValue != null) {
    const ratio = parcel.buildingValue / parcel.appraisedValue;
    if (ratio < 0.15) {
      signals.push({ factor: "structure", status: "green", detail: "Trading as dirt — improvements are under 15% of the appraisal." });
    } else if (ratio > 0.5) {
      signals.push({ factor: "structure", status: "yellow", detail: `${Math.round(ratio * 100)}% of the appraisal is improvements — you'd be paying for a structure a land play scrapes.` });
    } else {
      signals.push({ factor: "structure", status: "green", detail: `Improvements are ${Math.round(ratio * 100)}% of the appraisal.` });
    }
  }

  // ── Distress: delinquency-in-suit makes the SELLER motivated — it never
  //    downgrades the verdict, it sharpens the pitch. ──
  if (taxSale && !taxSale.error && taxSale.in_tax_sale_pipeline) {
    signals.push({
      factor: "distress",
      status: "green",
      detail:
        `Owner is in the delinquent-tax legal pipeline (${(taxSale.status ?? taxSale.sale_type ?? "suit filed").toLowerCase()}` +
        (taxSale.auction_date ? `, auction ${taxSale.auction_date}` : "") +
        ") — a motivated seller, and a clock.",
    });
  }

  const worst = signals.some((s) => s.status === "red")
    ? "RED"
    : signals.some((s) => s.status === "yellow")
      ? "YELLOW"
      : "GREEN";

  const basisPerUnit =
    units && parcel.appraisedValue ? Math.round(parcel.appraisedValue / units) : null;

  return {
    hcad_account: parcel.hcadAccount,
    address: parcel.address,
    verdict: worst,
    headline: {
      land_basis_per_buildable_unit: basisPerUnit,
      buildable_units: units,
      subject_land_per_sqft: subjectPerSqft != null ? Math.round(subjectPerSqft * 100) / 100 : null,
      comps_land_median_per_sqft: median,
      premium_vs_median_pct: premiumPct,
    },
    signals,
    note: "screening verdict from county records at appraisal basis — not underwriting, not sale prices; county deed restrictions not covered",
  };
}
