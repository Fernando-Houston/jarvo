"use client";

// Shared particle-budget layout and parcel-geometry sampling.
// The 42k particles are partitioned: halo ring + ambient voice (never morph)
// and a morphable pool that gets divided between the focus parcel and the
// constellation's memory nodes.

export const TOTAL = 42000;
export const HALO_COUNT = 3600;
export const AMBIENT_COUNT = 12000;
export const MORPH_START = HALO_COUNT + AMBIENT_COUNT; // 15600
export const MORPH_COUNT = TOTAL - MORPH_START; // 26400

export const TILT_X = -0.45; // map plane tilt toward the camera
const COS_T = Math.cos(TILT_X);
const SIN_T = Math.sin(TILT_X);

/** Tilt a map-plane point (x east, y north, z up) into world space. */
export function tiltPoint(x: number, y: number, z: number): [number, number, number] {
  return [x, y * COS_T - z * SIN_T, y * SIN_T + z * COS_T];
}

/**
 * Sample a parcel's rings into `out[start..start+count)` as tilted world
 * positions: dense boundary outline + sparse interior fill, normalized to
 * `fit` world units and centered at map-plane coords (cx, cy).
 */
export function sampleParcelInto(
  out: Float32Array,
  start: number,
  count: number,
  rings: number[][][],
  fit: number,
  cx: number,
  cy: number
): void {
  if (count <= 0) return;
  const write = (i: number, x: number, y: number, z: number) => {
    const [wx, wy, wz] = tiltPoint(x + cx, y + cy, z);
    out[(start + i) * 3] = wx;
    out[(start + i) * 3 + 1] = wy;
    out[(start + i) * 3 + 2] = wz;
  };
  if (!rings.length || !rings[0]?.length) {
    for (let i = 0; i < count; i++) write(i, 0, 0, 0);
    return;
  }

  // Project lon/lat to a local plane and normalize to `fit`.
  let sumLat = 0;
  let n = 0;
  for (const ring of rings) for (const [, lat] of ring) { sumLat += lat; n++; }
  const kx = Math.cos(((sumLat / Math.max(1, n)) * Math.PI) / 180);
  const proj = rings.map((ring) => ring.map(([lon, lat]) => [lon * kx, lat]));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const ring of proj) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const pcx = (minX + maxX) / 2;
  const pcy = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = fit / extent;
  const norm: [number, number][][] = proj.map((ring) =>
    ring.map(([x, y]) => [(x - pcx) * scale, (y - pcy) * scale] as [number, number])
  );

  const outlineCount = Math.floor(count * 0.45);
  const fillCount = count - outlineCount;

  const perims = norm.map((ring) => {
    let p = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      p += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
    }
    return p;
  });
  const totalPerim = perims.reduce((a, b) => a + b, 0) || 1;

  let w = 0;
  for (let r = 0; r < norm.length && w < outlineCount; r++) {
    const ring = norm[r];
    if (ring.length < 2) continue;
    const quota = r === norm.length - 1
      ? outlineCount - w
      : Math.max(4, Math.round((perims[r] / totalPerim) * outlineCount));
    const step = perims[r] / quota || 1;
    let acc = 0;
    let seg = 0;
    for (let q = 0; q < quota && w < outlineCount; q++) {
      const targetDist = q * step;
      while (seg < ring.length - 2) {
        const segLen = Math.hypot(ring[seg + 1][0] - ring[seg][0], ring[seg + 1][1] - ring[seg][1]);
        if (acc + segLen >= targetDist) break;
        acc += segLen;
        seg++;
      }
      const segLen = Math.hypot(ring[seg + 1][0] - ring[seg][0], ring[seg + 1][1] - ring[seg][1]) || 1;
      const t = Math.min(1, Math.max(0, (targetDist - acc) / segLen));
      const x = ring[seg][0] + (ring[seg + 1][0] - ring[seg][0]) * t;
      const y = ring[seg][1] + (ring[seg + 1][1] - ring[seg][1]) * t;
      write(w++, x + (Math.random() - 0.5) * 0.012, y + (Math.random() - 0.5) * 0.012, (Math.random() - 0.5) * 0.02);
    }
  }

  const nMinX = (minX - pcx) * scale, nMaxX = (maxX - pcx) * scale;
  const nMinY = (minY - pcy) * scale, nMaxY = (maxY - pcy) * scale;
  let placed = 0;
  let attempts = 0;
  const maxAttempts = fillCount * 40;
  while (placed < fillCount && attempts < maxAttempts && w < count) {
    attempts++;
    const x = nMinX + Math.random() * (nMaxX - nMinX);
    const y = nMinY + Math.random() * (nMaxY - nMinY);
    if (!pointInAnyRing(x, y, norm)) continue;
    write(w++, x, y, (Math.random() - 0.5) * 0.04);
    placed++;
  }
  while (w < count) {
    // Degenerate leftovers pile onto the outline start point.
    out[(start + w) * 3] = out[start * 3];
    out[(start + w) * 3 + 1] = out[start * 3 + 1];
    out[(start + w) * 3 + 2] = out[start * 3 + 2];
    w++;
  }
}

