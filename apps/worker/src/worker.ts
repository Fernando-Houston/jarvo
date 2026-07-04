// HVI gateway on Cloudflare Workers: one Durable Object per WebSocket
// session, reusing the Node gateway's Session (brains, tools, providers —
// all fetch/WebSocket-based) unchanged via the WsLike adapter.

import { Session, type WsLike } from "../../gateway/src/session";

type Env = {
  SESSION: DurableObjectNamespace;
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
};

/** Gateway code reads process.env (Node style); mirror the Worker env into
 *  it once per isolate. nodejs_compat provides the process global. */
function applyEnv(env: Env) {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") process.env[k] = v;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("HVI gateway: WebSocket endpoint", { status: 200 });
    }
    if (env.HVI_SHARED_SECRET) {
      const token = new URL(req.url).searchParams.get("token");
      if (token !== env.HVI_SHARED_SECRET) return new Response("unauthorized", { status: 401 });
    }
    // Fresh DO per connection = per-session isolation, matching Node's model.
    const id = env.SESSION.newUniqueId();
    return env.SESSION.get(id).fetch(req);
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
