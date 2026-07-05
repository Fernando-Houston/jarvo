// HVI gateway on Cloudflare Workers: one Durable Object per WebSocket
// session, reusing the Node gateway's Session (brains, tools, providers —
// all fetch/WebSocket-based) unchanged via the WsLike adapter.
//
// Also the nightly brain: a cron trigger sweeps the pipeline for the
// overnight digest (tools/digest.ts), stores it in KV, and fans it out as
// Web Push notifications (webpush.ts). HTTP routes handle push subscription
// management and digest reads.

import { Session, type WsLike } from "../../gateway/src/session";
import type { ParcelVisual } from "@hvi/shared";
import { runNightlyDigest, getLatestDigest, type DigestStore } from "../../gateway/src/tools/digest";
import { listLeads, LEAD_STATUSES } from "../../gateway/src/tools/crm";
import { distillBuyBox, getBuyBox } from "../../gateway/src/brain/buybox";
import { sendPush, type PushSubscription, type VapidConfig } from "./webpush";
import {
  kvSnapshotStore,
  r2SnapshotStore,
  newSnapshotState,
  snapshotChunk,
  type SnapshotStore,
  type SnapshotState,
} from "./snapshot";
import {
  latestSnapshotMonth,
  propensityChunk,
  type PropensityCandidate,
  type PropensityState,
} from "./propensity";

type Env = {
  SESSION: DurableObjectNamespace;
  SNAPSHOT: DurableObjectNamespace;
  /** The shared war room: one DO for the whole team's live map feed. */
  ROOM: DurableObjectNamespace;
  /** Propensity engine: scores the R2 snapshot into per-zip hot lists. */
  PROPENSITY: DurableObjectNamespace;
  HVI_KV: KVNamespace;
  /** R2 home of the Time Machine (KV was the pre-R2 interim). */
  SNAPSHOTS?: R2Bucket;
  HVI_SHARED_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL_ID?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  HVI_CRM_EMAIL?: string;
  HVI_CRM_PASSWORD?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Skip-trace provider (contact engine). None set = clearly-labeled MOCK
   *  provider, which only ever writes to the 505 Westcott test lead. */
  SKIPTRACE_PROVIDER?: string;
  SKIPTRACE_BATCHDATA_API_KEY?: string;
  SKIPTRACE_ENFORMION_AP_NAME?: string;
  SKIPTRACE_ENFORMION_AP_PASSWORD?: string;
};

/** Gateway code reads process.env (Node style); mirror the Worker env into
 *  it once per isolate. nodejs_compat provides the process global. The KV
 *  binding rides along on globalThis so gateway tools (digest store, the
 *  team-warm kvcache) can reach it; put() forwards TTL options. */
function applyEnv(env: Env) {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") process.env[k] = v;
  }
  const bridge = {
    get: (k: string) => env.HVI_KV.get(k),
    put: (k: string, v: string, opts?: { expirationTtl?: number }) => env.HVI_KV.put(k, v, opts),
  };
  (globalThis as { __hviKv?: DigestStore }).__hviKv = bridge;
}

