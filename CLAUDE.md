# CLAUDE.md — HVI / Jarvo

Voice-first AI for a Houston land-buying team (Houston Land Group). Ask out loud →
live Harris County data answers out loud → a 42k-particle orb morphs into real
parcel geometry, every parcel discussed joining a persistent "constellation" map.
This file is auto-loaded every session — read it first.

## Doc map (what owns what)
- **CLAUDE.md** (this file) — architecture, the add-a-tool recipe, and the HARD INVARIANTS.
- **README.md** — how to run locally.
- **ROADMAP.md** — the chronological execution log + a pinned "Current State" at the top.
- **NEXT-HORIZON.md** — what to build next (§6 is the build order). Start a new build session here.
- **TEAM-GUIDE.md** — the non-dev voice cheat sheet for the team.
- **DEPLOY.md** — deploy runbook + the secrets-rotation checklist.
- INTELLIGENCE-ROADMAP.md (strategy) · GARZA.md (a stakeholder pitch) · SKIPTRACE-MATCH-QUALITY.md (a post-mortem).

## Architecture (pnpm monorepo under `hvi/`)
- `apps/web` — Next.js 15 + react-three-fiber (static export → Cloudflare Pages "jarvo", live at **jarvo.pages.dev**). 60fps data flows through `lib/orbBus.ts` (mutable channel), never zustand.
- `apps/gateway` — the Node WS orchestrator (`src/`): `session.ts` (turn lifecycle + SessionMemory), `brain/rules.ts` (keyless fallback brain) and `brain/claude.ts` (Claude Opus 4.8 tool loop), `providers/` (deepgram/elevenlabs/skiptrace), `tools/` (~26 tool files + `index.ts` registry).
- `apps/worker` — the Cloudflare port that runs the gateway in production (Durable Objects per session, crons for the nightly digest + monthly snapshot + propensity scoring). **This is prod: `wss://hvi-gateway.houstonlandguy.workers.dev`.** It imports the gateway `src/` unchanged via a WsLike adapter.
- `packages/shared/src/protocol.ts` — the WS wire protocol. Single source of truth for client↔gateway messages and `Visual` frames (what the orb morphs into).

**Two brains, same tools:** `rules.ts` parses the utterance with regexes and calls tools directly (works with zero API keys); `claude.ts` gives Claude the same `toolSchemas` and runs an agentic loop. Both call `executeTool()` in `tools/index.ts`. When you add a capability, wire BOTH.

**Key decisions (don't relitigate without reason):**
- Parcels come LIVE from HCAD ArcGIS. The CRM's Supabase holds ~1,084 enriched *leads*, NOT the 1.77M parcels. No parcel mirror.
- CRM auth = a service USER (bot login + publishable key), not a service-role key. RLS applies (no deletes). All write logic lives here, not in Lovable.
- The CRM has a DB trigger that writes `lead_status_history` on status updates — NEVER insert history rows manually.

## HARD INVARIANTS (never violate — these are load-bearing)
1. **CRM writes happen ONLY on the user's explicit instruction** ("save it", "add a note", "trace it", "file it"). Never write/infer silently. Documents are never filed until approved.
2. **During testing, all CRM WRITES go to the 505 Westcott test lead ONLY** — hcad `0986620000107`. Reads of other leads are fine. The mock skip-trace provider hard-codes this guard. (User-directed production enrichment of real leads is the exception — only when the user explicitly asks.)
3. **Secrets never enter git.** `.env` is gitignored (it holds all real keys). Any key that has passed through chat must be rotated + re-put via `wrangler secret put`. See DEPLOY.md.
4. **Compliance (TCPA/DNC):** manual tap-to-dial only, 8am–9pm local, **no texting features ever**. DNC + bad numbers render unclickable on the card and as DO-NOT-DIAL lines on call sheets. Enformion results are NOT DNC-screened — say so.
5. **Never pay twice on skip traces:** check the CRM first; only re-trace on an explicit `force`. Trace on intent, never inventory.
6. **The Claude system prompt must stay byte-stable** for prompt caching (`cache_control` block in `brain/claude.ts`). The buy-box rides as a SECOND system block after it. Don't casually edit the cached prefix; don't personalize it.
7. **Honesty:** every number cites a source; HCAD lag is spoken; a data-source-down state is surfaced, never dressed up as a false "quiet night." Mock/test data is always announced as such.

## Add-a-tool recipe (the proven pattern)
Copy an existing tool (e.g. `tools/violations.ts` is a clean, small one):
1. `tools/<source>.ts` — the data fetch + parse, with an honest-lag note and a `kvCached()` wrapper.
2. Schema in `toolSchemas` (top of `tools/index.ts`) — Claude's JSON tool definition.
3. Executor `case` in `executeToolInner` (`tools/index.ts`) — runs it, updates `SessionMemory`, calls `emitDecorated()` to repaint the card.
4. Rules-brain trigger in `brain/rules.ts` — a regex block. **Order matters:** put more specific triggers ABOVE broader ones (a trace-the-LLC trigger must precede a who-owns-this trigger).
5. Card row / visual field in `packages/shared/src/protocol.ts` + `apps/web/components/HUD.tsx` if it shows on the card.
6. Activity label in `apps/web/lib/voice.ts` (`TOOL_LABELS`).

## Run · test · deploy
- Local: `pnpm dev` (gateway :8787 + web :3000). Claude model is `claude-opus-4-8`.
- **E2E test pattern (no browser):** open a WS to the prod gateway, send `{"type":"text","text":"…"}`, assert tool calls / spoken text / TTS audio bytes. Known-good: 505 Westcott St (test lead), 1218 Yale St, 209 Milwaukee St.
- **Deploy gateway:** `pnpm exec wrangler deploy` in `apps/worker` (needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from `.env`).
- **Deploy web:** `NEXT_PUBLIC_GATEWAY_URL=wss://hvi-gateway.houstonlandguy.workers.dev pnpm exec next build` then `wrangler pages deploy out --project-name jarvo`.
- Commit style: terse imperative subject; end with the `Co-Authored-By: Claude` trailer; push to `github.com/Fernando-Houston/jarvo` (branch `main`).

## Gotchas (hard-won)
- **Worker deploys take 1–2 min to propagate AND live Durable Objects keep old code** — always test on a FRESH connection after a short wait.
- Typecheck all three: `(cd apps/gateway && pnpm exec tsc --noEmit)`, same for `apps/worker` and `apps/web`.
- The preview sandbox can't run servers under `~/Desktop` (macOS TCC) — run `next dev -p 3001` via plain Bash + the `.claude/launch.json` TCP proxy, then use the preview tools against :3000.
- HCAD 400s if `outFields` names a nonexistent field. HCAD owner strings are `LAST FIRST MIDDLE`. County APIs (HCAD, LGBS) go down — degrade honestly.
- THREE.ShaderMaterial clones its uniforms; r3f rebuilds objects on HMR — see the orb notes in ROADMAP if the orb ever looks "dead."
