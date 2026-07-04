# HVI — Project State & Roadmap

> **Purpose of this file:** everything a fresh Claude Code session needs to continue
> building HVI without re-discovering context. Read this top to bottom, then start
> at the first unchecked item in [The Backlog](#the-backlog-prioritized).
> Companion docs: `README.md` (run instructions), `../VISION.md`, `../PROJECT-BRIEF.md`.
> Last updated: 2026-07-03.

---

## 1. What HVI is

Voice-first AI assistant for Houston Land Group ("Jarvis for Houston real estate").
Ask out loud → live Harris County data answers out loud → and the signature visual:
a 42k-particle **orb** that morphs into real parcel geometry. Every parcel discussed
joins a persistent **constellation** — a geographically-true deal map built from
conversation (true bearings/distances from the current focus, sqrt-compressed).

Target workflows, in priority order:
1. **Drive-by mode** — hands-free lookup + "save it as a lead, note: corner lot" while driving.
2. **Desk triage** — compare 4-5 candidate lots spatially (values, flood, $/sqft), then save/tag by voice.
3. **The 30-second demo** — lookup → morph → "is it in the floodplain?" → blue tint → "save it" → it appears in Land Lead Hub.

## 2. Architecture (as built)

```
apps/web      Next.js 15 + react-three-fiber v9 (client-only page)
              Orb.tsx        42k-particle GLSL orb + constellation + free camera
              constellation.ts / particleField.ts   geo layout + parcel sampling
              voice.ts       WS client, WebSpeech fallback, audio playback, persistence
              store.ts (zustand) + orbBus.ts (60fps mutable channel, no react)
apps/gateway  Node WS orchestrator (ws, tsx), port 8787
              session.ts     per-connection turn lifecycle + SessionMemory
              brain/claude.ts  Claude Opus 4.8 streaming tool loop (READY, needs credits)
              brain/rules.ts   keyless fallback: address parse → tools → templated speech
              providers/deepgram.ts   nova-3 streaming STT + Houston keyterms
              providers/elevenlabs.ts TTS queue (HTTP streaming per sentence)
              tools/hcad.ts  live HCAD ArcGIS lookup ladder (ported from CRM)
              tools/crm.ts   Supabase reads + writes (service-user auth)
              tools/index.ts tool schemas + executor + SessionMemory
packages/shared/src/protocol.ts   the WS wire protocol (single source of truth)
```

**Key decisions (don't relitigate without reason):**
- **Parcels come LIVE from HCAD ArcGIS** (`gis.hctx.net/.../Parcels/MapServer/0/query`).
  The CRM's Supabase does NOT hold the 1.77M parcels — it holds ~1,084 enriched *leads*.
  No parcel mirror, no SQLite migration. Field names: `site_str_num` (int),
  `site_str_name`, `HCAD_NUM` (13-digit), `total_appraised_val`, `new_owner_date`, etc.
- **CRM auth = service user, not service-role key** (Lovable Cloud won't reveal it).
  Bot: `hvi-bot@houstonlandguy.com`, `team_member` role, RLS applies (no deletes).
  Signs in with the CRM's publishable key. All write logic lives HERE, not in Lovable
  (zero Lovable credits consumed).
- **CRM has its own DB trigger writing `lead_status_history`** on status updates —
  never insert history rows manually (verified in prod; caused duplicates).
- **ElevenLabs: professional voice clones GARBLE on `eleven_flash_v2_5`.**
  Default model is `eleven_turbo_v2_5` (works with all voices). Verified by
  round-tripping TTS audio through Deepgram transcription.
- Every capability degrades gracefully: no keys → WebSpeech + speechSynthesis + rules
  brain + HCAD still live. Gateway announces caps in the `ready` message.

## 3. Current status (what works today)

| Capability | Status | Notes |
|---|---|---|
| HCAD lookups (address/owner/account/nearest) | ✅ live | no key needed |
| Orb + morph + constellation + labels + free camera | ✅ live | drag orbit, wheel zoom, recenter |
| Constellation persistence | ✅ live | localStorage `hvi-constellation-v1`, "clear map" wipes |
| Deepgram STT (server) | ✅ live | nova-3 + keyterms; UPGRADE PATH: Flux eager end-of-turn |
| ElevenLabs TTS | ✅ live | voice "Adam" `bfGb7JTLUnZebZRiFYyq`; swap to Jarvo `vfmxjXWrvIXtVaXU5kya` after user clicks "Add to My Voices" in ElevenLabs library |
| CRM read (lead check by hcad_account) | ✅ live | spoken: "already in your pipeline, marked new" |
| CRM writes (add lead / note / tag / status) | ✅ live | voice commands in rules brain; tools ready for Claude |
| Claude brain | 🟡 blocked | key VALID in .env; org has **zero credits** (checkout was failing — Stripe/Link wedge). On success: restart gateway → `brain: claude` |
| Cloudflare deploy | 🟡 ready | scoped token + account id in .env, perms verified; port not done |

**Test lead in prod CRM:** 505 Westcott St (hcad `0986620000107`, status hot_lead,
note "HVI integration test lead, safe to delete") — team deletes via UI when noticed.

**Env (`hvi/.env`, gitignored — all real values present unless noted):**
`ANTHROPIC_API_KEY` (valid, no credits) · `DEEPGRAM_API_KEY` · `ELEVENLABS_API_KEY` +
`ELEVENLABS_VOICE_ID` · `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `HVI_CRM_EMAIL` +
`HVI_CRM_PASSWORD` · `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
⚠️ All of these passed through chat — **rotate before public launch**.

**Run & test:**
```bash
pnpm dev                 # gateway :8787 + web :3000 (from hvi/)
# NOTE: the Claude-Code preview sandbox CANNOT execute under ~/Desktop (macOS TCC).
# Run dev servers from a normal shell. Chrome-extension browsing also flaky here.
# E2E gateway test pattern (no browser needed): open a ws to :8787, send
# {"type":"text","text":"What is 505 Westcott Street worth?"}, watch events.
# Known-good test addresses: 505 Westcott St (34-unit condo), 1218 Yale St
# (single parcel, KIM BARBELL LLC, in 77008), 209 Milwaukee St (existing lead).
```

## 4. The Backlog (prioritized)

Work top to bottom. Each item has enough detail to start cold.

### ✅ P0-1 · Echo guard (biggest demo landmine) — DONE 2026-07-03
Half-duplex, both sides. Client (`apps/web/lib/voice.ts`): `micGated` flag — while
playback is active (server TTS or speechSynthesis), the PCM worklet forwards
**zero-filled frames of the same length** instead of real audio (keeps the Deepgram
stream alive — it closes after ~10s of no audio — but it hears silence). Gate engages
in `drainPlayQueue`/`speakWithBrowser`, releases on queue drain / `stopPlayback`.
Gateway (`session.ts`): `turnSpeaking` flag drops STT partials+finals from first
sentence until `brain.run` returns (matters for the Claude brain, whose run spans
the whole streaming window; rules brain returns instantly). Verified: typecheck,
live WS turn test, real spoken PCM → Deepgram → turn fired when idle.
**Still owed: the physical test — mic on, speakers loud, ask a question.**
Barge-in (true full-duplex) remains parked in P3.

### ✅ P0-2 · FEMA flood-zone tool + blue-tinted morph — DONE 2026-07-03
`apps/gateway/src/tools/fema.ts` (trimmed port of the CRM client): centroid point
query + parcel-bbox envelope sweep (`touchesSfha` catches wet-corner lots), 12s
timeout, results cached per session in `SessionMemory.floodByAccount`. Tool
`flood_check(hcad_account)` re-emits the focus visual with
`floodZone`/`sfha`/`floodLabel` (new optional `ParcelVisual` fields). Rules brain
triggers on /flood/i (handles an address riding along in the same utterance);
Claude gets it via the tool schema. Client: `orbBus.flood` → eased `uFlood`
uniform → morphed focus particles tint `vec3(0.25,0.55,1.0)`; HUD card shows a
Flood row (blue when SFHA); tint survives constellation restore, clears on clearMap.
Verified live: 505 Westcott → Zone X spoken correctly; 5330 Indigo St (Meyerland)
→ Zone AE, sfha=true on the visual. **Blue tint itself not yet eyeballed in a browser.**

### ✅ P0-3 · Data polish trio — DONE 2026-07-03
- **Absentee flag**: `Parcel.absenteeOwner` via `normalizeStreet()` compare in
  parseFeature; in compact() as `absentee_owner`; rules brain speaks
  "Tax mail goes to 1216 Yale St, Houston — looks like an absentee owner"
  (zip/state stripped). Note: flags next-door mail too (1218 vs 1216 Yale) —
  correct per definition ("no mail at the property"), verified live.
- **$/sqft**: `value_per_lot_sqft` in compact(); spoken in rules answers; HUD
  card row computed client-side from appraisedValue/lotSqft.
- **Pipeline badge**: `ParcelVisual.leadStatus` + `SessionMemory.leadStatusByAccount`;
  all visual emits go through `emitDecorated()` (tools/index.ts) so flood + lead
  state survive re-emits; crm_lead_check/add_lead/update_status keep the cache
  fresh and re-emit; HUD renders "IN PIPELINE · NEW" chip (`.parcel-pipeline`).
  Verified live: 209 Milwaukee St re-emitted with leadStatus=new.

### ✅ P0-4 · Write-trust fixes — DONE 2026-07-03
- **Focus re-sync:** `{type:"focus", hcadAccount}` added to ClientMsg. Client
  tracks `focusAccount` (set on restore + every parcel visual, cleared on
  clearMap) and replays it on EVERY ws open, so reconnects heal too. Gateway
  `setFocus()` sets `memory.lastAccount` + lazily hydrates via `lookupByAccount`.
  Verified: fresh socket + focus(505 Westcott test lead) + "save this" →
  idempotent "already in the pipeline".
- **Condo save disambiguation:** `SessionMemory.lastMatches` (set by
  property_lookup; forced to 1 by owner_lookup/flood_check since those narrow
  focus). Rules brain: save/hot with lastMatches>3 asks "which unit, or say
  'save the building'"; "save the building" writes first account + unit-count
  note. Claude brain: system-prompt rule added (prompt text changed — cache
  warmup restarts, fine). Verified live, no unit was silently written.
  Note: after a refresh, a restored condo focus has lastMatches=0 → "save it"
  saves the restored (specific) account — intended, focus is one account.

### ✅ P1-5 · Feel + utility — DONE 2026-07-03
- **HCAD LRU cache**: in `queryHcad()` (200 entries, 10-min TTL, key = full
  URLSearchParams body). Measured live: 550ms cold → 10ms cached.
- **Transcript rail**: `Turn[] {user, assistant}` in zustand (`beginTurn` on
  typed/voice-final utterances, `appendTurnText` on assistant deltas), capped
  at 50 turns, persisted to sessionStorage (`hvi-transcript-v1`). HUD "log"
  button toggles a left-edge scrollable panel (`.transcript-rail`).

### P1-6 · Gateway auth + Cloudflare deploy — MEDIUM (auth ✅ 2026-07-03, deploy pending)
- ✅ Auth: `HVI_SHARED_SECRET` env on the gateway (unset = open for local dev);
  client appends `?token=` from `NEXT_PUBLIC_GATEWAY_TOKEN`; unauthorized
  sockets close with 4401. Verified live (no/wrong/right token).
  Set BOTH env vars together when deploying.
- ✅ Gateway → Workers + DO port SHIPPED 2026-07-04 (see below). Was:
  User has GIVEN the go-ahead (2026-07-04). Web is already live at
  jarvo.pages.dev (Pages project "jarvo", static export, deploys work).
  We test-drove a trycloudflare quick tunnel to the local gateway: it DIED
  TWICE in hours and each death needs tunnel restart + rebuild + redeploy
  (URL is baked at build time). Conclusion: don't patch tunnels — port the
  gateway. Plan: one DO per session; `ws` → WebSocketPair; providers already
  fetch/WS-compatible; secrets via `wrangler secret put` (ROTATE THEM FIRST —
  all passed through chat); then rebuild web with the stable
  NEXT_PUBLIC_GATEWAY_URL + HVI_SHARED_SECRET token pair and redeploy jarvo.
  Mobile audio is FIXED in code (Web Audio playback, unlocked by first tap —
  untested on a real phone because the tunnel died before the user's retest).
- Web: our page is fully client-side → `next build` static export → `pnpm dlx
  wrangler pages deploy` (project name `hvi`). Set `NEXT_PUBLIC_GATEWAY_URL=wss://...`.
- Gateway port: Workers + Durable Objects (one DO per session). Port `ws` →
  `WebSocketPair`; providers use fetch/WebSocket APIs already compatible. Secrets via
  `wrangler secret put`. Token + account id in .env; perms verified (Pages+Workers).
- Custom domain: `hvi.houstonlandguy.com` (domain lives in the same CF account).

**INTERIM (2026-07-04): credit fallback + Claude-like rules.** The gateway now
runs with the REAL key (`brain: claude` caps). When Claude 400s on credits,
`session.ts` silently falls back to a rules brain for that turn (logged
server-side, no error frame to the client) — so the demo works TODAY and
flips to real Claude on a gateway restart once credits land. The rules brain
also learned: follow-ups on the focus parcel ("who owns it", "what's it
worth", "how big", "mailing address") and **"give me the full picture"** —
chains flood_check → comps → chapter42_feasibility → crm_lead_check into one
composed spoken answer while the map accumulates every layer (verified live:
zone X + 60 comps + 6 townhomes + pipeline badge in a single visual).

**✅ CLOUD DEPLOYMENT COMPLETE (2026-07-04):** gateway lives at
`wss://hvi-gateway.houstonlandguy.workers.dev` (`apps/worker`: DO per session,
`new_sqlite_classes` migration for free plan, nodejs_compat, WsLike adapter,
dual-runtime Deepgram client w/ ["token", key] subprotocol auth; workers.dev
subdomain "houstonlandguy" registered via API). All 8 secrets set via
`wrangler secret put`. jarvo.pages.dev rebuilt against it. E2E-verified from
the internet: caps + live HCAD answer + 427KB TTS audio. STILL OWED: rotate
chat-exposed secrets + re-put; phone-verify mobile TTS; HVI_SHARED_SECRET.

### P2-7 · Claude brain burn-in (WHEN CREDITS LAND) — first restart gateway, then:
- Run multi-turn suite: follow-ups ("who owns it" after "what's it worth"),
  constellation comparison ("which of these is the better deal per square foot?"),
  voice CRM write ("save the cheaper one, note the owner's an LLC").
- Watch: latency (target < 2s to first audio — if slow: sentence-level TTS overlap
  is already in; next lever is ElevenLabs WS streaming input + Deepgram Flux eager EOT),
  tool-call discipline (writes ONLY on explicit ask), token cost per turn
  (prompt caching is enabled via cache_control on system block — verify
  `cache_read_input_tokens > 0` on turn 2+).

### ✅ P2-8 · Comps tool — DONE 2026-07-03
`lookupComps()` in hcad.ts (envelope query, same `land_use` code — field exists,
e.g. "1001" single-family — lot ±40%, subject excluded, ≤60). Tool `comps
(hcad_account, radius_m=800)` returns land $/sqft distribution (median/quartiles,
land_value÷lot_sqft, appraised fallback) + emits new `CompsVisual` wire kind.
Constellation: comps scatter as nodeKind 3 (dim steel-blue satellites, small
gaussian blobs at true bearings hugging the focus, budget-guarded) + one
"40 comps · ~$27/sqft land" summary chip; dropped when focus changes; persisted.
Rules brain trigger /comps|comparables|trading for near/ speaks median, middle
half, and subject vs neighborhood ("33 vs 27 — above the neighborhood"), with
the appraisal-not-sales caveat. Claude gets the schema. Verified live in the
browser: 209 Milwaukee → 60 comps, median $27/sqft, scatter + chip render and
survive reload. ALSO fixed: client `send()` now queues text utterances while
the ws is reconnecting (they used to vanish silently after a gateway restart).

### ✅ P2-9 · Chapter 42 feasibility — THE CROWN JEWEL — DONE 2026-07-04
`apps/gateway/src/tools/chapter42.ts`: ported constants + open-space tables from
script.py; grid search adds depth-driven row splits (finds 6 units on 209
Milwaukee where the width-only heuristic found 4); buildings placed as ATTACHED
townhome rows (zero interior side setbacks — the script's detached 10-ft sides
zeroed out 20-ft lots; perimeter setbacks still honored), 60% coverage caps
depth; tries the lot-size ladder (1400→5000) and keeps max units (ties → bigger
lots). Tool `chapter42_feasibility(hcad_account | lot_sqft, street_type,
target_lot_sqft)`; site W×D derived from parcel bbox; result cached in
`SessionMemory.ch42ByAccount`; `ParcelVisual.ch42` carries units/density/rects
(persists + survives re-emits via emitDecorated). Client: `sampleRectsInto()`
(particleField) maps rect feet → the SAME normalized frame as the parcel;
nodeKind `4 + 0.85·(i/n)` encodes assembly order; vertex shader assembles
rect-by-rect (wave), fragment tints warm white, brighter than the lot; HUD row
"Ch. 42 fit · N units · D/ac". Rules trigger /chapter 42|how many units|
townhomes|feasib|subdivid/. Verified in browser: 209 Milwaukee → "6 townhomes
on ~1,750-sf lots, geometry-bound at 24.7/ac, 12 parking, 720sf open space" +
six unit rectangles rendered inside the lot frame. Speak-synced one-by-one
assembly (vs. the current wave) parked for the Claude brain era.

### P3 · Later / ideas parking lot
- ✅ Deal radar (2026-07-04): `recent_transfers(hcad_account, radius_m, days)` —
  newest owner changes near the focus, popped onto the map one-by-one (600ms,
  paced in the EXECUTOR so Claude gets the animation too), focus returns home;
  rules trigger /changed hands|recently sold|radar/. GOTCHA: HCAD's snapshot
  trails the courthouse by MONTHS (Northside's freshest was 7mo old) — never
  hard-filter by date, take newest-on-record and speak real month+year, with
  the lag caveat. "0 E 31st St" = vacant-lot addressing → spoken as "the lot on".
  Verified: Heights radar → 5 transfers incl. $2M on E 10th, March 2026.
- ✅ Session wrap-up (2026-07-04): "wrap up the session" writes an HVI recap
  note (value, $/sqft, flood, comps median via new
  `SessionMemory.compsMedianByAccount`, Ch.42 fit, absentee) to every
  pipeline lead discussed this session. Verified against the 505 Westcott
  test lead — one note, spoken confirmation.
- ✅ Morning briefing over the PIPELINE (2026-07-04): "good morning" /
  "briefing" / "my hot leads" → `pipeline_briefing` tool reads newest
  hot_lead+new leads via `crm.listLeads()`, hydrates each parcel from HCAD,
  pops them onto the map (600ms pace, newest ends in focus with its status
  chip), speaks counts + newest + a next-action prompt. Verified live: 8
  leads, 1 hot, five nodes popped with statuses.
- Morning briefing over CRM `saved_areas` polygons — PROBED 2026-07-04: the
  table EXISTS but is EMPTY (team hasn't drawn areas yet). Build only after
  areas exist so the row shape (polygon format) can be read from real data.
- ✅ Owner portfolio view (2026-07-04): "what else do they own?" — rules brain
  looks up holdings by the focus owner's name, then emits each parcel as its
  own visual with 650ms spacing so nodes pop onto the constellation one by
  one as the voice narrates; focus returns home afterward; speaks count +
  total appraised holdings. Verified: KIM BARBELL LLC → 1216 Yale pops in
  "nearby", $1.5M total.
- ✅ Live activity ticker (2026-07-04): tool start/end events now surface as a
  pulsing line above the caption ("reading Harris County records…",
  "checking FEMA flood maps…" — labels in voice.ts TOOL_LABELS); clears on
  idle/listening. Transcript rail also auto-scrolls to the newest turn.
- MapLibre dark basemap under the constellation (nodes settle onto real streets);
  deck.gl transaction dots.
- WebGPU/TSL compute upgrade for 200k+ particles; bloom pass.
- Barge-in (true full-duplex) via Deepgram Flux `EagerEndOfTurn`/`TurnResumed`.
- ✅ Launch polish (2026-07-04): badge row → single breathing "● LIVE" status
  dot (caps in tooltip); mobile pass (≤640px: card = bottom sheet, full-width
  input row, thumb buttons, 16px input vs iOS zoom, rail overlay); fixed
  `.clear` buttons rendering as unstyled white boxes + node chips overlapping
  the card (z-index). `output: "export"` in next.config — static build
  verified (112kB first load). See DEPLOY.md for the launch runbook
  (rotate secrets → gateway Workers port → Pages deploy). PWA manifest open.
- "Brief me" session summary → writes note to every lead discussed.
- ElevenLabs WS `stream-input` for continuous prosody; Jarvo voice swap.
- Embed on houstonlandguy.com as lead-gen (Phase 4 of original brief).

## 5. Gotchas for the next session (hard-won)
1. Preview sandbox / Chrome extension can't touch `~/Desktop` — run servers via
   plain Bash; verify gateway via WS test scripts, UI via user screenshots.
2. HCAD 400s if `outFields` contains a nonexistent field; multi-word street names
   need the noise-word truncation in `parseAddress` (mind "worth/owns/value").
3. `dotenv` in the gateway loads `../../../.env` relative to `src/index.ts` — root
   `.env` is the single env file for both apps (web reads only `NEXT_PUBLIC_*`).
4. pnpm workspace: `@anthropic-ai/sdk` must stay ≥0.110 for adaptive thinking types.
5. Deepgram streaming session: finals accumulate in `turnBuffer` until
   `speech_final` — don't fire turns on bare `is_final`.
6. R3F: all 60fps data flows through `orbBus` mutation, never zustand (re-renders).
7. Claude model: `claude-opus-4-8`, `thinking: {type:"adaptive"}`,
   `output_config.effort: "low"` for voice snappiness, system block has
   `cache_control: {type:"ephemeral"}` — keep it byte-stable.
8. **THREE.ShaderMaterial CLONES the uniforms object it's constructed with.**
   Mutating the useMemo'd uniforms template does nothing — the orb froze at
   t=0 (no morph, no animation) until useFrame switched to writing
   `material.current.uniforms` via a ref. If the orb ever looks "dead" again,
   check `__hviOrbDebug` (window tap) first: uTime should be ticking.
9. **r3f rebuilds THREE objects on StrictMode/HMR remounts while useRef guards
   survive** — upload-once patterns (`appliedVersion`) then skip re-uploading
   into the rebuilt (zeroed) buffers. Orb.tsx now also compares attribute
   IDENTITY (`appliedAttr`) before skipping. Bit hardest when a saved
   constellation restores at mount time (targets exist during the remount churn).
10. **Preview-panel workaround for the ~/Desktop TCC block**: run the real dev
   servers via plain Bash (gateway :8787, `next dev -p 3001`), then let
   `.claude/launch.json` start a tiny node TCP proxy (scratchpad script,
   executable lives outside ~/Desktop) that pipes :3000 → :3001. preview_*
   tools then work fully — screenshots, fills, evals. `__hviOrbBus` and
   `__hviOrbDebug` window taps exist for state inspection.

**✅ P2-7 BURN-IN PASSED (2026-07-04, $30 credits live):** Claude brain on the
DEPLOYED Workers gateway: multi-turn context, parallel tool calls
(ch42+flood), cross-parcel reasoning w/ market context, insight beyond tool
output (read "two platted lots → replatting" from legal_dscr; knew Lindale
Park ≈ White Oak Bayou), graceful tool-failure disclosure. ~2.4s to first
tool. 🔴 OPEN ISSUE: FEMA NFHL fetch fails FROM CLOUDFLARE WORKERS (works
from Node/Mac) — likely fema.gov blocking CF egress; fix candidates: retry
w/ backoff, alternate NFHL host, or proxy via the identify endpoint.

**✅ CITY OVERLAYS TOOL (2026-07-04):** `tools/cityOverlays.ts` — one identify
call against COH Planning_and_Development MapServer (mycity2.houstontx.gov/
pubgis02, layers 3,8,9,12,13,35,40: conservation/historic city+national/
special min building line/special min lot size/market parking/opp zones),
browser UA headers (same WAF fix as FEMA). Tool `city_overlays` + rules
trigger /historic|restrict|overlay/. Claude schema says ALWAYS check before
townhome recommendations. VERIFIED CLOUD E2E: 1218 Yale = Heights East
Historic District → Claude reversed its own townhome rec to renovation play,
citing Certificate of Appropriateness. FEMA cloud fix (UA header) also ✅.
Parked from this sweep: homestead flag (not in HCAD parcels layer — needs
different dataset), tax delinquency, permits, Ch42 urban/suburban boundary.
