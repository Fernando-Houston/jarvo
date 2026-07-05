// HVI wire protocol — one WebSocket between browser and gateway.
// JSON text frames carry control/events; binary frames carry audio
// (upstream: PCM16 mic chunks; downstream: encoded TTS audio, each
// preceded by an `audio_chunk` JSON frame describing it).

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type Capabilities = {
  /** Where speech-to-text runs. "client" = browser Web Speech API. */
  stt: "deepgram" | "client";
  /** Where text-to-speech runs. "client" = browser speechSynthesis. */
  tts: "elevenlabs" | "client";
  /** Which brain answers. "rules" = keyless fallback (address → HCAD → template). */
  brain: "claude" | "rules";
  /** Whether the CRM (Land Lead Hub Supabase) is reachable. */
  crm: boolean;
};

// ── Visuals: what the orb morphs into ─────────────────────────────────────
export type ParcelVisual = {
  kind: "parcel";
  hcadAccount: string;
  address: string | null;
  ownerName: string | null;
  appraisedValue: number | null;
  lotSqft: number | null;
  /** ArcGIS-style rings of [lon, lat]. May include several parcels' rings. */
  rings: number[][][];
  centroid: { lat: number; lon: number };
  /** e.g. "34-unit condo building" when an address matched many stacked parcels */
  note?: string;
  /** FEMA flood zone at the centroid (e.g. "AE", "X"), set after flood_check. */
  floodZone?: string | null;
  /** In a Special Flood Hazard Area (100-yr floodplain) — drives the blue morph tint. */
  sfha?: boolean;
  /** Speakable flood summary, e.g. "Zone AE — 1% annual (100-yr SFHA)". */
  floodLabel?: string;
  /** CRM pipeline status (e.g. "hot_lead") when this parcel is already a lead. */
  leadStatus?: string | null;
  /** Kill-chain screening result, set after the verdict tool runs. */
  verdict?: "GREEN" | "YELLOW" | "RED" | null;
  /** Delinquent-tax legal pipeline state, set after a tax-sale check/radar. */
  taxSale?: { status: string; saleDate: string | null } | null;
  /** Owner contact info from the CRM's enrichment (leads only) — the card's
   *  "reach the owner" section. Bad numbers ride along marked, never hidden. */
  contacts?: {
    phones: Array<{
      number: string;
      status: string | null;
      badReason: string | null;
      contactName: string | null;
      source: string | null;
      confidence: number | null;
      /** Do-Not-Call registry flag — renders locked, never dialable. */
      dnc?: boolean;
    }>;
    primaryPhone: string | null;
    contactInfo: string | null;
    needsReview: boolean;
  } | null;
  /** City code-enforcement history (2014–Aug 2018 public window), set after
   *  code_violations runs — history, not current status. */
  violations?: { count: number; newest: string | null; topCategory: string | null } | null;
  /** Chapter 42 feasibility, set after chapter42_feasibility runs: the orb
   *  assembles the building rectangles onto the lot. */
  ch42?: {
    units: number;
    avgLotSqft: number;
    densityPerAcre: number;
    parkingSpaces: number;
    openSpaceSqftPerLot: number;
    siteWidthFt: number;
    siteDepthFt: number;
    /** Building footprints in feet, origin at the site's SW corner. */
    rects: Array<{ x: number; y: number; w: number; d: number }>;
  };
};

/** A comps scatter around the focus parcel: similar lots nearby, each a dim
 *  point in the constellation at its true bearing, carrying land $/sqft. */
export type CompsVisual = {
  kind: "comps";
  /** Subject parcel these comps belong to (must match the current focus). */
  hcadAccount: string;
  comps: Array<{
    lat: number;
    lon: number;
    /** Land value per lot sqft (falls back to appraised/lot when land value missing). */
    valuePerSqft: number | null;
  }>;
  medianPerSqft: number | null;
};

/** The ground materializing around the focus: named bayous and freeways as
 *  faint particle streams, so "where is this?" has a visual answer. */
export type GroundVisual = {
  kind: "ground";
  /** Focus parcel these features surround (must match current focus). */
  hcadAccount: string;
  features: Array<{
    kind: "water" | "road";
    name: string;
    /** [lon, lat] vertices, decimated server-side. */
    path: [number, number][];
  }>;
};

/** A drafted document (owner letter, call sheet, offer summary) shown in a
 *  preview panel. NOTHING is written to the CRM until the user approves —
 *  by voice ("file it") or the panel's button. */
export type DocumentVisual = {
  kind: "document";
  docType: "letter" | "call_sheet" | "offer_summary";
  title: string;
  /** Plain text with newlines; rendered pre-wrap, printable. */
  body: string;
  hcadAccount: string;
  address: string | null;
  /** True once it has been written to the CRM as a note. */
  filed: boolean;
};

export type Visual = ParcelVisual | CompsVisual | GroundVisual | DocumentVisual | { kind: "dissolve" };

// ── Client → Gateway ───────────────────────────────────────────────────────
export type ClientMsg =
  | { type: "hello" }
  /** A user utterance as text (typed, or transcribed client-side). */
  | { type: "text"; text: string }
  /** Re-establish which parcel "this one" refers to (sent after the client
   *  restores a saved constellation, and on reconnect) so voice CRM writes
   *  keep working across refreshes. */
  | { type: "focus"; hcadAccount: string }
  /** Mic streaming begins; binary PCM16 frames follow. */
  | { type: "audio_start"; sampleRate: number }
  | { type: "audio_stop" }
  /** Barge-in: stop speaking/thinking immediately. */
  | { type: "interrupt" }
  /** Quiet mode: when muted, the gateway skips TTS audio entirely and streams
   *  only text captions (same brain, no voice). Persists for the connection. */
  | { type: "set_muted"; muted: boolean }
  /** Document panel action: file the pending draft to the CRM, or discard it.
   *  `doc` carries the draft itself so filing survives gateway restarts and
   *  Durable Object hibernation (server memory may have been reborn empty). */
  | {
      type: "doc_action";
      action: "file" | "discard";
      doc?: { docType: "letter" | "call_sheet" | "offer_summary"; title: string; body: string; hcadAccount: string; address: string | null };
    };

// ── Gateway → Client ───────────────────────────────────────────────────────
export type ServerMsg =
  | { type: "ready"; caps: Capabilities }
  | { type: "state"; state: OrbState }
  | { type: "transcript"; text: string; final: boolean }
  /** Streaming assistant text (for captions). */
  | { type: "assistant_text"; text: string; done: boolean }
  /** Client-side TTS instruction (fallback mode), one sentence at a time. */
  | { type: "speak"; text: string }
  /** Next binary frame is TTS audio for this utterance segment. */
  | { type: "audio_chunk"; seq: number; mime: string; last: boolean }
  | { type: "tool"; name: string; status: "start" | "end"; detail?: string }
  | { type: "visual"; visual: Visual }
  | { type: "error"; message: string };
