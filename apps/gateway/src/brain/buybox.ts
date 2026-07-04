// The buy-box learner (INTELLIGENCE-ROADMAP §1.1 #3, §5 #7): every "save
// it", "mark it hot", "hard no", and dictated note is preference data. A
// nightly job distills the last N decisions into one speakable paragraph —
// the team's revealed buy-box — injected into Claude's system prompt as a
// SECOND system block (the first block keeps its cache_control marker and
// stays byte-stable, so prompt caching survives; the prefix only shifts when
// the buy-box itself changes, at most nightly).
//
// This is the moat that cannot be copied: it is distilled from THEIR
// decisions, and it compounds. Closed-price mentions in notes ("closed at
// 315") are extracted alongside as the appraisal-vs-market calibration seed.

import Anthropic from "@anthropic-ai/sdk";
import { listLeadsForBuyBox, listRecentNotes, crmAvailable } from "../tools/crm";
import { digestStore, type DigestStore } from "../tools/digest";

const BUYBOX_KEY = "buybox:v1";
const CALIB_KEY = "calib:v1";
const DISTILL_MODEL = "claude-haiku-4-5-20251001";

export type BuyBox = {
  paragraph: string;
  updatedAt: string;
  evidence: { leads: number; notes: number; closedPrices: number };
};

export type CalibrationEntry = {
  leadAddress: string | null;
  zip: string | null;
  closedPrice: number;
  noteDate: string | null;
  raw: string;
};

/** "closed at 315" / "sold for $1.2m" / "closed at 315k" → dollars. */
export function parseClosedPrice(note: string): number | null {
  const m = note.match(/\b(?:closed|sold)\s+(?:it\s+)?(?:at|for)\s+\$?([\d][\d,]*(?:\.\d+)?)\s*(k|thousand|m|mm|million)?\b/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") n *= 1_000;
  else if (unit === "m" || unit === "mm" || unit === "million") n *= 1_000_000;
  // Bare small numbers in land talk mean thousands ("closed at 315").
  else if (n < 10_000) n *= 1_000;
  return Math.round(n);
}

export async function getBuyBox(store: DigestStore = digestStore()): Promise<BuyBox | null> {
  const raw = await store.get(BUYBOX_KEY);
  return raw ? (JSON.parse(raw) as BuyBox) : null;
}

export type DistillSkip = { skipped: string };
export const isSkip = (r: BuyBox | DistillSkip): r is DistillSkip => "skipped" in r;

export async function distillBuyBox(store: DigestStore = digestStore()): Promise<BuyBox | DistillSkip> {
  if (!crmAvailable()) return { skipped: "CRM not configured" };
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: "no ANTHROPIC_API_KEY" };
  const [leads, notes] = await Promise.all([listLeadsForBuyBox(120), listRecentNotes(80)]);
  if (leads.length < 5) return { skipped: `only ${leads.length} leads — too little evidence to pretend there's a pattern` };

  // Closed-price calibration seed — extracted in code, not by the model.
  const calib: CalibrationEntry[] = [];
  for (const n of notes) {
    const price = parseClosedPrice(n.body);
    if (price == null) continue;
    calib.push({
      leadAddress: n.leadAddress,
      zip: n.leadAddress?.match(/\b(77\d{3})\b/)?.[1] ?? null,
      closedPrice: price,
      noteDate: n.createdAt?.slice(0, 10) ?? null,
      raw: n.body.slice(0, 160),
    });
  }
  await store.put(CALIB_KEY, JSON.stringify(calib.slice(0, 200)));

  const line = (l: (typeof leads)[number]) => {
    const zip = l.address?.match(/\b77\d{3}\b/)?.[0] ?? "?";
    const psf = l.appraisedValue && l.lotSqft ? ` $${Math.round(l.appraisedValue / l.lotSqft)}/sf` : "";
    return `${l.status ?? "?"} | ${l.address?.split(",")[0] ?? "?"} (${zip})${psf}${l.lotSqft ? ` ${Math.round(l.lotSqft).toLocaleString()}sf` : ""}`;
  };
  const evidence =
    `LEADS (status | address | appraised $/sf lot | lot size):\n` +
    leads.map(line).join("\n") +
    `\n\nRECENT NOTES (newest first):\n` +
    notes.map((n) => `[${n.leadStatus ?? "?"}] ${n.leadAddress?.split(",")[0] ?? "?"}: ${n.body.slice(0, 200)}`).join("\n");

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: DISTILL_MODEL,
    max_tokens: 400,
    system:
      "You distill a Houston land-acquisition team's CRM evidence into their revealed buy-box. Write ONE paragraph, maximum 120 words, plain speakable prose (it will be read aloud and injected into a voice assistant's prompt). Describe: what they chase (areas/zips, lot sizes, price-per-square-foot bands), what they pass on, and any repeated concerns from notes. Only state patterns the evidence actually supports; where evidence is thin, say so briefly rather than inventing. No markdown, no preamble, no lists — output the paragraph only.",
    messages: [{ role: "user", content: evidence }],
  });
  const paragraph = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  if (!paragraph) return { skipped: "distiller returned empty text" };

  const buyBox: BuyBox = {
    paragraph,
    updatedAt: new Date().toISOString(),
    evidence: { leads: leads.length, notes: notes.length, closedPrices: calib.length },
  };
  await store.put(BUYBOX_KEY, JSON.stringify(buyBox));
  return buyBox;
}
