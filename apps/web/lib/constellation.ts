"use client";

// The constellation: every parcel discussed in this session takes a place in
// space. The current focus crystallizes large at center (gold); previous
// parcels shrink into green memory nodes positioned at their TRUE geographic
// bearing/distance from the focus (sqrt-compressed so far-apart deals still
// fit on screen). Luminous threads connect them, labeled with real distances.

import type { ParcelVisual, CompsVisual } from "@hvi/shared";
import {
  TOTAL,
  MORPH_START,
  MORPH_COUNT,
  sampleParcelInto,
  sampleRectsInto,
  tiltPoint,
} from "./particleField";

export type Chip = {
  id: string;
  label: string;
  value: number | null;
  distanceMi: number | null;
  isFocus: boolean;
};

export type Anchor = {
  id: string;
  pos: [number, number, number];
  isFocus: boolean;
};

export type Layout = {
  targets: Float32Array;
  nodeKinds: Float32Array; // per-particle: 0 none, 1 focus, 2 memory, 3 comp
  lines: Float32Array; // pairs of xyz endpoints
  chips: Chip[];
  anchors: Anchor[];
  cameraZ: number;
};

const MAX_MEMORIES = 5;
const WORLD_R = 2.5; // how far memory nodes can sit from the focus
export const ORB_HOME: [number, number, number] = [0, 1.3, -0.5]; // the voice, hovering

let focus: ParcelVisual | null = null;
let memories: ParcelVisual[] = [];
/** Comps scatter for the CURRENT focus (dropped when focus changes). */
let comps: CompsVisual | null = null;

export function constellationSize(): number {
  return (focus ? 1 : 0) + memories.length;
}

export function clearConstellation(): void {
  focus = null;
  memories = [];
  comps = null;
}

/** Snapshot for persistence (localStorage now; CRM sessions later). */
export function serializeConstellation(): string | null {
  if (!focus) return null;
  return JSON.stringify({ v: 1, focus, memories, comps });
}

/** Restore a saved constellation; returns the rebuilt layout (or null). */
export function restoreConstellation(json: string): { layout: Layout; focus: ParcelVisual } | null {
  try {
    const data = JSON.parse(json) as {
      v: number;
      focus: ParcelVisual;
      memories: ParcelVisual[];
      comps?: CompsVisual | null;
    };
    if (data.v !== 1 || !data.focus?.rings?.length) return null;
    focus = data.focus;
    memories = (data.memories ?? []).filter((m) => m?.rings?.length).slice(0, MAX_MEMORIES);
    comps = data.comps?.hcadAccount === data.focus.hcadAccount ? data.comps : null;
    return { layout: layout(), focus };
  } catch {
    return null;
  }
}

/** Bring an already-known parcel (focus or memory) back into focus — used
 *  by node taps so the map answers instantly, no round-trip needed. */
export function focusParcelById(id: string): { layout: Layout; visual: ParcelVisual } | null {
  const target = focus?.hcadAccount === id ? focus : memories.find((m) => m.hcadAccount === id);
  if (!target) return null;
  return { layout: addParcel(target), visual: target };
}

/** Attach a comps scatter to the current focus; returns the new layout, or
 *  null when the comps refer to a parcel that is no longer in focus. */
export function setComps(v: CompsVisual): Layout | null {
  if (!focus || focus.hcadAccount !== v.hcadAccount) return null;
  comps = v.comps.length ? v : null;
  return layout();
}

