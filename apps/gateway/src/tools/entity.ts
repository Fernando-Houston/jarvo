// The LLC graph + assemblage detector (INTELLIGENCE-ROADMAP §2.2, §2.3).
//
// Owner names are noisy — operators run an LLC per deal — but tax mail
// clusters them: parcels sharing a mailbox share a decision-maker. From
// that follow two plays:
//   IN PROGRESS  — adjacent parcels, one mailbox: someone is assembling.
//                  Get there first, or sell to them.
//   OPPORTUNITY  — adjacent parcels, DIFFERENT tired owners (absentee or
//                  15+ year holds), whose combined lot clears a Chapter 42
//                  unit threshold the separate lots don't. A deal that
//                  doesn't exist without this tool.

import { chapter42Feasibility } from "./chapter42";
import type { Parcel } from "./hcad";

/** Mailbox identity: number + name words, suffixes dropped, zip5 appended.
 *  "1216 Yale St / 77008" and "1216 YALE STREET / 77008-1234" collide. */
export function mailKey(p: Parcel): string | null {
  if (!p.mailingAddress) return null;
  const first = p.mailingAddress.split(",")[0] ?? "";
  const words = first
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !MAIL_SUFFIXES.has(w));
  if (!words.length) return null;
  const zip = p.mailingAddress.match(/\b(\d{5})(-\d{4})?\s*$/)?.[1] ?? "";
  return words.join(" ") + "|" + zip;
}

const MAIL_SUFFIXES = new Set([
  "ST", "STREET", "DR", "DRIVE", "RD", "ROAD", "LN", "LANE", "AVE", "AVENUE",
  "BLVD", "BOULEVARD", "CT", "COURT", "WAY", "CIR", "CIRCLE", "PL", "PLACE",
  "TRL", "TRAIL", "PKWY", "PARKWAY", "HWY", "HIGHWAY", "STE", "SUITE", "APT", "UNIT",
]);

/** Do two parcel footprints (approximately) touch? Vertex-to-vertex proximity
 *  is a good-enough stand-in for shared-boundary at HCAD ring density. */
export function parcelsAdjacent(a: Parcel, b: Parcel, toleranceMeters = 6): boolean {
  // Cheap gate: centroids of adjacent residential lots sit well inside 120m.
  const kx = 111320 * Math.cos((a.lat * Math.PI) / 180);
  if (Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * 111320) > 120) return false;
  const tol2 = toleranceMeters * toleranceMeters;
  for (const ringA of a.rings) {
    for (let i = 0; i < ringA.length; i += 1) {
      const [ax, ay] = ringA[i];
      for (const ringB of b.rings) {
        for (let j = 0; j < ringB.length; j += 1) {
          const dx = (ax - ringB[j][0]) * kx;
          const dy = (ay - ringB[j][1]) * 111320;
          if (dx * dx + dy * dy < tol2) return true;
        }
      }
    }
  }
  return false;
}

const heldYears = (p: Parcel): number | null =>
  p.ownedSince ? (Date.now() - new Date(p.ownedSince + "T00:00:00Z").getTime()) / 31557600000 : null;

/** Owners who never sell no matter how tired the parcel looks — government,
 *  schools, churches, utilities. Not acquisition targets; drop from plays. */
const INSTITUTIONAL =
  /\b(CITY OF|COUNTY|STATE OF|UNITED STATES|USA\b|HOUSTON ISD|SCHOOL|CHURCH|IGLESIA|TEMPLE|MOSQUE|BAPTIST|METHODIST|CATHOLIC|DIOCESE|AUTHORITY|METRO\b|UTILITY|MUD \d|IMPROVEMENT DIST|MANAGEMENT DIST|HOUSING)\b/i;

export const institutionalOwner = (p: Parcel): boolean => INSTITUTIONAL.test(p.ownerName ?? "");

/** "Tired" = the profile that answers the phone: absentee mail, or a hold
 *  old enough that the basis is ancient (or no recorded transfer at all). */