function vapidConfig(env: Env): VapidConfig | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKeyPkcs8: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT ?? "mailto:contact@houstonlandguy.com",
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function subKey(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return (
    "push:sub:" +
    [...new Uint8Array(hash).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/** Deliver a notification to every stored subscription; prune dead ones. */
async function pushAll(
  env: Env,
  payload: { title: string; body: string; url: string; tag?: string }
): Promise<{ sent: number; gone: number; failed: number }> {
  const vapid = vapidConfig(env);
  const out = { sent: 0, gone: 0, failed: 0 };
  if (!vapid) return out;
  let cursor: string | undefined;
  do {
    const page = await env.HVI_KV.list({ prefix: "push:sub:", cursor });
    for (const key of page.keys) {
      const raw = await env.HVI_KV.get(key.name);
      if (!raw) continue;
      try {
        const res = await sendPush(JSON.parse(raw) as PushSubscription, payload, vapid);
        if (res.ok) out.sent++;
        else if (res.gone) {
          await env.HVI_KV.delete(key.name);
          out.gone++;
        } else out.failed++;
      } catch {
        out.failed++;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Every zip the pipeline touches — the Time Machine's tracked areas. */
async function trackedZips(): Promise<string[]> {
  const leads = await listLeads([...LEAD_STATUSES], 500);
  const zips = new Set<string>();
  for (const l of leads) {
    const m = l.address?.match(/\b(77\d{3})\b/);
    if (m) zips.add(m[1]);
  }
  return [...zips].sort();
}

async function runDigestAndPush(env: Env) {
  const digest = await runNightlyDigest();
  const delivery = await pushAll(env, {
    title: "Jarvo — overnight digest",
    body: digest.headline,
    url: "https://jarvo.pages.dev/",
    tag: "jarvo-digest",
  });
  console.log(
    `[digest] ${digest.stats.freshTransfers} fresh transfers across ${digest.stats.areasSwept} areas; push sent=${delivery.sent} gone=${delivery.gone} failed=${delivery.failed}`
  );
  return { digest, delivery };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const authorized = !env.HVI_SHARED_SECRET || url.searchParams.get("token") === env.HVI_SHARED_SECRET;

    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!authorized) return new Response("unauthorized", { status: 401 });
      // /room = the team's shared map feed (one DO for everyone);
      // anything else = a private voice session (fresh DO per connection).
      if (url.pathname === "/room") {
        return env.ROOM.get(env.ROOM.idFromName("team")).fetch(req);
      }
      const id = env.SESSION.newUniqueId();
      return env.SESSION.get(id).fetch(req);
    }

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ── Push + digest HTTP API (same-token guard as the WS where it matters) ──
    if (url.pathname === "/push/vapid") {
      return env.VAPID_PUBLIC_KEY
        ? json({ publicKey: env.VAPID_PUBLIC_KEY })
        : json({ error: "push not configured" }, 503);
    }
    if (url.pathname === "/push/subscribe" && req.method === "POST") {
      let sub: PushSubscription;
      try {
        sub = (await req.json()) as PushSubscription;
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      if (!sub?.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys?.auth) {
        return json({ error: "not a push subscription" }, 400);
      }
      await env.HVI_KV.put(await subKey(sub.endpoint), JSON.stringify(sub));
      return json({ ok: true }, 201);
    }
    if (url.pathname === "/push/unsubscribe" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { endpoint?: string } | null;
      if (!body?.endpoint) return json({ error: "endpoint required" }, 400);
      await env.HVI_KV.delete(await subKey(body.endpoint));
      return json({ ok: true });
    }
    if (url.pathname === "/digest") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      applyEnv(env);
      return json((await getLatestDigest()) ?? { error: "no digest yet" });
    }
    if (url.pathname === "/digest/run" && req.method === "POST") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      applyEnv(env);
      const { digest, delivery } = await runDigestAndPush(env);
      return json({ digest, delivery });
    }
    if (url.pathname === "/buybox") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      applyEnv(env);
      return json((await getBuyBox()) ?? { error: "no buy-box yet" });
    }
    if (url.pathname === "/buybox/run" && req.method === "POST") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      applyEnv(env);
      try {
        const bb = await distillBuyBox();
        return json(bb, "skipped" in bb ? 503 : 200);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    if (url.pathname === "/propensity/run" && req.method === "POST") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      return env.PROPENSITY.get(env.PROPENSITY.idFromName("global")).fetch(
        new Request("https://propensity/start", { method: "POST" })
      );
    }
    if (url.pathname === "/propensity/status") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      return env.PROPENSITY.get(env.PROPENSITY.idFromName("global")).fetch(
        new Request("https://propensity/status")
      );
    }
    if (url.pathname === "/snapshot/run" && req.method === "POST") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      const scope = url.searchParams.get("scope") === "zips" ? "zips" : "county";
      return env.SNAPSHOT.get(env.SNAPSHOT.idFromName("global")).fetch(
        new Request(`https://snapshot/start?scope=${scope}`, { method: "POST" })
      );
    }
    if (url.pathname === "/snapshot/status") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      return env.SNAPSHOT.get(env.SNAPSHOT.idFromName("global")).fetch(
        new Request("https://snapshot/status")
      );
    }
    // One-time KV→R2 migration of the pre-R2 snapshot parts. Budgeted per
    // call (get+put+delete each); loop until remaining=0.
    if (url.pathname === "/snapshot/migrate" && req.method === "POST") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      if (!env.SNAPSHOTS) return json({ error: "R2 binding missing" }, 503);
      // KV list is eventually consistent — deleted keys linger in listings
      // for a while, coming back as null gets. Skip those (cheap) and spend
      // the real budget (put+delete pairs) only on keys that still hold data.
      const page = await env.HVI_KV.list({ prefix: "snap:v1:", limit: 1000 });
      let migrated = 0;
      let stale = 0;
      let ops = 1;
      for (const k of page.keys) {
        if (ops >= 40) break;
        const { value, metadata } = await env.HVI_KV.getWithMetadata(k.name, "arrayBuffer");
        ops++;
        if (!value) {
          stale++;
          continue;
        }
        const custom: Record<string, string> = {};
        for (const [mk, mv] of Object.entries((metadata as Record<string, unknown>) ?? {})) {
          custom[mk] = String(mv);
        }
        await env.SNAPSHOTS.put(k.name, value, { customMetadata: custom });
        await env.HVI_KV.delete(k.name);
        ops += 2;
        migrated++;
      }
      return json({ migrated, staleListed: stale, listed: page.keys.length });
    }

    return new Response("HVI gateway: WebSocket endpoint", { status: 200, headers: CORS });
  },

  // The overnight brain. Two schedules:
  //   0 12 * * *  — nightly digest + push (7am Houston CDT / 6am CST)
  //   0 8 1 * *   — monthly Time Machine snapshot (3am CDT on the 1st)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    applyEnv(env);
    if (event.cron === "0 8 1 * *") {
      ctx.waitUntil(
        env.SNAPSHOT.get(env.SNAPSHOT.idFromName("global"))
          .fetch(new Request("https://snapshot/start", { method: "POST" }))
          .then((r) => r.text())
          .then((t) => console.log("[snapshot] monthly start:", t))
          .catch((err) => console.error("[snapshot] monthly start failed:", err))
      );
      return;
    }
    ctx.waitUntil(
      runDigestAndPush(env).catch((err) => console.error("[digest] nightly run failed:", err))
    );
    // The buy-box re-distills on the same nightly beat — yesterday's saves,
    // passes, and notes become tomorrow morning's pre-sorting instinct.
    ctx.waitUntil(
      distillBuyBox()
        .then((bb) =>
          console.log(
            "skipped" in bb
              ? `[buybox] skipped: ${bb.skipped}`
              : `[buybox] updated (${bb.evidence.leads} leads, ${bb.evidence.notes} notes, ${bb.evidence.closedPrices} closed prices)`
          )
        )
        .catch((err) => console.error("[buybox] distill failed:", err))
    );
  },
};

