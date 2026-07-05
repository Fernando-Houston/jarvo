# HVI — Deploy runbook

**Status 2026-07-05: fully live in the cloud.** Gateway on Cloudflare Workers
(`wss://hvi-gateway.houstonlandguy.workers.dev`), web on Cloudflare Pages
(jarvo.pages.dev). Both deploy from this repo. See CLAUDE.md for architecture.

## Deploy the gateway (Workers + Durable Objects)
```bash
cd apps/gateway && pnpm exec tsc --noEmit    # typecheck first
cd ../worker
CLOUDFLARE_API_TOKEN=<from .env> CLOUDFLARE_ACCOUNT_ID=<from .env> pnpm exec wrangler deploy
```
⚠️ Propagation takes 1–2 min AND live Durable Objects keep old code — test on a
FRESH WebSocket connection after a short wait, not an existing session.

## Deploy the web app (Pages, static export)
```bash
cd apps/web
NEXT_PUBLIC_GATEWAY_URL=wss://hvi-gateway.houstonlandguy.workers.dev pnpm exec next build
CLOUDFLARE_API_TOKEN=<from .env> CLOUDFLARE_ACCOUNT_ID=<from .env> \
  pnpm dlx wrangler pages deploy out --project-name jarvo --commit-dirty=true
```
Custom domain available in the same CF account: `hvi.houstonlandguy.com`.

## Secrets — the ONE home for the rotation checklist
`.env` (gitignored) holds all real values for local dev; prod uses
`wrangler secret put` in `apps/worker`. **Every key below has passed through a
chat session and must be rotated at the provider, then re-put — this is the
standing "STILL OWED" action:**

| Secret | Provider action | Prod command |
|---|---|---|
| `ANTHROPIC_API_KEY` | rotate at console.anthropic.com | `wrangler secret put ANTHROPIC_API_KEY` |
| `DEEPGRAM_API_KEY` | rotate at Deepgram | `wrangler secret put DEEPGRAM_API_KEY` |
| `ELEVENLABS_API_KEY` | rotate at ElevenLabs | `wrangler secret put ELEVENLABS_API_KEY` |
| `HVI_CRM_PASSWORD` | reset the Land Lead Hub bot user | `wrangler secret put HVI_CRM_PASSWORD` |
| `CLOUDFLARE_API_TOKEN` | roll in CF dashboard | (used locally; not a worker secret) |
| `SKIPTRACE_ENFORMION_AP_NAME` / `_AP_PASSWORD` | regenerate in EnformionGO (Apps → API → Keys) | `wrangler secret put SKIPTRACE_ENFORMION_AP_NAME` (+ `_AP_PASSWORD`) |
| `VAPID_PRIVATE_KEY` | keep (not chat-exposed) | already set |

Then set gateway auth: `HVI_SHARED_SECRET` = `openssl rand -hex 24` →
`wrangler secret put HVI_SHARED_SECRET`, AND rebuild the web app with
`NEXT_PUBLIC_GATEWAY_TOKEN=<same value>` so the client can connect, AND append
the token to the digest-banner fetch (flagged in code). Setting the secret
without the matching web token locks the team out.

## Post-deploy smoke test
1. Open jarvo.pages.dev on a phone — the ● LIVE dot shows top-right.
2. "What's 505 Westcott Street worth?" → orb morph + card.
3. "Is it in the floodplain?" → blue tint on SFHA.
4. Mic test with speakers up — the echo guard must hold (physical test still owed).
5. The 505 Westcott test lead accumulates test data — the team deletes it from
   Land Lead Hub whenever noticed (it's marked safe to delete).
