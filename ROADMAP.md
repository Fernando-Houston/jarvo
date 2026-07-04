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

**✅ NIGHTLY DIGEST CRON + WEB PUSH (2026-07-04, INTELLIGENCE-ROADMAP §5 #1):**
The pull→push flip. `tools/digest.ts`: nightly sweep of the pipeline's
hot/new/revisit leads (cap 6 areas) → `lookupRecentTransfers` around each →
diffed against a KV-stored seen-baseline (`digest:seen:v1`, key =
account:recorded-date, so "fresh" = fresh TO US; first run seeds and reports
newest-per-area only). Digest stored at `digest:latest:v1`; NO CRM writes
(keeps real leads untouched). Worker: cron `0 12 * * *` (7am CDT) →
`runDigestAndPush`; Web Push implemented dep-free in `apps/worker/src/
webpush.ts` (VAPID ES256 JWT + RFC 8291 aes128gcm on WebCrypto); routes
`/push/vapid|subscribe|unsubscribe`, `/digest` (GET stored), `/digest/run`
(POST manual). KV namespace `HVI_KV` (993da56e…) bound; VAPID private key +
subject in wrangler secrets, public key in [vars]. Voice: `nightly_digest`
tool (+ rules trigger /digest|overnight|what's new/) reads the stored run or
sweeps live. Web: `sw.js` + `lib/push.ts` + "alerts" HUD button; PWA
manifest + orb icon added (iOS push needs home-screen install). Worker now
typechecks (`tsconfig.json` + workers-types were missing). VERIFIED: local
digest run (4 fresh deeds, 6 areas, dedup on 2nd run) · prod `/digest/run`
+ KV persistence across isolates · WS E2E on the cloud gateway ("what's new
overnight?" → Claude called nightly_digest → honest quiet-night answer +
250KB TTS) · subscribe/unsubscribe roundtrip · manifest live.
**USER ACTION: on each phone, open jarvo.pages.dev (iPhone: add to Home
Screen first), tap "alerts", allow notifications — then the 7am digest
lands as a push.** Proper PNG icons still open. Push delivery to a real
device untested until someone subscribes.

**✅ TIME MACHINE SNAPSHOTS (2026-07-04, INTELLIGENCE-ROADMAP §5 #2) — KV
INTERIM, R2 BLOCKED:** `apps/worker/src/snapshot.ts` + `HviSnapshotDO`
(migration v2): monthly cron `0 8 1 * *` (3am CDT on the 1st) snapshots ALL
62 HCAD attribute fields (no geometry) for every zip the pipeline touches
(`trackedZips()` = distinct 77xxx from all leads' addresses, ~26 zips today).
DO alarm chain: ≤10 pages (1000 rows, OBJECTID-keyset pagination) + 1 KV
write per alarm run — fits free-plan subrequest limits; wounded zips are
skipped and logged on state, never stall the chain. Parts: gzipped NDJSON at
`snap:v1:<YYYY-MM>:<zip>:p<n>` behind a `SnapshotStore` interface — **R2 is
NOT ENABLED on the account (API error 10042); storage is Workers KV for now
(~26 zips ≈ 400k rows ≈ fits the 1GB free tier for months). USER ACTION:
enable R2 in the Cloudflare dashboard (needs payment method) → then rebind
the store to a `hvi-snapshots` bucket + widen scope to the whole county.**
Routes: POST `/snapshot/run`, GET `/snapshot/status`. The FIRST snapshot
(2026-07) was started today — the moat is compounding as of now. Verified:
typecheck, prod deploy, first run swept live (status endpoint), digest still
green.
**R2 UPGRADE (2026-07-04, same day — user enabled R2):** bucket
`hvi-snapshots` created; `r2SnapshotStore` added; the DO picks R2 when the
`SNAPSHOTS` binding exists (KV remains the fallback). Scope generalized:
default sweep is now `county` (the FULL 1.77M-parcel roll, ~1,770 pages ≈
177 alarm runs ≈ an hour, monthly) — `?scope=zips` narrows to pipeline zips.
July's 41 KV parts migrated to R2 via budgeted POST `/snapshot/migrate`
(KV list eventual-consistency gotcha: deleted keys linger in listings as
null gets — skip cheaply). County-wide 2026-07 sweep started same day.

**✅ THE VERDICT TOOL (2026-07-04, INTELLIGENCE-ROADMAP §5 #3):**
`tools/verdict.ts` — the kill-chain as one word. `verdict(hcad_account)`
runs city_overlays → flood_check → chapter42_feasibility → comps THROUGH
the executor (so the map paints every layer while the verdict forms), then
`composeVerdict()` grades five signals — overlays (blocking = red), flood
(floodway red / SFHA yellow), Ch.42 yield (0 units = red), pricing vs comps
median (>+15% yellow), structure ratio (bld/total >50% yellow, <15% "trading
as dirt") — overall = worst signal; headline number = appraised basis ÷
buildable units + subject vs median land $/sqft. Failed links become yellow
"couldn't verify" signals, never crashes. Every result carries the
"screening at appraisal basis, not underwriting" note. Rules trigger
/verdict|should we pursue|is this a deal/. VERIFIED local: 1218 Yale → RED
(historic district; everything else green), 209 Milwaukee → RED (special
min lot size — a restriction the plain Ch42 answer never surfaced!) +
yellow 19% pricing premium. VERIFIED CLOUD E2E: "Verdict on 1218 Yale —
should we pursue it?" → Claude chained property_lookup→verdict, map built
parcel→flood(X)→ch42(4u)→comps, spoke "RED, and the reason is location,
not the numbers" with receipts + honest framing. 559KB TTS.

**✅ TAX DELINQUENCY CONNECT (2026-07-04, INTELLIGENCE-ROADMAP §5 #4):**
Source found: the LGBS tax-sale API (taxsales.lgbs.com — Linebarger, the
county's collection firm; ~365 Harris parcels in the legal pipeline, 135
scheduled for the Aug-4 auction). Fields: 13-digit `account_nbr` (= HCAD),
sale_type (SALE/RESALE/STRUCK OFF/FUTURE SALE), status, sale_date,
minimum_bid, cause_nbr, point geometry; filters: `account_nbr=`, `in_bbox=`.
HONESTY LINE (in every result): suits/judgments/auctions only — owners
merely behind on taxes without a lawsuit do NOT appear. `tools/taxsale.ts`;
tools `tax_sale_check(hcad_account)` + `tax_sale_radar(hcad_account,
radius_m)` (pops distressed parcels onto the map, "tax auction 2026-08-04"
notes); verdict gained a `distress` signal (green "motivated seller and a
clock" — never downgrades); nightly digest sweeps distress near pipeline
leads (seen-baseline `ts:` keys). Rules trigger /tax sale|delinquent|
distress/ (radar when "near/around"). VERIFIED local (known FUTURE SALE
account + clean test lead + 15-parcel Northside radar) and CLOUD E2E:
"is 3106 Kirk's owner behind on taxes, any distress nearby?" → Claude
chained lookup→check→radar, spotted the estate + tax suit combo AND that
3116 Kirk NEXT DOOR is also in the pipeline; digest run in prod surfaced
"Tax distress near 1133 Adele St: 807 E 32nd ½ St, min bid $39k". Watch:
LGBS is an undocumented public API — if it changes shape, the tools degrade
to spoken "couldn't reach the listings".

**✅ LLC GRAPH + ASSEMBLAGE DETECTOR (2026-07-04, INTELLIGENCE-ROADMAP §5 #5):**
`tools/entity.ts` + hcad.ts gains `lookupByMailAddress` (mailbox = entity
resolver; suffix-insensitive LIKE + mail_zip) and `lookupNeighbors` (raw
envelope sweep). `mailKey()` (number+name words, suffixes dropped, zip5),
`parcelsAdjacent()` (vertex proximity ≤6m, 120m centroid gate),
`tiredOwner()` (absentee OR 15+yr hold OR no transfer), `institutionalOwner`
exclusion (city/county/church/school/MUD never sell), `clusterByMail`,
`findOpportunities` (adjacent + different mailboxes + both tired + Ch42
synergy: combined−separate ≥2, or ≥1 when combined ≤12 — the "clears the
threshold together" case; +1 on a 35-unit site is rounding noise, filtered).
Tools: `owner_graph(hcad_account)` (true portfolio: mail-cluster ∪ owner-name,
distinct operating names, total holdings, biggest pop onto map) and
`assemblage_scan(hcad_account, radius_m=300)` (in-progress clusters +
opportunities, both painted). Rules triggers /really own|shell|llc/ and
/assembl|combine lots|accumulat/. Honest notes everywhere: adjacency is
geometric approximation, yields are the lot-size heuristic, HCAD lags.
VERIFIED local: 1218 Yale → 1216 Yale mailbox controls both ($1.46M);
Kirk St block → real 4-parcel accumulation + back-to-back absentee pairs.
CLOUD E2E: one utterance → property_lookup + owner_graph + assemblage_scan,
8 visuals; Claude separated "no portfolio behind THIS mailbox" from "Juana
Hernandez controls four parcels from one Lockwood mailbox" and pitched the
Milbrad/Love 9-vs-8-unit packages. 1.1MB TTS.

**✅ KV CACHE + LATENCY LOGS + NAMED USERS (2026-07-04, INTELLIGENCE-ROADMAP
§5 #6):** `tools/kvcache.ts` — `kvCached(kind, rawKey, ttl, fn)` on the
globalThis KV bridge (put now forwards expirationTtl); wired into HCAD
queries (10-min TTL), FEMA zones (24h), city overlays (24h). Cache failures
never fail the call; Node dev passes through (LRUs cover it). MEASURED in
prod across two fresh connections: property_lookup 814ms cold → 4ms warm —
the analyst inherits the scout's warm cache. Tool latency: executeTool wraps
inner with `[tool] name Nms` logs — `wrangler tail hvi-gateway` is the
latency dashboard (Analytics Engine needs paid plan; Sentry needs a DSN —
**USER ACTION if wanted: create Sentry project + provide DSN**). Named
users: `?u=fernando` on the WS URL → `SessionMemory.user`; web persists
`jarvo.pages.dev/?u=fernando` → localStorage → every reconnect; wrap-up
recap notes gain "logged by fernando via Jarvo"; `[session] user=` in logs
(verified in tail). Claude system prompt deliberately NOT personalized
(byte-stable for prompt caching). **USER ACTION: each teammate opens
jarvo.pages.dev/?u=<name> once per device.**

**✅ BUY-BOX LEARNING (2026-07-04, INTELLIGENCE-ROADMAP §5 #7):**
`brain/buybox.ts` + crm.ts `listLeadsForBuyBox`/`listRecentNotes` (nested
lead join works under RLS). Nightly (same cron beat as the digest):
evidence pack (120 leads: status|address|$-per-sf|lot; 80 notes verbatim) →
Haiku (`claude-haiku-4-5`) distills ONE ≤120-word speakable paragraph →
KV `buybox:v1`. Closed-price calibration seed: `parseClosedPrice()` regex
("closed at 315" → $315k) extracts from notes into KV `calib:v1` (0 entries
today — becomes real when the team dictates closes). Claude brain injects
the buy-box as a SECOND system block AFTER the cache_control block (cached
prefix intact; prompt shifts at most nightly), framed as "your pipeline
history", never market data, user overrides win. Skips are diagnosable
(`{skipped: reason}`); routes GET `/buybox`, POST `/buybox/run`. VERIFIED
prod: distilled a real pattern (Third Ward/77004 corridor, 30–50 $/sf,
named streets) and CLOUD E2E "does 3414 Milbrad fit what we usually go
after?" → "lot size is right in your wheelhouse… but outside your core
Third Ward corridor… scattered-lot category you only chase selectively."
Jarvo now pre-sorts like a partner. NOTE: first prod distill returned a
transient null (suspected stale supabase sign-in state in a long-lived
isolate) — succeeded on retry; reasons now logged.

**✅ VOICE PERSONA PASS (2026-07-04, the verifiable slice of
INTELLIGENCE-ROADMAP §5 #9):** one character paragraph in the Claude system
prompt (dry, numerate, Houston-fluent, allergic to hype; "worth a look" or
"a pass", never "an incredible opportunity"; sides with data gently). The
cached block changed ONCE — keep it byte-stable again. VERIFIED CLOUD E2E
under hype pressure ("wholesaler says it'll double in a year"): → "that's
the wholesaler's script, not a number… 60 dollars a foot is already full
retail… outside your usual 77004 hunting ground. Want me to run the flood
check before you give the wholesaler any oxygen?" (5330 Indigo = Meyerland;
the flood instinct is correct — it's Zone AE.)
STILL OPEN from §5: #8 multiplayer constellation (a full session of work:
room DO + protocol + client merge — do it fresh); #9 flood-water ground
render + barge-in (both need human eyes/ears to verify — pair with the
next demo session).

**✅ GROUND LAYER + "WHERE IS THIS?" (2026-07-04):** tools/ground.ts — USGS NHD
flowlines (named bayous) + TxDOT Roadways (IH/US/SH) around the focus, decimated
polylines → new GroundVisual wire kind → constellation renders them as faint
particle streams (nodeKind 5 road amber / 6 water blue, radial sqrt warp
R_REF=2200m→2.7 world units, 45% of pool when present); spoken orientation
(downtown dist/dir, nearest bayou/freeway). Rules /where is|what's around/ +
Claude schema. VERIFIED CLOUD E2E: 1218 Yale → Whiteoak Bayou + I-10 on map,
"2.8 mi NW of downtown" spoken. Session-lifecycle fix same day: focus-note
context injection (reconnect amnesia) — see git log.