type TeamEvent = { type: "team_visual"; user: string | null; at: number; visual: ParcelVisual };

/** The shared war room: every teammate's client keeps a socket here; every
 *  focus parcel any session pulls up is broadcast live and kept in a 24h
 *  backlog so the morning desk map starts where the evening drive-by ended.
 *  Hibernation API — the DO sleeps between events, costs nothing idle. */
export class HviRoomDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.state.acceptWebSocket(server);
      // Backfill: replay the last day's shared parcels (oldest first) so a
      // fresh device inherits the team's map before live events arrive.
      const backlog = ((await this.state.storage.get<TeamEvent[]>("events")) ?? []).filter(
        (e) => Date.now() - e.at < 24 * 3600_000
      );
      for (const e of backlog) {
        try {
          server.send(JSON.stringify(e));
        } catch {
          /* client vanished mid-backfill */
        }
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/publish" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { user?: string | null; visual?: ParcelVisual } | null;
      if (!body?.visual?.hcadAccount) return json({ error: "bad publish" }, 400);
      const event: TeamEvent = {
        type: "team_visual",
        user: body.user ?? null,
        at: Date.now(),
        visual: body.visual,
      };
      const events = ((await this.state.storage.get<TeamEvent[]>("events")) ?? [])
        .filter((e) => e.visual.hcadAccount !== event.visual.hcadAccount) // newest wins per parcel
        .slice(-29);
      events.push(event);
      await this.state.storage.put("events", events);
      const frame = JSON.stringify(event);
      let delivered = 0;
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(frame);
          delivered++;
        } catch {
          /* dead socket — hibernation reaps it */
        }
      }
      return json({ ok: true, delivered, backlog: events.length });
    }
    return json({ error: "unknown room op" }, 404);
  }

  webSocketMessage(): void {
    /* clients only listen; nothing to handle */
  }
  webSocketClose(): void {}
  webSocketError(): void {}
}

