// Houston Chapter 42 feasibility — how many single-family (townhome) units
// fit on a lot under the city's subdivision rules. Ported from the proven
// planner in 03-AI-AGENTS/CHAPTER 42 - Abe Update/chapter 42 ai siteplan/
// script.py, trimmed to the single-family path the voice pipeline needs and
// extended to return building rectangles for the orb's site-plan morph.

export const CH42 = {
  MIN_LOT_SIZE_URBAN: 3500,
  MIN_LOT_SIZE_SUBURBAN: 5000,
  MIN_LOT_SIZE_REDUCED: 1400,
  MAX_DENSITY_SINGLE_FAMILY: 27, // units/acre
  SETBACKS: {
    // [front, side] in feet, by street type
    major_thoroughfare: [25, 10],
    collector: [10, 10],
    local: [10, 10],
    shared_driveway: [3, 3],
  } as Record<string, [number, number]>,
  PARKING_SINGLE_FAMILY: 2,
  MIN_AVG_LOT_WIDTH: 18,
  MAX_LOT_COVERAGE: 0.6,
  MIN_PERMEABLE_AREA: 150,
} as const;

export type StreetType = keyof typeof CH42.SETBACKS;

export type Ch42Rect = { x: number; y: number; w: number; d: number }; // feet, origin = site SW corner

export type Ch42Result = {
  units: number;
  targetLotSqft: number;
  avgLotSqft: number;
  densityPerAcre: number;
  parkingSpaces: number;
  /** Compensating open space owed when lots are below the standard minimum. */
  openSpaceSqftPerLot: number;
  siteWidthFt: number;
  siteDepthFt: number;
  /** Building footprints for the site-plan morph. */
  rects: Ch42Rect[];
  compliance: {
    density: boolean;
    minLotSize: boolean;
    lotCoverage: boolean;
    minAvgWidth: boolean;
  };
  /** What limited the count: "density" (27/acre cap) or "geometry" (fit). */
  bindingConstraint: "density" | "geometry";
  notes: string[];
};

/** Compensating open space per lot (Chapter 42 tables, simplified). */
function openSpacePerLot(avgLotSize: number, urban: boolean): number {
  const min = urban ? CH42.MIN_LOT_SIZE_URBAN : CH42.MIN_LOT_SIZE_SUBURBAN;
  if (avgLotSize >= min) return 0;
  if (urban) {
    if (avgLotSize >= 2500) return 360;
    if (avgLotSize >= 2000) return 480;
    if (avgLotSize >= 1400) return 720;
  } else {
    if (avgLotSize >= 3500) return 560;
    if (avgLotSize >= 2500) return 920;
    if (avgLotSize >= 1400) return 1440;
  }
  return 0;
}

