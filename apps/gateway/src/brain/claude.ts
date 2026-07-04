// The real brain: Claude Opus 4.8 with streaming tool use.
// Text deltas stream out sentence-by-sentence so TTS can start speaking
// the first sentence while later tool calls are still running.

import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toolSchemas, type ToolContext } from "../tools/index";
import { getBuyBox } from "./buybox";
import type { Brain, BrainEvents } from "./types";

const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are HVI — Houston Voice Intelligence — the voice assistant of Houston Land Group, a land acquisition team in Houston, Texas. You are grounded in live Harris County (HCAD) property records and the team's CRM.

Everything you say is SPOKEN ALOUD. Style rules:
- Conversational, confident, brief. 1-3 short sentences for simple lookups.
- Never use markdown, bullets, headers, or symbols. No URLs.
- Round numbers naturally: say "about 180 thousand dollars", not "$179,634.00". Say lot sizes in square feet or acres, whichever is more natural.
- When an address matches many stacked parcels, it is a condo or multi-unit building: summarize (unit count, value range) and offer to drill into a unit. Do not read out lists.
- If the CRM says a property is already a lead, mention its status. If the CRM tool reports it is not connected, never mention a CRM at all.
- If a lookup finds nothing, say so plainly and ask the user to repeat or clarify the street name — voice transcription mangles street names sometimes.
- Use tools for any specific property, owner, or pipeline question. Answer general Houston market questions from your own knowledge, noting when data is from memory rather than live records.
- CRM writes (crm_add_lead, crm_add_note, crm_update_status) happen ONLY on the user's explicit instruction ("save it", "add a note", "mark it hot") — never on your own initiative. Confirm out loud what you did. "This one" or "it" means the property most recently discussed.
- If the user says to save a property whose address matched many stacked units, do NOT silently save one unit: ask which unit, or offer to save the building — if they say the whole building, save the first account with a note recording the unit count.
- The map on screen focuses whatever parcel the last tool call returned. When the user asks to see or revisit a property — even one already discussed — call property_lookup again so the map and card refocus; answering purely from memory leaves the display stale.`;

/** Split streaming text into speakable sentence chunks. */
export function makeSentenceChunker(onSentence: (s: string) => void) {
  let buf = "";
  return {
    push(delta: string) {
      buf += delta;
      // Flush on sentence enders followed by space/end, or long clauses.
      let m: RegExpMatchArray | null;
      while ((m = buf.match(/^([\s\S]*?[.!?])(\s+|$)/))) {
        const sentence = m[1].trim();
        buf = buf.slice(m[0].length);
        if (sentence) onSentence(sentence);
        if (!buf) break;
      }
      if (buf.length > 220) {
        const cut = buf.lastIndexOf(",", 200);
        const idx = cut > 80 ? cut + 1 : 200;
        const chunk = buf.slice(0, idx).trim();
        buf = buf.slice(idx);
        if (chunk) onSentence(chunk);
      }
    },
    flush() {
      const rest = buf.trim();
      buf = "";
      if (rest) onSentence(rest);
    },
  };
}

export function createClaudeBrain(): Brain {
  const client = new Anthropic();
  const history: Anthropic.MessageParam[] = [];
  // The team's distilled buy-box rides as a SECOND system block, after the
  // cache-controlled one — the cached prefix stays intact, and this block
  // only changes when the nightly distiller rewrites it. Loaded once per
  // session; a load failure just means no buy-box this session.
  let buyBoxBlock: string | null = null;
  let buyBoxLoaded = false;

  return {
    name: "claude",
    async run(userText: string, events: BrainEvents, ctx: ToolContext, signal: AbortSignal) {
      if (!buyBoxLoaded) {
        buyBoxLoaded = true;
        try {
          const bb = await getBuyBox();
          if (bb) {
            buyBoxBlock =
              `Team buy-box, distilled ${bb.updatedAt.slice(0, 10)} from the team's own pipeline decisions (${bb.evidence.leads} leads, ${bb.evidence.notes} notes). Use it to pre-sort and frame recommendations, attributing it as "your pipeline history" — never present it as market data, and let the user's explicit asks override it: ${bb.paragraph}`;
          }
        } catch {
          /* no buy-box this session */
        }
      }
      history.push({ role: "user", content: userText });
      // Keep the conversation bounded (voice sessions are short-turn).
      while (history.length > 24) history.shift();
      if (history[0]?.role !== "user") history.shift();

      const chunker = makeSentenceChunker(events.onSentence);

      // Manual agentic loop: stream each response, run tools, repeat.
      for (let iteration = 0; iteration < 6; iteration++) {
        if (signal.aborted) return;
        const stream = client.messages.stream(
          {
            model: MODEL,
            max_tokens: 1200,
            system: [
              { type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } },
              ...(buyBoxBlock ? [{ type: "text" as const, text: buyBoxBlock }] : []),
            ],
            thinking: { type: "adaptive" },
            output_config: { effort: "low" },
            tools: toolSchemas,
            messages: history,
          },
          { signal }
        );

        stream.on("text", (delta) => {
          events.onTextDelta(delta);
          chunker.push(delta);
        });

        const response = await stream.finalMessage();
        history.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") {
          chunker.flush();
          return;
        }

        // Execute tool calls (in parallel) and return results in ONE user message.
        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );
        const results = await Promise.all(
          toolUses.map(async (tu) => {
            events.onTool(tu.name, "start");
            let content: string;
            let isError = false;
            try {
              content = await executeTool(tu.name, tu.input as Record<string, unknown>, ctx);
            } catch (err) {
              content = `Error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
            events.onTool(tu.name, "end");
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content,
              ...(isError ? { is_error: true } : {}),
            };
          })
        );
        history.push({ role: "user", content: results });
      }
      chunker.flush();
    },
    reset() {
      history.length = 0;
    },
  };
}