/** The Time Machine's engine room: one global DO whose alarm chain works
 *  through the month's zip queue a subrequest-budget-sized chunk at a time.
 *  State lives in DO storage (strongly consistent); parts land in KV. */
export class HviSnapshotDO {
  private env: Env;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** R2 when bound (the real archive), KV as the pre-R2 fallback. */
  private store(): SnapshotStore {
    return this.env.SNAPSHOTS ? r2SnapshotStore(this.env.SNAPSHOTS) : kvSnapshotStore(this.env.HVI_KV);
  }

  async fetch(req: Request): Promise<Response> {
    applyEnv(this.env);
    const url = new URL(req.url);
    if (url.pathname === "/start" && req.method === "POST") {
      const month = new Date().toISOString().slice(0, 7);
      const existing = await this.state.storage.get<SnapshotState>("state");
      if (existing && existing.month === month && !existing.finishedAt) {
        return json({ ok: false, reason: "already running", state: existing });
      }
      // Default is the full county roll (time is the moat — archive all of
      // it); "zips" narrows to pipeline zips for ad-hoc reruns.
      let scopes: string[];
      if (url.searchParams.get("scope") === "zips") {
        try {
          scopes = await trackedZips();
        } catch (err) {
          return json({ ok: false, reason: `CRM zip scan failed: ${err instanceof Error ? err.message : err}` }, 500);
        }
        if (!scopes.length) return json({ ok: false, reason: "no tracked zips in the pipeline" }, 409);
      } else {
        scopes = ["county"];
      }
      const state = newSnapshotState(month, scopes);
      await this.state.storage.put("state", state);
      await this.state.storage.setAlarm(Date.now() + 1000);
      return json({ ok: true, month, scopes, store: this.env.SNAPSHOTS ? "r2" : "kv" });
    }
    if (url.pathname === "/status") {
      const state = await this.state.storage.get<SnapshotState>("state");
      return json(state ?? { neverRun: true });
    }
    return json({ error: "unknown snapshot op" }, 404);
  }

  async alarm(): Promise<void> {
    applyEnv(this.env);
    let state = await this.state.storage.get<SnapshotState>("state");
    if (!state || state.finishedAt) return;
    state = await snapshotChunk(this.store(), state);
    await this.state.storage.put("state", state);
    if (!state.finishedAt) {
      await this.state.storage.setAlarm(Date.now() + 4000);
    } else {
      const rows = state.done.reduce((n, d) => n + d.rows, 0);
      console.log(
        `[snapshot] ${state.month} complete: ${state.done.length} zips, ${rows} rows, ${state.errors.length} errors`
      );
      // Fresh archive → fresh scores: kick the propensity engine over the
      // month that just landed. Best-effort; a manual /propensity/run exists.
      this.state.waitUntil(
        this.env.PROPENSITY.get(this.env.PROPENSITY.idFromName("global"))
          .fetch(new Request("https://propensity/start", { method: "POST" }))
          .then((r) => r.text())
          .then((t) => console.log("[propensity] post-snapshot start:", t))
          .catch((err) => console.error("[propensity] post-snapshot start failed:", err))
      );
    }
  }
}

