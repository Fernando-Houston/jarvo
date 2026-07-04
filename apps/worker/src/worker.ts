// HVI gateway on Cloudflare Workers: one Durable Object per WebSocket
// session, reusing the Node gateway's Session (brains, tools, providers —
// all fetch/WebSocket-based) unchanged via the WsLike adapter.
//
// Also the nightly brain: a cron trigger sweeps the pipeline for the
// overnight digest (tools/digest.ts), stores it in KV, and fans it out as
// Web Push notifications (webpush.ts). HTTP routes handle push subscription
// management and digest reads.

import { Session, type WsLike } from "../../gateway/src/session";
import { runNightlyDigest, getLatestDigest, type DigestStore } from "../../gateway/src/tools/digest";
import { listLeads, LEAD_STATUSES } from "../../gateway/src/tools/crm";
import { distillBuyBox, getBuyBox } from "../../gateway/src/brain/buybox";
import { sendPush, type PushSubscription, type VapidConfig } from "./webpush";
import {
  kvSnapshotStore,
  newSnapshotState,
  snapshotChunk,
  type SnapshotState,
} from "./snapshot";

type Env = {
  SESSION: DurableObjectNamespace;
  SNAPSHOT: DurableObjectNamespace;
  HVI_KV: KVNamespace;
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
      // Fresh DO per connection = per-session isolation, matching Node's model.
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
    if (url.pathname === "/snapshot/run" && req.method === "POST") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      return env.SNAPSHOT.get(env.SNAPSHOT.idFromName("global")).fetch(
        new Request("https://snapshot/start", { method: "POST" })
      );
    }
    if (url.pathname === "/snapshot/status") {
      if (!authorized) return json({ error: "unauthorized" }, 401);
      return env.SNAPSHOT.get(env.SNAPSHOT.idFromName("global")).fetch(
        new Request("https://snapshot/status")
      );
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

  async fetch(req: Request): Promise<Response> {
    applyEnv(this.env);
    const url = new URL(req.url);
    if (url.pathname === "/start" && req.method === "POST") {
      const month = new Date().toISOString().slice(0, 7);
      const existing = await this.state.storage.get<SnapshotState>("state");
      if (existing && existing.month === month && !existing.finishedAt) {
        return json({ ok: false, reason: "already running", state: existing });
      }
      let zips: string[];
      try {
        zips = await trackedZips();
      } catch (err) {
        return json({ ok: false, reason: `CRM zip scan failed: ${err instanceof Error ? err.message : err}` }, 500);
      }
      if (!zips.length) return json({ ok: false, reason: "no tracked zips in the pipeline" }, 409);
      const state = newSnapshotState(month, zips);
      await this.state.storage.put("state", state);
      await this.state.storage.setAlarm(Date.now() + 1000);
      return json({ ok: true, month, zips });
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
    state = await snapshotChunk(kvSnapshotStore(this.env.HVI_KV), state);
    await this.state.storage.put("state", state);
    if (!state.finishedAt) {
      await this.state.storage.setAlarm(Date.now() + 4000);
    } else {
      const rows = state.done.reduce((n, d) => n + d.rows, 0);
      console.log(
        `[snapshot] ${state.month} complete: ${state.done.length} zips, ${rows} rows, ${state.errors.length} errors`
      );
    }
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
    this.ensureSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private ensureSession(ws: WebSocket): Session {
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
        },
      };
      this.session = new Session(wsLike, { user: this.user });
    }
    return this.session;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    applyEnv(this.env);
    const session = this.ensureSession(ws);
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
