// Deal Memo mode (INTELLIGENCE-ROADMAP §1.1 #2): the 30-second voice answer
// and the considered memo are different products from the same brain. This
// takes the full kill-chain output + the team's buy-box and writes the
// structured memo — thesis, basis math, risks, next actions — that gets
// filed on the lead as a CRM note.

import Anthropic from "@anthropic-ai/sdk";

const MEMO_MODEL = "claude-opus-4-8";

const MEMO_SYSTEM = `You write acquisition deal memos for Houston Land Group, a land acquisition team. You are dry, numerate, and allergic to hype — deals are "worth a look" or "a pass", never opportunities of a lifetime.

Write ONE memo as plain text (it becomes a CRM note — no markdown symbols, no asterisks). Use these exact section headers on their own lines:
THESIS: (one or two sentences — what the play is, or why there isn't one)
THE NUMBER: (the single figure that decides this deal, with its comparison)
BASIS MATH: (2-3 lines of arithmetic a partner can check)
RISKS: (the red/yellow signals, each with its consequence — not a disclaimer wall)
EXIT VIEW: (what the buyer of the finished product pays for, anchored to the comps evidence)
NEXT ACTIONS: (2-3 concrete moves, in order)

Rules: every number must come from the provided data — never invent one. Where the data is appraisal-basis, say so once. If the team's buy-box is provided and relevant, reference it as "our pipeline history". Keep the whole memo under 220 words.`;

export type MemoFacts = {
  parcel: Record<string, unknown>;
  verdict: Record<string, unknown>;
  buybox: string | null;
  user: string | null;
};

export async function composeDealMemo(facts: MemoFacts): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Deal memos need the Claude brain — no API key configured.");
  }
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: MEMO_MODEL,
    max_tokens: 800,
    system: MEMO_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Write the deal memo from this data.\n\nPARCEL:\n${JSON.stringify(facts.parcel)}\n\n` +
          `KILL-CHAIN VERDICT:\n${JSON.stringify(facts.verdict)}\n\n` +
          `TEAM BUY-BOX (from our own pipeline decisions):\n${facts.buybox ?? "none distilled yet"}`,
      },
    ],
  });
  const body = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!body) throw new Error("Memo came back empty.");
  const stamp = new Date().toISOString().slice(0, 10);
  const by = facts.user ? ` · requested by ${facts.user}` : "";
  return `JARVO DEAL MEMO · ${stamp}${by}\n\n${body}\n\n— county records at appraisal basis; screening, not underwriting`;
}