/**
 * Sample Chapter 42 building rectangles into `out[start..start+count)`,
 * mapped into the SAME normalized frame sampleParcelInto uses for these
 * rings (bbox-centered, max-extent = fit), so the units land inside the
 * drawn lot. Also writes per-particle node kinds `4 + stagger` where
 * stagger ∈ [0, 0.85] encodes assembly order (rect by rect).
 */
export function sampleRectsInto(
  out: Float32Array,
  kinds: Float32Array,
  start: number,
  count: number,
  rings: number[][][],
  fit: number,
  cx: number,
  cy: number,
  layout: {
    siteWidthFt: number;
    siteDepthFt: number;
    rects: Array<{ x: number; y: number; w: number; d: number }>;
  }
): void {
  if (count <= 0 || !layout.rects.length || !rings.length || !rings[0]?.length) return;

  // Same normalization as sampleParcelInto.
  let sumLat = 0;
  let n = 0;
  for (const ring of rings) for (const [, lat] of ring) { sumLat += lat; n++; }
  const kx = Math.cos(((sumLat / Math.max(1, n)) * Math.PI) / 180);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      const x = lon * kx;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (lat < minY) minY = lat;
      if (lat > maxY) maxY = lat;
    }
  }
  const pcx = (minX + maxX) / 2;
  const pcy = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = fit / extent;
  const nMinX = (minX - pcx) * scale, nMaxX = (maxX - pcx) * scale;
  const nMinY = (minY - pcy) * scale, nMaxY = (maxY - pcy) * scale;

  const toX = (ft: number) => nMinX + (ft / layout.siteWidthFt) * (nMaxX - nMinX);
  const toY = (ft: number) => nMinY + (ft / layout.siteDepthFt) * (nMaxY - nMinY);

  const rects = layout.rects;
  const perRect = Math.max(8, Math.floor(count / rects.length));
  let w = 0;
  for (let i = 0; i < rects.length && w < count; i++) {
    const r = rects[i];
    const stagger = 4 + (rects.length > 1 ? 0.85 * (i / (rects.length - 1)) : 0);
    const x0 = toX(r.x), x1 = toX(r.x + r.w);
    const y0 = toY(r.y), y1 = toY(r.y + r.d);
    const budget = i === rects.length - 1 ? count - w : Math.min(perRect, count - w);
    const outline = Math.floor(budget * 0.6);
    const perimW = Math.abs(x1 - x0), perimD = Math.abs(y1 - y0);
    const perim = 2 * (perimW + perimD) || 1;
    for (let q = 0; q < outline && w < count; q++) {
      // Walk the rectangle perimeter.
      let t = (q / outline) * perim;
      let x: number, y: number;
      if (t < perimW) { x = x0 + t; y = y0; }
      else if ((t -= perimW) < perimD) { x = x1; y = y0 + t; }
      else if ((t -= perimD) < perimW) { x = x1 - t; y = y1; }
      else { x = x0; y = y1 - (t - perimW); }
      const [wx, wy, wz] = tiltPoint(x + cx + (Math.random() - 0.5) * 0.008, y + cy + (Math.random() - 0.5) * 0.008, 0.035);
      out[(start + w) * 3] = wx;
      out[(start + w) * 3 + 1] = wy;
      out[(start + w) * 3 + 2] = wz;
      kinds[start + w] = stagger;
      w++;
    }
    const fill = budget - outline;
    for (let q = 0; q < fill && w < count; q++) {
      const x = x0 + Math.random() * (x1 - x0);
      const y = y0 + Math.random() * (y1 - y0);
      const [wx, wy, wz] = tiltPoint(x + cx, y + cy, 0.02 + Math.random() * 0.03);
      out[(start + w) * 3] = wx;
      out[(start + w) * 3 + 1] = wy;
      out[(start + w) * 3 + 2] = wz;
      kinds[start + w] = stagger;
      w++;
    }
  }
  // Leftovers pile on the first rect's corner.
  while (w < count) {
    out[(start + w) * 3] = out[start * 3];
    out[(start + w) * 3 + 1] = out[start * 3 + 1];
    out[(start + w) * 3 + 2] = out[start * 3 + 2];
    kinds[start + w] = 4;
    w++;
  }
}

function pointInAnyRing(x: number, y: number, rings: [number, number][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
