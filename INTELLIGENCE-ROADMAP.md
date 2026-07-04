# Jarvo Intelligence Roadmap — the deep dive

> Written 2026-07-04, after the platform went fully live (jarvo.pages.dev +
> Workers gateway, 12 tools, Claude brain). This is the strategy document:
> every layer audited, every enhancement mapped, the "secrets" latent in data
> we already touch, and the honest line between intelligence and hype.
> Companion to ROADMAP.md (execution log) — this file is WHY and WHAT NEXT.

---

## 1. The four layers — audit and enhancement paths

### 1.1 The Model (the brain)

**Today:** Claude Opus 4.8, adaptive thinking, low effort (voice snappiness),
prompt caching on the system block, ~6-iteration tool loop, per-session
history capped at 24 turns. Rules brain as billing fallback.

**Enhancements, ranked:**

1. **Model routing (cost + speed).** Not every turn needs Opus. A Haiku
   pre-router classifies the utterance: lookups/follow-ups → Haiku answers
   from tool JSON (~10x cheaper, faster to first word); analysis/comparison/
   negotiation → Opus. Voice platforms live and die on latency; routing buys
   both. The Brain interface already abstracts this — a `router.ts` brain
   that delegates.
2. **Deal Memo mode (extended thinking).** "Write me the deal memo" →
   switch that one turn to high effort + extended thinking: full tool sweep,
   then a structured memo (thesis, basis math, exit comps, risks, next
   actions) written to the CRM as a note. The 30-second voice answer and the
   3-minute considered memo are different products from the same brain.
