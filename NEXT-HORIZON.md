# Jarvo — Next Horizon: The Contact Engine, Remaining Gaps, and What "One of a Kind" Takes

> Written 2026-07-05 after the intelligence build-out shipped (§5 items 1–8,
> documents, contacts, QA). This is the deep-dive for the NEXT session(s):
> how to go from 447 CRM phone numbers to reaching the owner of ANY of the
> county's ~1.55M parcels, every other gap found in a full platform audit,
> and the honest math + compliance reality underneath. Companion to
> ROADMAP.md (execution log) and INTELLIGENCE-ROADMAP.md (strategy).
> Research date for all pricing/rules: July 2026.

---

## 1. The Contact Engine — from 447 numbers to the whole county

### 1.1 The problem, stated honestly

Today's contact coverage is the team's own history: 447 leads with phones,
enriched one at a time (source "whitepages", the CRM's `phones` JSONB).
HCAD gives every parcel an owner NAME and a MAILING ADDRESS — never a phone
or email. So for 1.549M of 1.55M parcels, "reach the owner" means a letter.

The naive fix — bulk skip-trace the whole county — is wrong three ways:
- **Cost**: 1.55M records × $0.02–$0.15 = $31k–$232k, repeated as data goes
  stale (phones churn ~2%/month; a county-wide trace is ~30% wrong in a year).
- **Waste**: the team will never call 1.55M owners. They call maybe 50/week.
- **Compliance**: possessing numbers is easy; being ALLOWED to dial them is
  the hard part (see §1.5) — and mass-traced lists rot into TCPA exposure.

### 1.2 The right architecture: trace on intent, not inventory

**The funnel, with real numbers:**

```
1,549,000 parcels (county roll, archived monthly in R2)
   ~150,000 in tracked zips (pipeline zips today; saved areas later)
    ~15,000 scoring above the sell-propensity floor (§2)
     ~1,000 worth a trace this quarter (top-ranked + on-demand asks)
       ~200 actually dialed/mailed per month
```

Money and risk only attach at the fourth line. Two trigger paths:

**A. On-demand ("find me the owner's number") — the voice path.**
New tool `skip_trace(hcad_account)`:
1. Check CRM first (the 447 + everything traced before — never pay twice).
2. Call the provider API with owner name + mailing address (HCAD's two
   fields are exactly a skip-trace input). Single-lookup cost ~$0.07–$0.25.
3. **Write the result INTO THE CRM** in the exact `phones` JSONB shape the
   team already uses (number, source, confidence, accepted_at) — Jarvo's
   card, the call sheet DIAL section, and the CRM UI all light up at once.
4. Speak it: "Found two likely numbers, best confidence 0.9 — they're on
   the card." Requires the parcel to be saved as a lead first (a good
   forcing function: no orphan PII floating outside the CRM).