/** Propensity engine v1: an alarm chain over the latest R2 snapshot month.
 *  Scores every tracked-zip row with the shared transparent weighted sum
 *  and publishes the top N per zip to KV for hot_list and the digest. */
export class HviPropensityDO {
  private env: Env;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    applyEnv(this.env);
    const url = new URL(req.url);
    if (url.pathname === "/start" && req.method === "POST") {
      if (!this.env.SNAPSHOTS) return json({ ok: false, reason: "R2 binding missing" }, 503);
      const existing = await this.state.storage.get<PropensityState>("state");
      if (existing && !existing.finishedAt) {
        return json({ ok: false, reason: "already running", state: existing });
      }
      let zips: string[];
      try {
        zips = await trackedZips();
      } catch (err) {
        return json({ ok: false, reason: `CRM zip scan failed: ${err instanceof Error ? err.message : err}` }, 500);
      }
      if (!zips.length) return json({ ok: false, reason: "no tracked zips in the pipeline" }, 409);
      const latest = await latestSnapshotMonth(this.env.SNAPSHOTS);
      if (!latest) return json({ ok: false, reason: "no snapshot months in R2 yet" }, 409);
      // Clear the previous run's per-zip tops before rescoring.
      const old = await this.state.storage.list({ prefix: "top:" });
      for (const k of old.keys()) await this.state.storage.delete(k);
      const state: PropensityState = {
        month: latest.month,
        queue: latest.keys.sort(),
        partsTotal: latest.keys.length,
        zips,
        rowsScanned: 0,
        kept: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        errors: [],
      };
      await this.state.storage.put("state", state);
      await this.state.storage.setAlarm(Date.now() + 1000);
      return json({ ok: true, month: latest.month, parts: latest.keys.length, zips: zips.length });
    }
    if (url.pathname === "/status") {
      const state = await this.state.storage.get<PropensityState>("state");
      return json(state ?? { neverRun: true });
    }
    return json({ error: "unknown propensity op" }, 404);
  }

  async alarm(): Promise<void> {
    applyEnv(this.env);
    let state = await this.state.storage.get<PropensityState>("state");
    if (!state || state.finishedAt || !this.env.SNAPSHOTS) return;
    const zipSet = new Set(state.zips);
    state = await propensityChunk(
      this.env.SNAPSHOTS,
      state,
      zipSet,
      async (zip) => (await this.state.storage.get<PropensityCandidate[]>(`top:${zip}`)) ?? [],
      (zip, list) => this.state.storage.put(`top:${zip}`, list)
    );
    await this.state.storage.put("state", state);
    if (!state.finishedAt) {
      await this.state.storage.setAlarm(Date.now() + 3000);
      return;
    }
    // Publish per-zip tops + a meta record to KV for the voice tools.
    const counts: Record<string, number> = {};
    for (const zip of state.zips) {
      const top = (await this.state.storage.get<PropensityCandidate[]>(`top:${zip}`)) ?? [];
      counts[zip] = top.length;
      await this.env.HVI_KV.put(`propensity:v1:${zip}`, JSON.stringify(top));
    }
    await this.env.HVI_KV.put(
      "propensity:meta:v1",
      JSON.stringify({
        month: state.month,
        generatedAt: state.finishedAt,
        rowsScanned: state.rowsScanned,
        kept: state.kept,
        zipCounts: counts,
        note: "scored from the monthly county archive; tax distress is layered on separately at radius scale",
      })
    );
    console.log(
      `[propensity] ${state.month} complete: ${state.rowsScanned} rows scanned, ${state.kept} kept across ${state.zips.length} zips, ${state.errors.length} errors`
    );
  }
}

export class HviSessionDO {
  private env: Env;
  private state: DurableObjectState;
  private session: Session | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // Hibernation API: webSocketMessage/Close run in fresh invocation contexts
  // where outbound I/O (the Deepgram socket!) works — addEventListener
  // handlers inherit the long-dead upgrade request's context and die with
  // "Network connection lost".
  /** Named user from the WS URL (?u=fernando), kept for reconnect-free reads
   *  within this DO's lifetime. */
  private user: string | null = null;