3. **The team's buy-box as a living system prompt.** Every "save it", "pass",
   "mark it hot", and dictated note is preference data. A nightly job
   distills the last N decisions into a buy-box paragraph ("the team pays up
   for Heights dirt, avoids floodway, likes 6+ unit yields, hates shared
   detention…") injected into the system prompt. Jarvo starts pre-sorting
   like a partner who's sat in on every meeting. THIS is the stickiness
   moat — it literally cannot be replicated without their history.
4. **Batch API for nightly scoring.** Anthropic's batch API is 50% off —
   perfect for the overnight jobs in §3 (scoring thousands of parcels is a
   batch problem, not a voice problem).
5. **Voice persona pass.** One system-prompt paragraph defining Jarvo's
   character (dry, numerate, Houston-fluent, allergic to hype) so the team
   hears the same colleague every day. Consistency builds trust; trust
   builds dependence.

### 1.2 The Application layer (tools + surfaces)

**Today:** 12 tools (HCAD lookup/owner/comps/transfers, FEMA, Chapter 42,
city overlays, ground layer, CRM read/write/briefing), orb constellation UI,
mobile, tap-to-travel, gyro parallax.

**Enhancements:**

1. **The Verdict tool — "should we pursue this?"** One tool that runs the
   entire kill-chain in order (overlays → flood → Ch42 → comps → basis
   math) and returns a structured verdict: GREEN/YELLOW/RED + the one
   number that matters (land basis per buildable unit vs area median).
   Today Claude chains these when asked; making it one named tool makes it
   one breath: *"Jarvo, verdict on 1218 Yale."* The whole platform becomes
   a yes/no machine with receipts.
2. **Push notifications (the flip from pull to push).** Everything today is
   ask-driven. The dependence flip is Jarvo speaking FIRST: a Worker cron
   sweeps tracked areas/owners nightly; when something changes (new deed by
   a tracked LLC, delinquency filed on a watched parcel), the team gets a
   push → opens the app → the briefing is waiting. Web Push API + the
   existing pipeline_briefing machinery. **This is the single highest-leverage
   unbuilt feature.** A tool you ask is useful; a tool that calls YOU about
   money is indispensable.
3. **Multiplayer constellation.** The map is per-device (localStorage).
   Persist constellations to the CRM keyed by team, and the morning
   briefing becomes a SHARED war room — Fernando's drive-by discoveries are
   on the analyst's desk map at 9am, with the voice trail in lead notes.
   Durable Objects make live-shared sessions almost free to add (one DO =
   one room; we already have one DO per session).
4. **Flood water on the ground layer.** NFHL polygons rendered as a blue
   particle water table under the lot (we have the ground-layer machinery
   now — flood polygons are just another feature kind). "Is it in the
   floodplain" becomes *watching where the water reaches*.
5. **Voice UX debt:** barge-in (Deepgram Flux eager end-of-turn), "start
   over" voice command, resume-after-reconnect apology, speak-synced
   Chapter 42 assembly, ElevenLabs WS streaming for prosody.
6. **Data connects still open:** tax delinquency roll (motivated sellers),
   building/demo permits (block momentum), replat filings (PlatTracker
   folder exists on the city host — probe it), TIRZ/Opportunity-Zone
   incentives detail, TxDOT project map (freeway expansion = frontage and
   condemnation plays), HCFCD buyout lists.

### 1.3 The Compute (Cloudflare)

**Today:** Workers + one DO per session, static Pages, secrets in wrangler,
free-tier SQLite DOs.

**Enhancements:**

1. **KV cache for HCAD/FEMA/overlay responses.** The in-memory LRU dies
   with each isolate. Workers KV (10-min TTL for HCAD, 24h for FEMA/
   overlays) makes repeat lookups instant for the WHOLE TEAM — when the
   analyst checks a parcel the scout looked up an hour ago, it's warm.
2. **Cron triggers = the nightly brain.** Scheduled Workers run the sweeps
   (§3) and batch scoring. This is where "platform" becomes "employee that
   works nights."
3. **R2 + snapshots = the Time Machine (see §2.1 — the biggest secret).**
4. **D1/Vectorize for semantic memory.** Embed every lead note + session
   recap; "what did we say about that lot near the bayou with the weird
   easement?" becomes answerable. Vectorize is right there in the account.
5. **Durable Object hibernation billing note:** current architecture is
   near-free at team scale (<$5/mo projected). Headroom is enormous —
   don't prematurely optimize.
6. **Observability:** Sentry on the web app; Workers Analytics Engine for
   tool-latency dashboards ("FEMA slow this week"). I can read both.

### 1.4 Objectivity (the trust layer)

An intelligence tool the team DEPENDS on must be honest about what it knows.
This is a feature to build, not a disclaimer to write:

1. **Every number carries its provenance.** Already partially done (tool
   results carry "appraisal basis, not sale prices"; radar admits HCAD's
   courthouse lag). Systematize: a `confidence` + `as_of` + `source` field
   on every tool result, and a system-prompt rule: never state a number
   without being able to say where it came from if asked. *"Says who?"*
   should always get a real answer.
2. **Appraisal ≠ market, quantified.** HCAD values lag and skew. When the
   team closes deals, dictating the real price ("note: closed at 315")
   builds a private calibration set — per-zip appraisal-to-market ratios
   that correct every comp Jarvo quotes. Their trades make THEIR Jarvo
   more accurate than anyone else's could be. (Moat, again.)
3. **The devil's-advocate turn.** "Steelman the pass" — a mode where Jarvo
   argues AGAINST the deal it just presented. One prompt line; enormous
   credibility. Tools that only say yes get ignored by year two.
4. **Known-lag ledger.** HCAD ~months, FEMA map revisions, permit lag —
   spoken when material, in one line, not as a wall of caveats.

---

## 2. The secrets — non-obvious plays latent in data we already touch

### 2.1 THE TIME MACHINE (highest value, start immediately)
HCAD only publishes the CURRENT snapshot. Nobody can query "what did this
lot appraise for 14 months ago" from the public API. **But we can archive.**
A monthly cron sweeps tracked zips (or the whole county — it's ~1.7M rows
of attributes, small in R2) and stores dated snapshots. Within 6 months
Jarvo has a PROPRIETARY temporal dataset: per-parcel value velocity,
ownership churn per block, exemption changes (homestead dropped = owner
moved out = seller signal). Every month it runs, the moat deepens, and it
costs almost nothing. **This is the single best secret: time is the one
dimension the public APIs don't sell, and it compounds.**

### 2.2 The LLC graph (entity resolution by mailbox)
We already saw it live: 1218 Yale (KIM BARBELL LLC) mails to 1216 Yale.
Owner names are noisy; MAILING ADDRESSES cluster them. Group parcels by
normalized mail address → operator portfolios regardless of LLC-per-deal
games. Unlocks: "who really owns this block," "which operators are
accumulating in Lindale Park," "this seller's LLC also owns the two lots
behind — pitch the package."

### 2.3 The assemblage detector
Adjacent parcels + same owner/mail-cluster = assemblage in progress
(someone's building toward a project — get there first or sell to them).
Inverse: adjacent parcels with DIFFERENT tired owners (both absentee, both
20+ year holds) = an assemblage OPPORTUNITY Jarvo can propose: "these two
lots together clear the 6-unit Chapter 42 threshold — separately they don't."
That is a deal that literally does not exist without the tool.

### 2.4 The teardown index
`bld_value / total_appraised_val < 0.15` + urban location + no historic
overlay = land trading as a house. Score every parcel in a tracked area
nightly; the radar stops showing what SOLD and starts showing what SHOULD
sell. ("Three teardown-grade lots on this block, two absentee, one
delinquent — want the owners?")

### 2.5 Deed-velocity heat (block momentum)
new_owner_date density per block face, trailing 24 months, from data we
already pull. Where velocity doubles, developers have arrived; where it's
zero for a decade with high teardown scores, it's untouched — both are
signals, and the ground layer can RENDER momentum as warmth.

### 2.6 Exemption-drop signal (needs Time Machine)
Homestead exemption present last year, gone this year → owner moved but
kept the house → landlord-by-accident or pre-sale. Among the strongest
motivated-seller signals that exists, and only visible with snapshots.

---

## 2.7 THE GARZA LAYER — expert knowledge capture (decided 2026-07-04)

The human moat: a veteran's tacit knowledge, captured by voice, growing from
zero. Architecture (NOT fine-tuning — retrieval with attribution):

1. **Capture in-workflow:** passive ("want me to keep that as one of your
   rules?") when Garza drops a heuristic during normal use + active "Garza
   mode" where Jarvo interviews him Socratically about the parcel on screen.
2. **Distill to atoms:** post-session, Claude extracts {claim, scope, type
   (rule/red-flag/contact/war-story), date, source-session}; each read back
   to Garza BY VOICE for confirmation before entering the base.
3. **Store retrievable:** D1 + Vectorize; top-k atoms relevant to the
   current parcel/question injected per turn. Grows unbounded, costs flat.
4. **Attribution sacred:** always "Garza's rule here is…" — never blended
   with county data; disagreements between Garza and data spoken out loud.
5. **Contradiction flags** (new vs old atom → reconcile, never silent
   overwrite) + **dated framing** for stale unreviewed rules.
6. **Scoreboard:** log when atoms influence verdicts + deal outcomes → his
   hit rate becomes measurable; his best rules become provable.

**Elicitation design (decided): natural surface, engineered underneath.**
Experts can't enumerate rules but can't NOT correct mistakes — so Garza mode
is an apprentice, not a questionnaire. Four rotating techniques, invisible:
(1) CRITIQUE BAIT — Jarvo analyzes the parcel first, then "what did I miss?"
(the workhorse; corrections = rules the data lacks); (2) CONTRAST PAIRS —
"two identical-on-paper lots, is one better?" forces tacit discriminations;
(3) WAR STORIES — "worst deal near here?", never interrupted, distilled
afterward (one story ≈ five rules); (4) ANOMALY PROBES — when live data
looks weird, ask him why. Conversational law: one question at a time, follow
tangents, 15-min ride-along cap, card readbacks BATCHED at session end.
Gap-driven over time: the KB knows its thin spots (e.g. nothing on Second
Ward) and leans in when a deal lands there.

Dangers avoided by this design: opinion/data blur (attribution), fossilized
weights (no fine-tuning), unbounded prompts (retrieval), bad-take permanence
(atoms are editable/deletable rows). Human note: position as legacy, get his
buy-in explicitly. Build slot: alongside #7 (buy-box learning) — same
retrieval infrastructure serves both.

## 3. Scaling a team — from tool to operating system

The shift: individual Q&A → shared institutional memory + division of labor.

1. **Named users.** `?u=fernando` on the WS URL → sessions, notes, and
   briefings attributed. "Good morning" becomes personal: YOUR leads, YOUR
   follow-ups, what teammates did yesterday on shared targets.
2. **Voice task handoff.** "Have Abe run title on this one" → CRM note +
   assignment + it shows in Abe's next briefing. The CRM already has the
   bones; Jarvo becomes the dispatcher.
3. **The nightly digest.** Cron → one spoken-style summary note in the CRM
   + push: "Two fresh transfers in your tracked zips, one watched LLC
   bought again on Fulton, 1133 Adele's owner went delinquent." Five
   bullets, every morning, before coffee. **Ritual = dependence.**
4. **Saved areas** (the empty CRM table): the day the team draws their farm
   areas, every sweep/score/brief keys off them. Nudge them to draw.
5. **Accountability queries.** "Which hot leads haven't been touched in two
   weeks?" — leads + notes timestamps answer it today; it just needs a tool.

## 4. Should it know the Houston market? Should it predict?

**Market awareness — yes, narrow and sourced:**
- Permits + replats + deed velocity = ground-truth momentum (better than
  news; it IS the news, earlier).
- TxDOT project map + city CIP/drainage bonds: infrastructure futures that
  reprice dirt (flood-bond drainage projects literally move parcels out of
  effective flood risk before FEMA redraws).
- Rates/macro: skip. Commentary without an edge dilutes trust. Jarvo's
  brand is: knows Harris County dirt cold, doesn't cosplay CNBC.

**Prediction — do the honest kind:**
- **Sell-propensity score** (absentee + hold length + delinquency +
  exemption-drop + teardown ratio + block velocity): a RANKING, not an
  oracle — "call these 20 owners first." Defensible, testable, and its hit
  rate is measurable against the team's own outcomes.
- **Value trajectory per micro-area** from Time Machine deltas: "this
  pocket's land values compounded 11%/yr for 3 years while the county did
  4%" — descriptive statistics spoken plainly, not "prices will rise."
- Never predict a specific parcel's future price. Rank, contextualize,
  show receipts. That discipline is WHY the team will believe the ranks.

## 5. Build order (dependence per unit effort)

| # | Build | Why first |
|---|---|---|
| 1 | ✅ Nightly digest cron + push notifications (2026-07-04, see ROADMAP.md) | Flips pull→push; creates the daily ritual |
| 2 | ✅ Time Machine snapshots (2026-07-04; KV interim — USER: enable R2 in dashboard) | Compounds from day one; every month waited is moat lost |
| 3 | ✅ Verdict tool (2026-07-04, see ROADMAP.md) | Collapses the platform into one magic sentence |
| 4 | ✅ Tax delinquency connect (2026-07-04 via LGBS tax-sale API, see ROADMAP.md) | Best motivated-seller signal available today |
| 5 | ✅ LLC graph + assemblage detector (2026-07-04, see ROADMAP.md) | Deals that don't exist without Jarvo |
| 6 | ✅ KV cache + latency logs + named users (2026-07-04; Sentry needs a DSN from you) | Team-scale hygiene |
| 7 | ✅ Buy-box learning + closed-price hooks (2026-07-04; calibration fills as the team dictates closes) | The unreplicatable moat |
| 8 | Multiplayer constellation | The shared war room |
| 9 | 🟡 Persona pass ✅ 2026-07-04; flood water render + barge-in open (need eyes/ears to verify) | Polish that sells |

**Standing gates before wide rollout:** rotate chat-exposed secrets, enable
HVI_SHARED_SECRET, delete the 505 Westcott test lead, phone-verify audio.

---

*The one-sentence thesis: every competitor can call the same APIs — the
moat is the accumulating layers only this team generates (their snapshots,
their closed prices, their decisions, their areas), compounding monthly,
speaking in one trusted voice that calls THEM when the dirt moves.*
