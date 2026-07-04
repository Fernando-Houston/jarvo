"use client";

import { create } from "zustand";
import type { Capabilities, OrbState, ParcelVisual } from "@hvi/shared";
import type { Chip } from "./constellation";

export type Turn = { user: string; assistant: string };

const TURNS_KEY = "hvi-transcript-v1";

function loadTurns(): Turn[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(TURNS_KEY);
    const turns = raw ? (JSON.parse(raw) as Turn[]) : [];
    return Array.isArray(turns) ? turns.slice(-50) : [];
  } catch {
    return [];
  }
}

function saveTurns(turns: Turn[]) {
  try {
    sessionStorage.setItem(TURNS_KEY, JSON.stringify(turns.slice(-50)));
  } catch {
    /* storage full/blocked — rail still works in-memory */
  }
}

type HviStore = {
  connected: boolean;
  caps: Capabilities | null;
  orbState: OrbState;
  /** Live (partial) user transcript while listening. */
  transcript: string;
  /** Accumulated assistant text for the current turn (captions). */
  caption: string;
  visual: ParcelVisual | null;
  /** Constellation node chips (focus + memory parcels). */
  chips: Chip[];
  micArmed: boolean;
  /** True once the user grabs the camera (drag/zoom); shows "recenter". */
  freeCam: boolean;
  error: string | null;
  /** Completed + in-progress turns for the transcript rail. */
  turns: Turn[];
  showTranscript: boolean;
  /** What HVI is doing right now ("checking FEMA flood maps…"), or null. */
  activity: string | null;
  /** Overnight digest headline, shown once per day until dismissed. */
  digest: { headline: string; generatedAt: string } | null;

  setConnected: (v: boolean) => void;
  setCaps: (c: Capabilities) => void;
  setOrbState: (s: OrbState) => void;
  setTranscript: (t: string) => void;
  appendCaption: (t: string) => void;
  resetCaption: () => void;
  setVisual: (v: ParcelVisual | null) => void;
  setChips: (c: Chip[]) => void;
  setMicArmed: (v: boolean) => void;
  setFreeCam: (v: boolean) => void;
  setError: (e: string | null) => void;
  /** A user utterance opens a new turn in the rail. */
  beginTurn: (user: string) => void;
  /** Streamed assistant text appends to the newest turn. */
  appendTurnText: (t: string) => void;
  toggleTranscript: () => void;
  setActivity: (a: string | null) => void;
  setDigest: (d: { headline: string; generatedAt: string } | null) => void;
  dismissDigest: () => void;
};

export const useHvi = create<HviStore>((set) => ({
  connected: false,
  caps: null,
  orbState: "idle",
  transcript: "",
  caption: "",
  visual: null,
  chips: [],
  micArmed: false,
  freeCam: false,
  error: null,
  // Starts empty even when sessionStorage has turns: the static export's
  // prerendered HTML has no turns, and hydrating with them mismatches
  // (React #418). hydrateTurns() loads them post-mount instead.
  turns: [],
  showTranscript: false,
  activity: null,
  digest: null,

  setConnected: (connected) => set({ connected }),
  setCaps: (caps) => set({ caps }),
  setOrbState: (orbState) => set({ orbState }),
  setTranscript: (transcript) => set({ transcript }),
  appendCaption: (t) => set((s) => ({ caption: s.caption + t })),
  resetCaption: () => set({ caption: "" }),
  setVisual: (visual) => set({ visual }),
  setChips: (chips) => set({ chips }),
  setMicArmed: (micArmed) => set({ micArmed }),
  setFreeCam: (freeCam) => set({ freeCam }),
  setError: (error) => set({ error }),
  beginTurn: (user) =>
    set((s) => {
      const turns = [...s.turns, { user, assistant: "" }].slice(-50);
      saveTurns(turns);
      return { turns };
    }),
  appendTurnText: (t) =>
    set((s) => {
      if (!s.turns.length) return {};
      const turns = s.turns.slice();
      const last = turns[turns.length - 1];
      turns[turns.length - 1] = { ...last, assistant: last.assistant + t };
      saveTurns(turns);
      return { turns };
    }),
  toggleTranscript: () => set((s) => ({ showTranscript: !s.showTranscript })),
  setActivity: (activity) => set({ activity }),
  setDigest: (digest) => set({ digest }),
  dismissDigest: () =>
    set((s) => {
      // Remember per digest-generation so it stays gone for the day.
      try {
        if (s.digest) localStorage.setItem("hvi-digest-seen", s.digest.generatedAt);
      } catch {
        /* private mode — dismissal lasts the tab's life via state */
      }
      return { digest: null };
    }),
}));

/** Load persisted turns after hydration (call from a useEffect). */
export function hydrateTurns() {
  const saved = loadTurns();
  if (saved.length) useHvi.setState((s) => (s.turns.length ? s : { ...s, turns: saved }));
}