function planAtLotSize(
  siteSqft: number,
  siteW: number,
  siteD: number,
  targetLot: number,
  urban: boolean,
  street: StreetType
): Ch42Result {
  const acres = siteSqft / 43560;
  const maxUnits = Math.floor(acres * CH42.MAX_DENSITY_SINGLE_FAMILY);
  const notes: string[] = [];

  // Grid search: the ported width-driven heuristic PLUS depth-driven splits
  // (rows share the site depth), keeping whichever fits the most lots.
  let lotWidth = Math.max(CH42.MIN_AVG_LOT_WIDTH, Math.min(50, targetLot / 100));
  let lotDepth = targetLot / lotWidth;
  let cols = Math.floor(siteW / lotWidth);
  let rows = Math.floor(siteD / lotDepth);
  for (let rr = 1; rr <= 4; rr++) {
    const d = siteD / rr;
    const w = Math.max(CH42.MIN_AVG_LOT_WIDTH, targetLot / d);
    if (w > 60) continue; // absurdly wide lots — not a townhome layout
    const cc = Math.floor(siteW / w);
    if (cc * rr > cols * rows) {
      cols = cc;
      rows = rr;
      lotWidth = w;
      lotDepth = d;
    }
  }
  if (cols * rows === 0) {
    return {
      units: 0, targetLotSqft: targetLot, avgLotSqft: 0, densityPerAcre: 0,
      parkingSpaces: 0, openSpaceSqftPerLot: 0,
      siteWidthFt: Math.round(siteW), siteDepthFt: Math.round(siteD),
      rects: [],
      compliance: { density: true, minLotSize: false, lotCoverage: true, minAvgWidth: false },
      bindingConstraint: "geometry",
      notes: ["site cannot fit a compliant lot at this target size"],
    };
  }

  // Streets/infrastructure eat ~20% on larger tracts; small infill sites
  // serve units off a shared driveway instead.
  const infrastructure = acres >= 1 ? 0.8 : 1.0;
  if (acres < 1) notes.push("under an acre: assumes shared-driveway access, no internal street");
  let units = Math.min(Math.floor(cols * rows * infrastructure), maxUnits);
  const bindingConstraint: "density" | "geometry" =
    Math.floor(cols * rows * infrastructure) > maxUnits ? "density" : "geometry";
  units = Math.max(0, units);

  // Building footprints: ATTACHED townhome rows — interior side setbacks are
  // zero (shared walls); the perimeter side setback applies to the row strip.
  // 60% coverage caps each unit's depth. A small visual gap keeps the units
  // legible on the site-plan morph.
  const [front, side] = CH42.SETBACKS[street] ?? CH42.SETBACKS.local;
  const ySpacing = rows > 0 ? siteD / rows : siteD;
  const stripW = Math.max(0, siteW - 2 * side);
  const rects: Ch42Rect[] = [];
  let placed = 0;
  for (let r = 0; r < rows && placed < units; r++) {
    const inRow = Math.min(cols, units - placed);
    const unitW = inRow > 0 ? stripW / inRow : 0;
    const buildable = Math.max(0, ySpacing - front - side);
    const maxFootprint = lotWidth * lotDepth * CH42.MAX_LOT_COVERAGE;
    const bd = Math.min(buildable, unitW > 1 ? maxFootprint / unitW : 0);
    for (let c = 0; c < inRow; c++) {
      const gap = Math.min(1.5, unitW * 0.08);
      if (unitW - gap > 1 && bd > 1) {
        rects.push({
          x: Math.round((side + c * unitW + gap / 2) * 10) / 10,
          y: Math.round((r * ySpacing + front) * 10) / 10,
          w: Math.round((unitW - gap) * 10) / 10,
          d: Math.round(bd * 10) / 10,
        });
      }
      placed++;
    }
  }
  notes.push("attached townhomes: zero interior side setbacks, shared walls");

  const avgLot = lotWidth * lotDepth;
  const coverage = rects.length
    ? (rects[0].w * rects[0].d) / avgLot
    : 0;
  return {
    units,
    targetLotSqft: targetLot,
    avgLotSqft: Math.round(avgLot),
    densityPerAcre: acres > 0 ? Math.round((units / acres) * 10) / 10 : 0,
    parkingSpaces: units * CH42.PARKING_SINGLE_FAMILY,
    openSpaceSqftPerLot: openSpacePerLot(avgLot, urban),
    siteWidthFt: Math.round(siteW),
    siteDepthFt: Math.round(siteD),
    rects,
    compliance: {
      density: acres > 0 ? units / acres <= CH42.MAX_DENSITY_SINGLE_FAMILY + 1e-9 : true,
      minLotSize: avgLot >= CH42.MIN_LOT_SIZE_REDUCED,
      lotCoverage: coverage <= CH42.MAX_LOT_COVERAGE + 1e-9,
      minAvgWidth: lotWidth >= CH42.MIN_AVG_LOT_WIDTH,
    },
    bindingConstraint,
    notes,
  };
}

/**
 * Best single-family plan for a site: tries the standard Chapter 42 lot-size
 * ladder and keeps the one that yields the most units (ties → bigger lots,
 * which are easier to permit and sell).
 */
export function chapter42Feasibility(input: {
  lotSqft: number;
  siteWidthFt?: number;
  siteDepthFt?: number;
  urban?: boolean;
  streetType?: StreetType;
  targetLotSqft?: number;
}): Ch42Result {
  const urban = input.urban ?? true;
  const street: StreetType = input.streetType ?? "local";
  const siteW = input.siteWidthFt && input.siteWidthFt > 0 ? input.siteWidthFt : Math.sqrt(input.lotSqft);
  const siteD = input.siteDepthFt && input.siteDepthFt > 0 ? input.siteDepthFt : input.lotSqft / siteW;

  const ladder = input.targetLotSqft
    ? [Math.max(CH42.MIN_LOT_SIZE_REDUCED, input.targetLotSqft)]
    : [1400, 1750, 2000, 2500, 3500, 5000];
  let best: Ch42Result | null = null;
  for (const target of ladder) {
    const plan = planAtLotSize(input.lotSqft, siteW, siteD, target, urban, street);
    if (!best || plan.units > best.units || (plan.units === best.units && plan.avgLotSqft > best.avgLotSqft)) {
      best = plan;
    }
  }
  return best!;
}