function metersBetween(a: ParcelVisual, b: ParcelVisual): { dx: number; dy: number; dist: number } {
  const kx = Math.cos((a.centroid.lat * Math.PI) / 180);
  const dx = (b.centroid.lon - a.centroid.lon) * 111320 * kx; // east
  const dy = (b.centroid.lat - a.centroid.lat) * 110574; // north
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

function shortLabel(v: ParcelVisual): string {
  return v.address?.split(",")[0] ?? `HCAD ${v.hcadAccount}`;
}

/** Register a newly-discussed parcel and lay out the whole constellation. */
export function addParcel(v: ParcelVisual): Layout {
  if (focus && focus.hcadAccount !== v.hcadAccount) {
    memories = [focus, ...memories.filter((m) => m.hcadAccount !== v.hcadAccount)].slice(0, MAX_MEMORIES);
    comps = null; // comps belonged to the old focus
  } else if (focus && focus.hcadAccount === v.hcadAccount) {
    memories = memories.filter((m) => m.hcadAccount !== v.hcadAccount);
  }
  focus = v;
  return layout();
}

function layout(): Layout {
  const targets = new Float32Array(TOTAL * 3);
  const nodeKinds = new Float32Array(TOTAL);
  const chips: Chip[] = [];
  const anchors: Anchor[] = [];
  const lineVerts: number[] = [];

  const f = focus!;
  const hasMemories = memories.length > 0;

  // ── Positions: focus at origin, memories at true bearing, sqrt distance ──
  const placed: { v: ParcelVisual; x: number; y: number; distMi: number }[] = [];
  if (hasMemories) {
    const deltas = memories.map((m) => metersBetween(f, m));
    const maxDist = Math.max(...deltas.map((d) => d.dist), 1);
    memories.forEach((m, i) => {
      const { dx, dy, dist } = deltas[i];
      const r = Math.max(1.15, Math.sqrt(dist / maxDist) * WORLD_R);
      const len = Math.max(dist, 1);
      placed.push({
        v: m,
        x: (dx / len) * r,
        y: (dy / len) * r,
        distMi: dist / 1609.34,
      });
    });
    // Nudge apart any nodes that landed on top of each other.
    for (let iter = 0; iter < 8; iter++) {
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i], b = placed[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 0.75) {
            const push = (0.75 - d) / 2 + 0.02;
            const nx = d > 1e-6 ? (a.x - b.x) / d : 1;
            const ny = d > 1e-6 ? (a.y - b.y) / d : 0;
            a.x += nx * push; a.y += ny * push;
            b.x -= nx * push; b.y -= ny * push;
          }
        }
      }
    }
  }

  // ── Particle budget across nodes ──
  const compList = comps?.comps ?? [];
  const hasComps = compList.length > 0;
  const focusCount =
    hasMemories || hasComps ? Math.floor(MORPH_COUNT * (hasMemories && hasComps ? 0.45 : 0.55)) : MORPH_COUNT;
  const pool = MORPH_COUNT - focusCount;
  const compBudget = hasComps ? Math.floor(pool * (hasMemories ? 0.4 : 1)) : 0;
  const perComp = hasComps ? Math.max(50, Math.floor(compBudget / compList.length)) : 0;
  const perMemory = hasMemories ? Math.floor((pool - compBudget) / memories.length) : 0;

  const focusFit = hasMemories ? 1.5 : 2.1;
  const ch42 = f.ch42?.rects?.length ? f.ch42 : null;
  if (ch42) {
    // Site-plan mode: the lot stays as a gold frame; most particles become
    // the Chapter 42 building rectangles assembling one by one.
    const frameCount = Math.floor(focusCount * 0.35);
    sampleParcelInto(targets, MORPH_START, frameCount, f.rings, focusFit, 0, -0.1);
    nodeKinds.fill(1, MORPH_START, MORPH_START + frameCount);
    sampleRectsInto(
      targets,
      nodeKinds,
      MORPH_START + frameCount,
      focusCount - frameCount,
      f.rings,
      focusFit,
      0,
      -0.1,
      ch42
    );
  } else {
    sampleParcelInto(targets, MORPH_START, focusCount, f.rings, focusFit, 0, -0.1);
    nodeKinds.fill(1, MORPH_START, MORPH_START + focusCount);
  }

  const focusAnchor = tiltPoint(0, -0.1, 0);
  anchors.push({ id: f.hcadAccount, pos: focusAnchor, isFocus: true });
  chips.push({ id: f.hcadAccount, label: shortLabel(f), value: f.appraisedValue, distanceMi: null, isFocus: true });

  let cursor = MORPH_START + focusCount;
  let maxR = 1.2;
  for (const p of placed) {
    sampleParcelInto(targets, cursor, perMemory, p.v.rings, 0.5, p.x, p.y - 0.1);
    nodeKinds.fill(2, cursor, cursor + perMemory);
    cursor += perMemory;

    const anchor = tiltPoint(p.x, p.y - 0.1, 0);
    anchors.push({ id: p.v.hcadAccount, pos: anchor, isFocus: false });
    chips.push({
      id: p.v.hcadAccount,
      label: shortLabel(p.v),
      value: p.v.appraisedValue,
      distanceMi: p.distMi,
      isFocus: false,
    });
    lineVerts.push(...focusAnchor, ...anchor);
    maxR = Math.max(maxR, Math.hypot(p.x, p.y));
  }

  // ── Comps: dim satellites hugging the focus at true bearings ──
  if (hasComps) {
    const deltas = compList.map((c) =>
      metersBetween(f, { centroid: { lat: c.lat, lon: c.lon } } as ParcelVisual)
    );
    const maxDist = Math.max(...deltas.map((d) => d.dist), 1);
    compList.forEach((c, i) => {
      if (cursor + perComp > MORPH_START + MORPH_COUNT) return; // budget guard
      const { dx, dy, dist } = deltas[i];
      const r = 0.55 + Math.sqrt(dist / maxDist) * 1.1; // inside the memory shell
      const len = Math.max(dist, 1);
      const cx = (dx / len) * r;
      const cy = (dy / len) * r - 0.1;
      // Small gaussian-ish blob per comp (no rings on the wire — points only).
      for (let k = 0; k < perComp; k++) {
        const ox = (Math.random() + Math.random() - 1) * 0.05;
        const oy = (Math.random() + Math.random() - 1) * 0.05;
        const pt = tiltPoint(cx + ox, cy + oy, 0);
        targets[cursor * 3] = pt[0];
        targets[cursor * 3 + 1] = pt[1];
        targets[cursor * 3 + 2] = pt[2] + (Math.random() - 0.5) * 0.02;
        nodeKinds[cursor] = 3;
        cursor++;
      }
      maxR = Math.max(maxR, r);
    });
    // One floating summary label for the whole scatter.
    const anchor = tiltPoint(-1.15, 0.75, 0);
    anchors.push({ id: "comps-summary", pos: anchor, isFocus: false });
    chips.push({
      id: "comps-summary",
      label: `${compList.length} comps${comps!.medianPerSqft != null ? ` · ~$${Math.round(comps!.medianPerSqft)}/sqft land` : ""}`,
      value: null,
      distanceMi: null,
      isFocus: false,
    });
  }
  // Park unused morph particles on the focus (budget rounding leftovers).
  for (let i = cursor; i < TOTAL; i++) {
    targets[i * 3] = focusAnchor[0];
    targets[i * 3 + 1] = focusAnchor[1];
    targets[i * 3 + 2] = focusAnchor[2];
    nodeKinds[i] = 1;
  }

  // Tether from the hovering voice down to the focus parcel.
  lineVerts.push(...ORB_HOME, ...focusAnchor);

  return {
    targets,
    nodeKinds,
    lines: new Float32Array(lineVerts),
    chips,
    anchors,
    cameraZ: Math.min(6.6, 4.2 + Math.max(0, maxR - 1.3) * 1.15),
  };
}
