// Voice documents: the papers a land team actually produces, drafted whole
// by the brain from session data, previewed in the app, and NEVER written to
// the CRM until the user approves ("file it" / the panel button).
//
//   letter         — owner outreach; plain-spoken, no hype, no pressure.
//                    Default house language lives in the prompt below —
//                    swap in Garza's proven phrasing when he shares it.
//   call_sheet     — 30 seconds of prep before dialing an owner.
//   offer_summary  — proposed terms in clean prose. Deliberately NOT a
//                    contract or LOI; counsel papers the real thing.

import Anthropic from "@anthropic-ai/sdk";

const DOC_MODEL = "claude-opus-4-8";

export type DocKind = "letter" | "call_sheet" | "offer_summary";

export type DocFacts = {
  parcel: Record<string, unknown>;
  flood: string | null;
  ch42Units: number | null;
  taxSale: { status: string; saleDate: string | null } | null;
  verdict: string | null;
  compsMedian: number | null;
  /** CRM contact enrichment — the call sheet's dial list. */
  contacts: {
    primary: string | null;
    others: Array<{ number: string; belongsTo: string | null }>;
    bad: Array<{ number: string; reason: string | null }>;
    notes: string | null;
  } | null;
  user: string | null;
  /** Free-form guidance from the utterance ("mention the fence", price, tone). */
  guidance: string | null;
};

const SYSTEMS: Record<DocKind, string> = {
  letter: `You write owner-outreach letters for Houston Land Group, local land buyers. Voice: a neighbor writing a letter, not a company sending mail — plain, warm, specific, zero hype, zero pressure, no exclamation marks.

Rules:
- Open with something true and specific about THEIR property (the street, how long they've held it) — that's what makes it get read.
- The pitch, briefly: we buy land and houses as-is, cash, no commissions or fees, they pick the closing date, no obligation to respond.
- NEVER mention tax problems, distress, or anything that could read as surveillance — even if the data shows it. If the owner is absentee you may gently acknowledge that managing property from a distance is work.
- Close with one soft ask: a call or text to [YOUR PHONE].
- Sign: [YOUR NAME], Houston Land Group.
- 120-170 words, plain text, no markdown. Placeholders stay in square brackets.`,

  call_sheet: `You prepare one-page call sheets for a land acquisition caller. Plain text, no markdown symbols. Use these exact section headers on their own lines:
DIAL:
OWNER & HOLD:
THE PROPERTY:
THE NUMBER:
SIGNALS:
TALKING POINTS:
LIKELY OBJECTIONS:
THE ASK:
DIAL lists the phone numbers exactly as provided: the primary first, then other good numbers with who they belong to, then any marked bad on one line as "DO NOT DIAL: ..." with the reason. If no numbers are provided, DIAL says "No number on file — enrichment pending." Every fact must come from the provided data — never invent. Keep each section to 1-3 tight lines. Where a signal is sensitive (tax suit), phrase the talking point so the CALLER knows it but would never say it ("motivated timeline likely — do not raise taxes"). Under 220 words.`,

  offer_summary: `You write offer summaries for Houston Land Group. Plain text, no markdown. Use these exact section headers:
PROPERTY:
PROPOSED TERMS:
BASIS CONTEXT:
NEXT STEPS:
Every number must come from the provided data or the user's stated terms. If no price was stated, write [PRICE TBD] rather than inventing one. End with this exact line:
"This is a summary of proposed terms for discussion — not a contract, an option, or a binding letter of intent."
Under 150 words.`,
};

const TITLES: Record<DocKind, string> = {
  letter: "Owner outreach letter",
  call_sheet: "Call sheet",
  offer_summary: "Offer summary",
};

export function docTitle(kind: DocKind, address: string | null): string {
  return `${TITLES[kind]} — ${address?.split(",")[0] ?? "parcel"}`;
}

export async function composeDocument(kind: DocKind, facts: DocFacts): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Document drafting needs the Claude brain — no API key configured.");
  }
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: DOC_MODEL,
    max_tokens: 700,
    system: SYSTEMS[kind],
    messages: [
      {
        role: "user",
        content:
          `Draft the ${TITLES[kind].toLowerCase()} from this data.\n\n` +
          `PARCEL:\n${JSON.stringify(facts.parcel)}\n\n` +
          `SESSION KNOWLEDGE: flood=${facts.flood ?? "unknown"}; ch42_units=${facts.ch42Units ?? "n/a"}; ` +
          `tax_pipeline=${facts.taxSale ? `${facts.taxSale.status}${facts.taxSale.saleDate ? ` (auction ${facts.taxSale.saleDate})` : ""}` : "none found"}; ` +
          `verdict=${facts.verdict ?? "not run"}; comps_land_median_per_sqft=${facts.compsMedian ?? "n/a"}\n\n` +
          `OWNER CONTACTS (CRM enrichment): ${facts.contacts ? JSON.stringify(facts.contacts) : "none on file"}\n\n` +
          `USER GUIDANCE: ${facts.guidance ?? "none"}`,
      },
    ],
  });
  const body = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!body) throw new Error("Draft came back empty.");
  return body;
}
