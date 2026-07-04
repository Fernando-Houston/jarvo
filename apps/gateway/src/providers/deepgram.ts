// Deepgram streaming STT over WebSocket (nova-3, linear16 PCM).
// NOTE: upgrade path to Deepgram Flux (eager end-of-turn) once we have a key
// to test against — the session interface below won't change.

// Runtime-agnostic WS client: Cloudflare Workers has a native WebSocket
// (auth via ["token", key] subprotocol — headers aren't settable); the Node
// gateway uses the `ws` package with an Authorization header.
const isWorkers = typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function";

type WsClient = {
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener?(ev: string, fn: (e: { data?: unknown; message?: string }) => void): void;
  on?(ev: string, fn: (...args: never[]) => void): void;
};

async function openDeepgramSocket(url: string, key: string): Promise<{
  socket: WsClient;
  onOpen(fn: () => void): void;
  onMessage(fn: (text: string) => void): void;
  onError(fn: (message: string) => void): void;
}> {
  if (isWorkers) {
    // Workers' canonical client-WS path: fetch with an Upgrade header (which,
    // unlike the WebSocket constructor, also lets us send real auth headers).
    const resp = await fetch(url.replace(/^wss:/, "https:"), {
      headers: { Upgrade: "websocket", Authorization: `Token ${key}` },
    });
    const socket = (resp as unknown as { webSocket: (WsClient & { accept(): void }) | null }).webSocket;
    if (!socket) throw new Error(`Deepgram upgrade failed: HTTP ${resp.status}`);
    socket.accept();
    return {
      socket,
      // Already open post-accept — fire the open callback on next tick.
      onOpen: (fn) => void Promise.resolve().then(fn),
      onMessage: (fn) =>
        socket.addEventListener!("message", (e) => {
          if (typeof e.data === "string") fn(e.data);
        }),
      onError: (fn) => socket.addEventListener!("error", (e) => fn(e.message ?? "connection error")),
    };
  }
  const { default: NodeWebSocket } = await import("ws");
  const socket = new NodeWebSocket(url, { headers: { Authorization: `Token ${key}` } }) as unknown as WsClient & {
    on(ev: string, fn: (arg?: unknown) => void): void;
  };
  return {
    socket,
    onOpen: (fn) => socket.on("open", fn),
    onMessage: (fn) => socket.on("message", (data) => fn(String(data))),
    onError: (fn) =>
      socket.on("error", (err: unknown) => fn(err instanceof Error ? err.message : "connection error")),
  };
}

export function deepgramAvailable(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

// Houston-specific terms that generic STT models mangle.
const KEYTERMS = [
  "HCAD", "Westcott", "Yale", "Heights", "Montrose", "EaDo", "Eastex",
  "Aldine", "Katy", "Cypress", "Pearland", "Westheimer", "Kirby", "Shepherd",
  "Studewood", "Wirt", "Bissonnet", "Fondren", "Hillcroft", "Almeda",
  "Telephone Road", "Chapter 42", "townhome", "parcel",
];

export type SttSession = {
  sendAudio(chunk: Uint8Array): void;
  close(): void;
};

export function createDeepgramSession(opts: {
  sampleRate: number;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: string) => void;
}): SttSession {
  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "linear16",
    sample_rate: String(opts.sampleRate),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    endpointing: "400",
    filler_words: "false",
  });
  for (const term of KEYTERMS) params.append("keyterm", term);

  const url = `wss://api.deepgram.com/v1/listen?${params}`;
  const pending: Uint8Array[] = [];
  let open = false;
  let closed = false;
  let sock: WsClient | null = null;
  // Accumulate finals within one turn; Deepgram emits is_final per segment
  // and speech_final at end-of-turn.
  let turnBuffer = "";

  void openDeepgramSocket(url, process.env.DEEPGRAM_API_KEY!).then((h) => {
    if (closed) {
      h.socket.close();
      return;
    }
    sock = h.socket;
    h.onOpen(() => {
      open = true;
      for (const chunk of pending) sock!.send(chunk);
      pending.length = 0;
    });
    h.onError((message) => {
      if (!closed) opts.onError(`Deepgram: ${message}`);
    });
    h.onMessage((data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type !== "Results") return;
      const alt = msg.channel?.alternatives?.[0];
      const text: string = alt?.transcript ?? "";
      if (!text) return;
      if (msg.is_final) {
        turnBuffer = (turnBuffer + " " + text).trim();
        if (msg.speech_final) {
          const finalText = turnBuffer;
          turnBuffer = "";
          opts.onFinal(finalText);
        } else {
          opts.onPartial(turnBuffer);
        }
      } else {
        opts.onPartial((turnBuffer + " " + text).trim());
      }
    } catch {
      /* ignore malformed frames */
    }
    });
  }).catch((err) => {
    if (!closed) opts.onError(`Deepgram: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    sendAudio(chunk: Uint8Array) {
      if (closed) return;
      if (open && sock) sock.send(chunk);
      else pending.push(chunk);
    },
    close() {
      closed = true;
      try {
        if (open && sock) sock.send(JSON.stringify({ type: "CloseStream" }));
        sock?.close();
      } catch {
        /* already closed */
      }
    },
  };
}
