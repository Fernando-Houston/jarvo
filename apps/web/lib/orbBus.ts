"use client";

// High-frequency channel between the audio/voice layer and the WebGL orb.
// Deliberately NOT react state: the orb reads this every frame at 60fps.

import type { OrbState } from "@hvi/shared";
import type { Anchor } from "./constellation";

export type OrbBus = {
  mode: OrbState;
  /** 0..1 audio level (mic while listening, TTS playback while speaking). */
  level: number;
  /** Morph target particle positions (xyz triplets), or null for the base orb. */
  targets: Float32Array | null;
  /** Per-particle node kind (0 none, 1 focus, 2 memory), paired with targets. */
  nodeKinds: Float32Array | null;
  /** Bumped whenever targets/nodeKinds change so the orb re-uploads attributes. */
  targetsVersion: number;
  /** Constellation connecting lines (xyz endpoint pairs). */
  lines: Float32Array | null;
  linesVersion: number;
  /** Where the camera should sit (eased toward) — desktop-tuned baseline. */
  cameraZ: number;
  /** Constellation world-space spread; the orb fits this to the LIVE aspect
   *  (portrait phones pull the camera back much further than desktop). */
  fitRadius: number;
  /** 3D anchors for floating labels. */
  anchors: Anchor[];
  /** Screen-space label positions, written by the orb each frame. */
  screens: Map<string, { x: number; y: number; visible: boolean }>;
  /** Free-flight camera state (drag to orbit, wheel to zoom). */
  cam: { yaw: number; pitch: number; radius: number; user: boolean };
  /** Set true (by the HUD) to snap back to the cinematic auto-camera. */
  camResetRequested: boolean;
  /** 1 when the focus parcel sits in a FEMA flood zone (SFHA) — the morphed
   *  particles tint blue. The orb eases toward this each frame. */
  flood: number;
  /** Device-tilt parallax (-1..1), fed by deviceorientation on phones. */
  gyroX: number;
  gyroY: number;
};

export const orbBus: OrbBus = {
  mode: "idle",
  level: 0,
  targets: null,
  nodeKinds: null,
  targetsVersion: 0,
  lines: null,
  linesVersion: 0,
  cameraZ: 4.2,
  fitRadius: 0,
  anchors: [],
  screens: new Map(),
  cam: { yaw: 0, pitch: 0, radius: 4.2, user: false },
  camResetRequested: false,
  flood: 0,
  gyroX: 0,
  gyroY: 0,
};

export function setOrbFlood(on: boolean) {
  orbBus.flood = on ? 1 : 0;
}

// Debug handle for DevTools ("__hviOrbBus.targets?.length" etc.).
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__hviOrbBus = orbBus;
}

export function setOrbMode(mode: OrbState) {
  orbBus.mode = mode;
}

export function setOrbLevel(level: number) {
  orbBus.level = Math.max(0, Math.min(1, level));
}

export function setOrbTargets(targets: Float32Array | null, nodeKinds: Float32Array | null = null) {
  orbBus.targets = targets;
  orbBus.nodeKinds = nodeKinds;
  orbBus.targetsVersion++;
}

export function setOrbLines(lines: Float32Array | null) {
  orbBus.lines = lines;
  orbBus.linesVersion++;
}