**B. Nightly wave — the propensity path.**
The digest cron already sweeps tracked areas. Add: each night, take the
top-N NEW parcels by sell-propensity score (§2) that aren't leads yet,
auto-create nothing — instead surface them in the digest ("12 new
high-propensity owners near your leads — say 'trace the top five'").
Human says the word; Jarvo saves leads + traces them in one motion.
Budget-capped (e.g. 300 traces/month = $21–$45/mo at bulk rates).

**Never**: silent mass enrichment. Every trace is either asked for by voice
or approved from a digest. That keeps cost, staleness, and compliance
anchored to actual intent.

### 1.3 Provider landscape (July 2026 pricing)

| Provider | Model | Price | Notes |
|---|---|---|---|
| Tracerfy | bulk, pay-per-hit | from ~$0.02/lead | cheapest tier; accuracy at the low end runs 50–65% |
| BatchData / BatchSkipTracing | bulk + API | ~$0.07–$0.18/record | the standard REI choice; API-first, LLC resolution + DNC-scrubbed tiers at the top |
| REISkip | pay-as-you-go | ~$0.10–$0.15/match | no minimums; charged on match |
| Enformion (EnformionGO, ex-Endato) | per-call person-search API | free trial; no minimums/contracts | best fit for the ON-DEMAND single-lookup path; pricing gated behind sales |
| Enterprise (IDI/Tracers/TLO tier) | contract | ~$0.02/record at 100k+/mo ($2k/mo floor) | only if the team 10×es |

**Recommendation:** provider-agnostic `providers/skiptrace.ts` behind one
interface (`trace(name, mailingAddress) → {phones[], emails[], confidence}`),
launch with ONE mid-tier API (BatchData or Enformion for per-call), measure
match quality against the team's call outcomes for a month, then negotiate.
The abstraction matters more than the pick — these vendors leapfrog yearly.

**Emails:** most skip-trace results include emails at no extra cost; the CRM
has no structured email column today. Next session: either add `emails`
JSONB to the CRM (Lovable-side change, needs the team) or store them in the
`phones`-adjacent `contact_info` text until the column exists. Decide before
building the write-back.

### 1.4 Quality: the feedback loop nobody else has

The CRM already stores per-number outcomes (`phone_1_status`, `bad_reason`,
`marked_bad_by`). Close the loop:
- After a tap-to-dial, Jarvo asks (or the caller says) "log that call —
  no answer" / "wrong number" / "talked to him" → `phone_status` updated by
  voice. Each call makes the dataset smarter.
- Per-provider hit-rate tracking: which vendor's numbers actually connect,
  by zip. After ~500 outcomes, Jarvo knows which provider to prefer WHERE.
  That calibration set — like closed prices — is unreplicable.

### 1.5 Compliance — the part that keeps this a business, not a lawsuit

2026 TCPA/DNC reality (verified this week; penalties $500–$1,500 PER CALL,
class actions up 95% year-over-year):

- **National DNC scrub every 31 days** for any marketing call list. Texas
  has its own state list; scrub both. Litigator-list scrubbing is cheap
  insurance the top-tier trace vendors bundle.
- **Manual, human-dialed calls** (which is what tap-to-call IS) don't need
  prior express written consent — but still must honor DNC lists and the
  8am–9pm local window.
- **Texting is the trap**: automated marketing texts need prior express
  written consent, full stop. Jarvo should NOT grow a texting feature
  without a consent workflow. Don't build it next session.
- **April 2026 opt-out rule** (in force now): any opt-out, by any
  reasonable means, honored within 10 business days across all channels.
  The CRM's internal DNC flag must propagate to Jarvo's card — a "DO NOT
  CONTACT" state that beats everything else on the display.
- **Reassigned Numbers Database** query before dialing = the safe harbor.
  Top-tier trace vendors sell results pre-checked; prefer that tier for
  anything the team will actually dial.

**Build requirement:** the `skip_trace` write-back stores `dnc: boolean` per
number; the card and call sheet render DNC numbers like bad numbers (visible,
never dialable); the DIAL section header carries the calling-hours line.
Letters (already built) are the zero-compliance-risk channel — the propensity
engine can drive mail volume with none of this friction.

---

## 2. The Prioritization Engine — what makes tracing 1,000 instead of 1.5M rational

Everything needed already exists or lands August 1:

| Signal | Status | Weight rationale |
|---|---|---|
| Absentee owner | ✅ live (mail ≠ situs) | classic motivated-seller marker |
| Hold length (new_owner_date) | ✅ live | 15+ years = low basis, life-event prone |
| Teardown ratio (bld/total < 15%) | ✅ live (teardown_radar) | land priced as a house |
| Tax distress (LGBS suit/auction) | ✅ live | the sharpest public signal |
| Assemblage adjacency | ✅ live (entity.ts) | 1+1>2 parcels rank above their parts |
| Buy-box similarity | ✅ live (nightly distill) | rank by resemblance to what the team SAVES |
| **Exemption drop** (homestead gone) | 🔒 unlocks Aug 1 (needs 2 snapshots) | owner moved out but kept it — top-3 signal |
| **Value velocity** (block momentum) | 🔒 unlocks Aug 1 | rising pockets rank higher |
| Code violations (see §3) | ❌ not connected | tired-owner proxy, free city data |
| Pre-foreclosure/probate (see §3) | ❌ not connected | strongest life-event signals |

**Build shape:** a nightly Worker job (same cron family) scores tracked-zip
parcels from the LATEST R2 snapshot (no HCAD hammering — the Time Machine
already holds all 62 fields), stores top-N per zip in KV, and:
- feeds the digest ("3 new parcels crossed the propensity floor near you"),
- feeds `teardown_radar`-style map pops via a `hot_list` tool,
- gates the auto-trace budget (§1.2B).
Score = transparent weighted sum, every component speakable ("it ranks 87:
absentee 22 years, building's 6% of value, and the block's velocity doubled").
**Never a black box** — that's the §4 objectivity rule applied to ranking.

---

## 3. Data gaps, ranked by unlock-per-effort

1. **Code violations** — City of Houston publishes Building Code Enforcement
   Violations (DON dataset) on data.houstontx.gov. Free, structured,
   address-keyed. A `violations` signal + card row is a day of work and is
   both a propensity input and a talking point ("city's been on them about
   the roof"). **Do this one first.**
2. **Building/demo permits** — Houston Permitting Center publishes open
   records; permits near a parcel = block momentum (who's building) and
   direct teardown confirmations (demo permits). Feeds §2 and the digest.
3. **Pre-foreclosure / trustee sales** — Harris County Clerk's foreclosure
   notices (first-Tuesday trustee sales). Public postings; scraping cadence
   monthly. Complements LGBS (tax) with mortgage distress.
4. **Probate filings** — Harris County Probate Courts records; estates are
   the classic motivated-seller pipeline (the 3106 Kirk case found one by
   accident via owner name "ESTATE OF"). Even a name-pattern signal
   (`/ESTATE OF|ESTATE$/` on the roll we ALREADY have) is a free instant win
   before real court integration.
5. **Replat filings** — the city PlatTracker folder (probe was parked
   2026-07-04); replats = developer intent, earlier than permits.
6. **MLS/sold prices** — the real gap behind "appraisal ≠ market". Needs a
   team member's HAR access (agent status) — a HUMAN unlock, not an API one.
   Until then, closed-price dictations remain the calibration set.
7. **Evictions (JP courts)** — tired-landlord signal; moderate scraping
   effort, high signal for small multifamily.
8. **TxDOT projects / HCFCD buyouts** — infrastructure futures; from the
   original roadmap, still valid, lower urgency.

Each connect follows the proven pattern: `tools/<source>.ts`, honest lag
note in every result, KV cache, rules trigger + Claude schema, card row.

---

## 4. Product gaps (found in the platform audit)

**Voice/consultation:**
- **Barge-in** (Deepgram Flux) and **flood-water render** — still parked for
  an eyes/ears session with Fernando.
- **Conversation memory across DO hibernation** — focus + pending doc now
  survive (fixed 2026-07-05), but the Claude brain's HISTORY does not: a
  15-minute-idle session resumes with context but not the conversation.
  Fix: persist trimmed history JSON in DO storage per turn (~small), seed on
  rebirth. Medium effort, big continuity win.
- **Call outcome capture** (§1.4) — "log that call: no answer" — closes the
  contact-quality loop. Small build, compounding value.
- **Digest personalization** — named users exist; digest is still team-wide.
  Per-user sections ("YOUR leads going cold") once saved areas/assignments
  arrive.
- **Voice task handoff** ("have Abe run title") — CRM assignment schema
  probe needed; do alongside named-user digest.
- **Garza layer** — D1 + Vectorize infra; blocked on Garza's buy-in
  (Fernando's move). The elicitation design is done (GARZA.md).
- **Semantic memory over notes** — same Vectorize infra; becomes worth it
  as note volume grows (memos + recaps are now generating volume daily).
- **Model routing** (Haiku pre-router) — cost/latency optimization; hold
  until voice-feel testing with the team, current latency is fine.

**UI:**
- Constellation chips clip at screen edges on phones (camera framing doesn't
  account for aspect) — needs eyeballs, parked.
- Document panel: inline text editing (today: re-dictate changes) — nice,
  not urgent.
- A "hot list" screen/tool for §2 rankings.

**Ops/hardening (the standing gates, still owed):**
- **Rotate chat-exposed secrets; set HVI_SHARED_SECRET** (+ token in the
  web build and the digest-banner fetch, already flagged in code).
- Sentry (needs a DSN) or at minimum a cron that alerts when digest/
  snapshot runs fail (currently they fail silently into wrangler logs).
- **County-API fragility is real** — HCAD went fully down during testing
  on 2026-07-05 (Jarvo degraded honestly). Add a tiny health probe to the
  digest run: if HCAD/LGBS/COH were unreachable overnight, the digest says
  so instead of reporting a suspiciously quiet night.
- LGBS is an undocumented API — a shape-change canary (one known-account
  check in the nightly run) turns silent breakage into a digest line.
- Workers plan: still free-tier; the county sweep + rooms + crons run fine
  today, but the $5/mo paid plan removes subrequest anxiety and unlocks
  Analytics Engine dashboards. Cheap insurance once the team's daily.

---

## 5. What actually makes this one of a kind

Anyone can buy skip traces and call HCAD. The compounding, non-purchasable
stack — each layer feeding the next:

1. **Time Machine** (monthly county archive) → exemption drops, velocity,
   churn — history the public APIs don't sell. Started 2026-07-04; deepens
   monthly on autopilot.
2. **The team's decisions** (buy-box distillation) → Jarvo pre-sorts like a
   partner. Live.
3. **Closed prices** (dictated) → per-zip appraisal-to-market calibration.
   Waiting on usage.
4. **Call outcomes** (§1.4) → contact-quality calibration per provider/zip.
   Next session.
5. **Garza's atoms** → judgment that isn't in any dataset. Blocked on human.
6. **Propensity + Contact Engine** (§1–2) → the county-scale funnel that
   turns all of the above into ranked, reachable owners at ~$50/mo of trace
   spend instead of $50k of list-buying.

The interaction layer (voice + morphing map + push + shared war room +
preview-gated documents) is the moat's delivery vehicle: it's why the data
gets USED daily, and daily use is what feeds layers 2–4.

---

## 6. Suggested next-session build order

1. ✅ **Skip-trace tool + provider abstraction + CRM write-back + DNC flags**
   (§1.2A, §1.5) — SHIPPED 2026-07-05 (see ROADMAP "CONTACT ENGINE v1").
   Runs on the MOCK provider until a real key lands (USER ACTION in ROADMAP).
2. ✅ **Propensity engine v1** (§2) — SHIPPED 2026-07-05 (ROADMAP
   "PROPENSITY ENGINE v1"): scores the R2 county archive (1.55M rows, ~7
   min, 0 errors) into per-zip KV rankings; `hot_list` tool; digest offer;
   estate-name signal live. Monthly rescore auto-runs after each snapshot.
3. ✅ **Code violations connect** (§3.1) — SHIPPED 2026-07-05 (ROADMAP "CODE
   VIOLATIONS CONNECT"). Caveat discovered: the city's public feed FROZE at
   Aug 2018 — it's enforcement history, spoken as such. Permits (§3.2) still
   open — probe whether Houston Permitting publishes anything fresher before
   building.
4. **Digest health canaries + failure alerts** (§4 ops). ← START HERE
5. **August 1**: exemption-drop + value-velocity analytics the day snapshot
   #2 lands (the Time Machine's first payoff).
6. Then: history-across-hibernation, task handoff, Garza infra when the
   human gates open.

**Human inputs to line up meanwhile (Fernando):** pick/approve a trace
provider account (BatchData or Enformion trial), decide the email-column
question with the Lovable CRM, secrets rotation + HVI_SHARED_SECRET,
HAR/MLS access question, Garza sit-down.

---

*Sources for pricing/compliance (July 2026):*
- [BatchData — skip tracing rankings & bulk pricing](https://batchdata.io/blog/best-skip-tracing-services-real-estate-investors-2026-rankings)
- [Tracerfy — bulk skip tracing at $0.02/lead](https://www.tracerfy.com/bulk-real-estate-skip-tracing)
- [REsimpli — 2026 skip-trace provider comparison](https://resimpli.com/blog/whats-the-best-skip-tracing-for-real-estate-investors-in-2026/)
- [Homesage — skip tracing data providers ranked 2026](https://homesage.ai/resources/blog/5-best-skip-tracing-data-providers-2026/)
- [EnformionGO (ex-Endato) — per-call person search API](https://go.enformion.com/pricing/)
- [TCPA compliance 2026 — rules, penalties, checklist](https://prospeo.io/s/tcpa-compliance)
- [Cold calling laws 2026](https://prospeo.io/s/cold-calling-laws)
- [DNC scrubbing & TCPA guide 2026](https://dialerguru.com/dnc-scrubber-tcpa-compliance-guide-2026/)
- [City of Houston code enforcement violations dataset](https://data.houstontx.gov/dataset/city-of-houston-building-code-enforcement-violations-don)
- [Houston Permitting Center open records](https://www.houstonpermittingcenter.org/open-records)
- [Harris County open data GIS](https://geo-harriscounty.opendata.arcgis.com/)
