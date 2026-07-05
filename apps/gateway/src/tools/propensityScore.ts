// The sell-propensity score (NEXT-HORIZON §2): ONE transparent weighted sum
// shared by the digest's radius scan and the county-scale engine, so a
// parcel scores identically wherever it's seen. Every component is
// speakable ("it ranks 80: building 5% of value, absentee, held 27 years")
// — never a black box; that's the objectivity rule applied to ranking.

export const PROPENSITY_FLOOR = 40;

export type PropensityInput = {
  appraisedValue: number | null;
  buildingValue: number | null;
  lotSqft: number | null;
  absenteeOwner: boolean | null;
  /** ISO date of the last recorded transfer. */
  ownedSince: string | null;
  ownerName: string | null;
  /** In the county's delinquent-tax legal pipeline (when known). */
  inTaxPipeline?: boolean;
};

export function scorePropensity(p: PropensityInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  // Teardown-grade: a real structure carrying almost none of the value on a
  // buildable lot — land priced as a house (same screen as teardown_radar).
  const ratio =
    p.appraisedValue && p.appraisedValue > 30_000 && p.buildingValue != null && p.buildingValue > 0
      ? p.buildingValue / p.appraisedValue
      : null;
  if (ratio != null && ratio < 0.15 && (p.lotSqft ?? 0) >= 3000) {
    score += 40;
    reasons.push(`building ${Math.round(ratio * 100)}% of value`);
  }
  if (p.absenteeOwner) {
    score += 25;
    reasons.push("absentee owner");
  }
  const heldYears = p.ownedSince
    ? Math.floor((Date.now() - new Date(p.ownedSince + "T00:00:00Z").getTime()) / 31557600000)
    : null;
  if (heldYears != null && heldYears >= 15) {
    score += 15;
    reasons.push(`held ${heldYears} years`);
  }
  // Probate estates ("ESTATE OF JOHN SMITH", "SMITH JOHN ESTATE") — the
  // classic motivated-seller pipeline. "ACME REAL ESTATE LLC" must NOT hit.
  const owner = (p.ownerName ?? "").split(";")[0].trim();
  if (/\bESTATE OF\b/i.test(owner) || (/\bESTATE\s*$/i.test(owner) && !/\bREAL\s+ESTATE\s*$/i.test(owner))) {
    score += 30;
    reasons.push("estate on title");
  }
  if (p.inTaxPipeline) {
    score += 35;
    reasons.push("in the tax-suit pipeline");
  }
  return { score, reasons };
}
