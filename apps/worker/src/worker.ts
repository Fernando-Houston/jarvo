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
import { sendPush, type PushSubscription, type VapidConfig } from "./webpush";

type Env = {
  SESSION: DurableObjectNamespace;
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
 *  binding rides along on globalThis so gateway tools (digest) can reach it. */
function applyEnv(env: Env) {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") process.env[k] = v;
  }
  (globalThis as { __hviKv?: DigestStore }).__hviKv = {
    get: (k) => env.HVI_KV.get(k),
    put: (k, v) => env.HVI_KV.put(k, v),
  };
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

    return new Response("HVI gateway: WebSocket endpoint", { status: 200, headers: CORS });
  },

  // The nightly brain: 12:00 UTC = 7am Houston (CDT) / 6am (CST).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    applyEnv(env);
    ctx.waitUntil(
      runDigestAndPush(env).catch((err) => console.error("[digest] nightly run failed:", err))
    );
  },
};

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
  async fetch(req: Request): Promise<Response> {
    applyEnv(this.env);
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
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
      this.session = new Session(wsLike);
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
