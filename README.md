# HVI — Houston Voice Intelligence

Voice-first AI for Houston real estate. Ask out loud; the living orb answers
with live Harris County data — and on high-value answers, the orb's particles
reassemble into the actual parcel.

## Run it

```bash
pnpm install
cp .env.example .env   # fill in whatever keys you have (all optional)
pnpm dev               # gateway on :8787, web on :3000
```

Open http://localhost:3000 and ask: **"What's 505 Westcott Street worth?"**

## Keyless demo mode

With an empty `.env` the system still works end-to-end:

| Capability | With key | Without key (automatic fallback) |
|---|---|---|
| Brain | Claude Opus 4.8, streaming tool use (`ANTHROPIC_API_KEY`) | Rules brain: address parse → HCAD → templated answer |
| STT | Deepgram streaming (`DEEPGRAM_API_KEY`) | Browser Web Speech API (Chrome/Safari) |
| TTS | ElevenLabs Flash v2.5 (`ELEVENLABS_API_KEY`) | Browser speechSynthesis |
| CRM | Land Lead Hub Supabase (`SUPABASE_SERVICE_ROLE_KEY`) | CRM tools report unavailable |

Parcel data always comes live from HCAD's public ArcGIS layer — no key needed.

## Layout

```
apps/gateway   Node WS orchestrator: STT ↔ brain (tools) ↔ TTS, emits UI events
apps/web       Next.js + react-three-fiber: the orb, HUD, audio plumbing
packages/shared  WebSocket wire protocol (single source of truth)
```

## Architecture notes

- **Parcels:** live from HCAD ArcGIS (`gis.hctx.net`), query patterns ported
  from the production CRM (`land-lead-hub_FINAL/src/lib/parcelLookup.ts`).
  The CRM's Supabase is the source of truth for *leads*, not parcels.
- **Morphs:** gateway sends `visual` events with real parcel rings; the client
  converts rings → 42k particle targets (boundary + interior fill) and the
  orb eases into the lot shape while the spoken answer streams.
- **Latency:** brain streams sentences to TTS as they complete — first spoken
  words start before later tool calls finish.