  async fetch(req: Request): Promise<Response> {
    applyEnv(this.env);
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    this.user = new URL(req.url).searchParams.get("u");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    await this.ensureSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Focus parcels already fanned out this session — repaints (flood tint,
   *  verdict chip...) shouldn't re-toast the whole team. */
  private shared = new Set<string>();

  private async ensureSession(ws: WebSocket): Promise<Session> {
    if (!this.session) {
      const wsLike: WsLike = {
        OPEN: 1,
        readyState: 1,
        send: (data) => {
          try {
            ws.send(data);
          } catch {
            /* socket already closed */
          }
          // Mirror session-context essentials into DO storage so they survive
          // hibernation (the Session object dies; the storage doesn't):
          // the pending document, and the parcel in focus (tools that pop
          // satellites re-emit the subject last, so the last parcel visual
          // is the focus). Cheap prefix sniff, JSON only on match.
          if (typeof data === "string" && data.startsWith('{"type":"visual"')) {
            try {
              const msg = JSON.parse(data) as {
                visual?: { kind?: string; filed?: boolean; hcadAccount?: string; address?: string | null };
              };
              if (msg.visual?.kind === "document") {
                this.state.waitUntil(
                  msg.visual.filed
                    ? this.state.storage.delete("pendingDoc")
                    : this.state.storage.put("pendingDoc", msg.visual)
                );
              } else if (msg.visual?.kind === "parcel" && msg.visual.hcadAccount) {
                this.state.waitUntil(
                  this.state.storage.put("lastFocus", {
                    hcadAccount: msg.visual.hcadAccount,
                    address: msg.visual.address ?? null,
                  })
                );
              }
            } catch {
              /* not our frame */
            }
          }
        },
      };
      // A reborn session inherits what was on the user's screen when the DO
      // slept: the pending draft and the parcel in focus.
      const [stored, lastFocus] = await Promise.all([
        this.state.storage.get<{
          docType: "letter" | "call_sheet" | "offer_summary";
          title: string;
          body: string;
          hcadAccount: string;
          address: string | null;
        }>("pendingDoc"),
        this.state.storage.get<{ hcadAccount: string; address: string | null }>("lastFocus"),
      ]);
      this.session = new Session(wsLike, {
        user: this.user,
        pendingDoc: stored ?? undefined,
        focus: lastFocus ?? undefined,
        onDocDiscard: () => this.state.waitUntil(this.state.storage.delete("pendingDoc")),
        onShare: (visual: ParcelVisual) => {
          if (this.shared.has(visual.hcadAccount)) return;
          this.shared.add(visual.hcadAccount);
          this.state.waitUntil(
            this.env.ROOM.get(this.env.ROOM.idFromName("team"))
              .fetch("https://room/publish", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user: this.user, visual }),
              })
              .then((r) => r.arrayBuffer())
              .catch(() => undefined) // the room is best-effort, never the session's problem
          );
        },
      });
    }
    return this.session;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    applyEnv(this.env);
    // The client's focus replay is the ONLY context signal on a quiet
    // connection (it emits no visuals for the outbound sniff to mirror) —
    // store it inbound so hibernation can't orphan "it"/"the owner".
    if (typeof message === "string" && message.startsWith('{"type":"focus"')) {
      try {
        const msg = JSON.parse(message) as { hcadAccount?: string };
        if (msg.hcadAccount) {
          this.state.waitUntil(
            this.state.storage.put("lastFocus", { hcadAccount: msg.hcadAccount, address: null })
          );
        }
      } catch {
        /* malformed — the session handler will ignore it too */
      }
    }
    const session = await this.ensureSession(ws);
    if (typeof message === "string") session.handleText(message);
    else session.handleAudio(new Uint8Array(message));
  }

  webSocketClose() {
    this.session?.destroy();
    this.session = null;
  }

  webSocketError() {
    this.session?.destroy();
    this.session = null;
  }
}