export function tiredOwner(p: Parcel): { tired: boolean; why: string[] } {
  const why: string[] = [];
  if (p.absenteeOwner) why.push("absentee");
  const years = heldYears(p);
  if (years == null) why.push("no transfer on record");
  else if (years >= 15) why.push(`held ${Math.floor(years)} years`);
  return { tired: why.length > 0, why };
}

export type MailCluster = {
  mailKey: string;
  mailingAddress: string | null;
  ownerNames: string[];
  parcels: Parcel[];
  totalAppraised: number;
  hasAdjacentPair: boolean;
};

export function clusterByMail(parcels: Parcel[]): MailCluster[] {
  const groups = new Map<string, Parcel[]>();
  for (const p of parcels) {
    const key = mailKey(p);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const clusters: MailCluster[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    let hasAdjacentPair = false;
    outer: for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (parcelsAdjacent(group[i], group[j])) {
          hasAdjacentPair = true;
          break outer;
        }
      }
    }
    clusters.push({
      mailKey: key,
      mailingAddress: group[0].mailingAddress,
      ownerNames: [...new Set(group.map((p) => p.ownerName ?? "unknown"))],
      parcels: group,
      totalAppraised: group.reduce((n, p) => n + (p.appraisedValue ?? 0), 0),
      hasAdjacentPair,
    });
  }
  return clusters.sort((a, b) => b.parcels.length - a.parcels.length);
}

export type AssemblageOpportunity = {
  parcels: [Parcel, Parcel];
  combinedLotSqft: number;
  combinedUnits: number;
  separateUnits: number;
  why: string[];
};

/** Adjacent pairs of differently-owned tired parcels where 1+1 > 2 under
 *  Chapter 42 (combined units beat the sum of separate yields). */
export function findOpportunities(candidates: Parcel[], maxReport = 3): AssemblageOpportunity[] {
  const out: AssemblageOpportunity[] = [];
  const seenPairs = new Set<string>();
  const withLots = candidates.filter((p) => (p.lotSqft ?? 0) > 0 && !institutionalOwner(p));
  for (let i = 0; i < withLots.length; i++) {
    for (let j = i + 1; j < withLots.length; j++) {
      const a = withLots[i];
      const b = withLots[j];
      const keyA = mailKey(a);
      const keyB = mailKey(b);
      if (keyA && keyB && keyA === keyB) continue; // same operator — that's "in progress"
      const ta = tiredOwner(a);
      const tb = tiredOwner(b);
      if (!ta.tired || !tb.tired) continue;
      if (!parcelsAdjacent(a, b)) continue;
      const pairKey = [a.hcadAccount, b.hcadAccount].sort().join("|");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const unitsOf = (sqft: number) => {
        try {
          return chapter42Feasibility({ lotSqft: sqft }).units;
        } catch {
          return 0;
        }
      };
      const separate = unitsOf(a.lotSqft!) + unitsOf(b.lotSqft!);
      const combined = unitsOf(a.lotSqft! + b.lotSqft!);
      // A +1 on an already-large site is rounding noise; the play is small
      // lots that jump a threshold together (the "6 units where separately
      // they don't" case) or a genuine multi-unit gain.
      const synergy = combined - separate;
      if (synergy < 2 && !(synergy >= 1 && combined <= 12)) continue;
      out.push({
        parcels: [a, b],
        combinedLotSqft: Math.round(a.lotSqft! + b.lotSqft!),
        combinedUnits: combined,
        separateUnits: separate,
        why: [...new Set([...ta.why.map((w) => `${a.address?.split(",")[0]}: ${w}`), ...tb.why.map((w) => `${b.address?.split(",")[0]}: ${w}`)])],
      });
    }
  }
  return out.sort((x, y) => y.combinedUnits - y.separateUnits - (x.combinedUnits - x.separateUnits) || y.combinedUnits - x.combinedUnits).slice(0, maxReport);
}
