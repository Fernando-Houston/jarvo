# HVI — Cloudflare launch runbook

Status 2026-07-04: web app is DEPLOY-READY (static export builds clean,
mobile-optimized). The GATEWAY is not yet in the cloud — deploying the web
app alone gives a dead orb. Ship order below.

## 0. BEFORE anything public — rotate every secret
All values in `.env` passed through chat sessions. Rotate at the provider,
update `.env`, restart gateway:
- Anthropic API key · Deepgram key · ElevenLabs key
- `HVI_CRM_PASSWORD` (Land Lead Hub service user)
- Cloudflare API token
Then set a fresh `HVI_SHARED_SECRET` (gateway auth) — e.g. `openssl rand -hex 24`.

## 1. Gateway → Cloudflare Workers + Durable Objects (the remaining port)
Port `apps/gateway` per ROADMAP P1-6: one DO per session, `ws` →
`WebSocketPair`, secrets via `wrangler secret put`. Until this lands, team
testing works TODAY over LAN/tailscale: run `pnpm dev` on this machine and
point phones at `http://<this-mac>:3000` (gateway URL via env below).

## 2. Web → Cloudflare Pages
```bash
cd apps/web
NEXT_PUBLIC_GATEWAY_URL=wss://<gateway-host> \
NEXT_PUBLIC_GATEWAY_TOKEN=<HVI_SHARED_SECRET> \
pnpm exec next build            # static export → out/
pnpm dlx wrangler pages deploy out --project-name hvi
```
Custom domain: `hvi.houstonlandguy.com` (same CF account).

## 3. Post-deploy smoke test
1. Open the URL on a phone — ● LIVE dot top-right.
2. "What's 505 Westcott Street worth?" → morph + card sheet.
3. "Is it in the floodplain?" → blue tint.
4. Mic test with speakers up — echo guard must hold.
5. Delete the 505 Westcott test lead from Land Lead Hub when done.
