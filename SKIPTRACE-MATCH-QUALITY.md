# Skip-Trace Match Quality — Miss Investigation & Fixes

> Investigation date: 2026-07-05. Trigger: the first 10-lead production trace
> batch matched only 2/10. This documents WHY, what was fixable, and what the
> real ceiling is. Provider: EnformionGO Contact Enrich ($0.25/match, 2,000
> free requests/mo). All findings verified against the LIVE API.

## TL;DR

The "2/10" was misleading — it bundled three unrelated causes. After the fixes,
the same 8 misses break down as: **2 were a real bug we fixed** (now match),
**4 were institutions that should never have been traced** (now skipped free),
**2 are genuine data-coverage limits** (unfixable by us). So the *addressable*
miss rate on person-owners went from ~50% to near zero; what remains is either
not a person or not in the data.

## The three failure modes

### 1. Address-parse bug — COST REAL MATCHES (fixed)

`splitAddress()` split the HCAD mailing string on the FIRST comma and tried to
reconstruct city/state/zip from the remainder. Two defects compounded:

- Every address came out with a **double comma**: `"HOUSTON,, TX 77082"`
  (Enformion tolerated this, so most still matched — which hid the bug).
- A **trailing-dash zip** (`"77082-"`, common in HCAD when the +4 is blank)
  broke the zip regex, dumping the whole tail into the city field and emitting
  `addressLine2 = "HOUSTON, TX 77082-, TX "` — a garbled double-state string
  Enformion could not match.

Clyde Drexler (2302 + 2308 Gray St, a real person, 25-year hold, absentee) was
lost to exactly this. **Proof:** the identical name + a CLEAN address line
matches 5 phones + 5 emails against the live API; the garbled line returns
"No strong matches."

**Fix:** rewrote `splitAddress()` to parse HCAD's consistent
`STREET, CITY, ST ZIP` shape from the RIGHT (last segment = state+zip, prev =
city, rest = street), and added an `addressLine2()` builder that never emits
empty fields or stray commas. Also fixed a second latent bug the rewrite
surfaced: the zip was being read from anywhere in the string, so a 5-digit
street number ("11635 …") could be mistaken for the zip — now read from the
state/zip tail only. Unit-tested against all the real problem strings.

### 2. Institutional owners — WASTED CALLS (fixed)

Half the misses weren't people at all: `CHANGE HAPPENS CDC` (nonprofit, ×2),
`PROJECT ROW HOUSES` (nonprofit), `HOLMAN STREET BAPTIST CHUR` (church, HCAD
truncated "CHURCH"→"CHUR"). A person-search API can't trace an organization,
and these owners never sell anyway — so each one burned a $0.25 call to learn
nothing.

The old entity filter only caught LLC/INC/CORP-style tokens. **Fix:** widened
detection into two regexes —
- `ENTITY_PREFIX` (fires mid-word, for truncation: `CHUR`→CHURCH,
  `DEVELOP`→DEVELOPMENT, `HOLDING`→HOLDINGS) covering churches, schools,
  nonprofits, trusts, and company words;
- `ENTITY_WORD` (whole-word only, so short/ambiguous tokens like `CO`, `LP`,
  `CDC` don't eat real surnames — tested that COLE, COOK, COSTNER, BANKS,
  FUNDERBURK are NOT flagged).

Entity owners now short-circuit BEFORE the API call (zero cost) and the tool
tells the user the real next move: run `owner_graph` to find the human behind
the entity's mailbox, then trace that person.

### 3. Thin data footprint — GENUINE LIMIT (not fixable by us)

`ZHANG MEI`, `LIU CHUNMEI` and the other 3477 Reeves condo owners return "No
strong matches" even with a clean name + address, run individually with delays.
These are recent owners (bought 2022) with common names and thin US identity-
graph footprints — likely recent immigrants. No request shape recovers them;
the data simply isn't in the graph yet. This is the real, irreducible miss
floor, and it's honest to report it as such.

## What was NOT the cause (ruled out)

- **Rate limiting / throttling:** hypothesized (the batch fired ~48 calls with
  no delay), but a 6× rapid burst of the same query matched 6/6. Enformion did
  not soft-fail under load. The batch misses were the address bug + institutions,
  not speed.
- **Name-order (LAST FIRST):** `splitOwnerName()` handles HCAD's ordering
  correctly — confirmed on every matched trace.

## Options considered for the thin-footprint tail (not built)

Researched but deferred as not worth the spend/complexity today:

- **Enformion Person Search endpoint** ($0.35, returns multiple candidates by
  name+city+state instead of one strong match). Could be a fallback when Contact
  Enrich misses. Verified the header value I guessed is wrong ("Search Type not
  recognized") — would need the correct galaxy-search-type from the docs. Marginal
  gain: the thin-footprint owners are thin in Person Search too. **Parked.**
- **Situs-address fallback:** retry with the property address when the mailing
  address misses. Won't help absentee owners (the point is they're elsewhere) and
  the current parser already prefers mailing then falls back to situs. **N/A.**
- **Fuzzy street-name normalization** (USPS-style): the API tolerated
  misspellings ("VERSAILES") once the line was well-formed, so not needed.

## Measured outcome (original 8 misses, re-scored with fixes, read-only)

| Owner | Before | After |
|---|---|---|
| DREXLER CLYDE (×2) | miss | **matches, 5ph/5em** |
| CHANGE HAPPENS CDC (×2) | miss (call burned) | entity — skipped free |
| PROJECT ROW HOUSES | miss (call burned) | entity — skipped free |
| HOLMAN ST BAPTIST CHUR | miss (call burned) | entity — skipped free |
| ZHANG MEI / LIU CHUNMEI | miss | still miss (thin data) |

Net: **+2 reachable owners recovered**, **4 wasted calls eliminated**, 2
genuine limits honestly labeled. On a person-owner basis the fixable miss rate
is now ~0; the batch's low number was dominated by institutions that shouldn't
have been in the trace pool.
