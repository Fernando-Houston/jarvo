# Jarvo — Team Guide & Links

> One page for the whole team: where Jarvo lives, how to set it up on your
> phone, what to say to it, and where everything runs. Updated 2026-07-05.

## The app

| What | Link |
|---|---|
| **Jarvo (the app)** | https://jarvo.pages.dev |
| **Your personal link** (visit ONCE per device — it remembers you) | `https://jarvo.pages.dev/?u=yourname` e.g. `?u=fernando`, `?u=abe`, `?u=garza` |
| The CRM (Land Lead Hub) | your existing CRM, same login — Jarvo's saves, notes, memos and recaps land there |

## Phone setup (2 minutes, once per person)

1. On your phone, open **jarvo.pages.dev/?u=yourname** (pick your name — it's how your notes get signed and how teammates' maps credit you).
2. **iPhone:** Share → **Add to Home Screen** (you get the bull icon + launch screen; this step is REQUIRED for notifications on iOS). **Android:** Chrome offers "Install app".
3. Open the installed app, tap **alerts**, allow notifications → the 7am digest now reaches your phone.
4. Tap the mic and talk to it.

## Say it out loud (cheat sheet)

**Look things up**
- "What's 505 Westcott Street worth?" · "Who owns it?" · "How big is the lot?" · "What's the mailing address?"

**Screen a deal**
- "**Verdict** on 1218 Yale" — the go/no-go with receipts
- "Give me the **full picture**" — every layer, one answer
- "**Write me the deal memo**" — the considered write-up, filed on the lead

**Data layers**
- "Is it in the **floodplain**?" · "How many **townhomes** fit?" (Chapter 42) · "Any **restrictions**?" (historic/lot-size overlays) · "Pull **comps**" · "**Where is this**?" (bayous + freeways materialize)

**Radar sweeps** (map builds while it talks)
- "What's **changed hands** nearby?" · "Any **tax distress** around here?" · "What's **trading as dirt**?" (teardowns)

**Ownership intelligence**
- "Who **really** owns this?" (the mailbox trail beats LLC names) · "What **else** do they own?" · "Any **assemblage** play on this block?"

**Reach the owner**
- Pull up any lead and the card shows **REACH THE OWNER**: tap a number to dial, bad numbers shown struck-through so nobody redials a wrong number. Ask "what's the owner's number?" and Jarvo reads out the primary.
- "**Trace it**" / "skip trace the owner" — hunts down phone numbers + emails and files them on the lead. Checks the CRM first so we never pay for a number we already have; "trace it **again**" forces a fresh pull. (Live on EnformionGO.)
- "**Trace whoever's behind it**" — when the owner is an LLC, resolves the human operator from the mailbox trail and traces them (marked as inferred — verify on the call). Won't guess when the address is a registered-agent mail-drop.
- After a call: "**Log that call — no answer**" / "**wrong number**" / "**talked to them**" — updates the number on the lead so every call makes the data smarter. Wrong numbers never come up to dial again.
- Numbers on the **Do-Not-Call registry** show locked with "DO NOT CALL" — on the card and as DO-NOT-DIAL lines on call sheets. Calls are manual dial only, 8am–9pm. No texting, ever (TCPA).

**Hunt (who to chase next)**
- "**Hot list** for 77007" / "who's **most likely to sell** around here?" — the top-scored prospects in a zip, ranked monthly from the county archive (teardown-grade buildings, absentee, long holds, estates). Every score comes with its reasons.
- The overnight digest may offer "**trace the top 3?**" — nothing is saved or traced until you say yes.
- "Any **code violations**?" — the city's enforcement history on a parcel (chronic-headache signal; the public feed stops at Aug 2018, so it's history, not current status).

**Pipeline (the CRM, by voice)**
- "Good morning" / "briefing" — your hot + new leads pop onto the map
- "What's new **overnight**?" — the digest
- "Which leads are **going cold**?" — the accountability check
- "**Save it**" · "Save it and **mark it hot**" · "**Note:** seller sounds motivated" · "**Wrap up the session**" — recap notes on every pipeline lead discussed

**Map**
- **Tap any node to refocus** — instant and SILENT (it just pulls up the card; no talking). Want the spoken rundown? Tap **🔊 Tell me more** on the card, or just ask by voice.
- **Moving around**: one finger spins the map · **two fingers slide it** · **pinch zooms right where your fingers are** (desktop: scroll zooms at the cursor). "recenter" snaps everything back home.
- Nodes show their state at a glance: a green dot = in your pipeline, a ☎ = you have the owner's number, colored dots = verdict (green/yellow/red), amber glow = tax distress.
- "clear map" wipes it · teammates' parcels join your map automatically with a "◈ name · address" toast

**Do it by thumb (no voice needed)**
- The card has buttons: **Save lead · Mark hot · Trace · Verdict · Call sheet** — same as saying it out loud.
- After you tap a number to dial, the card shows **No answer / Wrong # / Talked** — one tap logs the call so the data keeps getting smarter.
- **🔊 voice / 🔇 quiet** toggle (bottom bar): mute Jarvo's voice for the office — you still get captions and everything works, just silent.
- **Tap the orb while it's talking to cut it off** (barge-in without the mic). And on the mic button: quick tap = listen; **press and hold = push-to-talk** (talk while held, release to send) — handy in a loud truck.

## What runs by itself

| When | What |
|---|---|
| Every day, 7:00 AM Houston | Overnight digest: fresh deeds + new tax distress near your leads → push notification + in-app banner |
| Every night (same beat) | Buy-box re-distilled from the team's own saves/passes/notes → sharpens Jarvo's judgment |
| 1st of each month, ~3 AM | Time Machine: full Harris County roll (≈1.55M parcels) archived to R2 — value history nobody else has |

## Admin & endpoints (Fernando)

Gateway base: `https://hvi-gateway.houstonlandguy.workers.dev`

| Endpoint | What |
|---|---|
| `GET /digest` | latest overnight digest (JSON) |
| `POST /digest/run` | run the digest now (+ push) |
| `GET /buybox` · `POST /buybox/run` | read / re-distill the buy-box |
| `GET /snapshot/status` · `POST /snapshot/run` | Time Machine status / manual sweep (`?scope=zips` narrows) |
| `GET /propensity/status` · `POST /propensity/run` | propensity engine status / rescore from the latest archive (auto-runs after each monthly snapshot) |
| `wss://…workers.dev` · `wss://…workers.dev/room` | the voice session · the team map feed |

> These are open until `HVI_SHARED_SECRET` is set; after that they take `?token=`.

## Code & infrastructure

| What | Where |
|---|---|
| Repo | https://github.com/Fernando-Houston/jarvo |
| Cloudflare dashboard | https://dash.cloudflare.com → Workers & Pages: `hvi-gateway`, `jarvo` · KV: `HVI_KV` · R2: `hvi-snapshots` |
| Live logs | `pnpm exec wrangler tail hvi-gateway` from `hvi/apps/worker` |
| Project state / handbook | `hvi/ROADMAP.md` (execution log) · `hvi/INTELLIGENCE-ROADMAP.md` (strategy) · `hvi/GARZA.md` (the knowledge-capture pitch) |

## Honesty rules Jarvo lives by (tell the team)

- Values are **HCAD appraisals**, not sale prices — it says so when it matters.
- Deed dates trail the courthouse by weeks-to-months — it tells you the real recorded month.
- Tax distress = suits/auctions from the county's collection firm — owners merely behind don't show.
- Verdicts and memos are **screens, not underwriting** — every number has a source you can ask for: *"says who?"* always gets a real answer.
