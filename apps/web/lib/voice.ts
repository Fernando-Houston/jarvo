"use client";

// The client side of the HVI pipeline: gateway WebSocket, microphone capture
// (server STT via PCM worklet, or browser Web Speech API), TTS playback
// (gateway audio chunks, or browser speechSynthesis), and audio-level taps
// that drive the orb.

import type { ClientMsg, ServerMsg } from "@hvi/shared";
import { useHvi } from "./store";
import { orbBus, setOrbLevel, setOrbMode, setOrbTargets, setOrbLines, setOrbFlood } from "./orbBus";
import {
  addParcel,
  setComps,
  setGround,
  focusParcelById,
  clearConstellation,
  serializeConstellation,
  restoreConstellation,
  type Layout,
} from "./constellation";

const SAVE_KEY = "hvi-constellation-v1";

// What each tool sounds like when the orb narrates its own thinking.
const TOOL_LABELS: Record<string, string> = {
  property_lookup: "reading Harris County records…",
  owner_lookup: "searching owner holdings…",
  flood_check: "checking FEMA flood maps…",
  comps: "pulling comparable lots…",
  chapter42_feasibility: "running Chapter 42 feasibility…",
  crm_lead_check: "checking the pipeline…",
  crm_add_lead: "saving to Land Lead Hub…",
  crm_add_note: "writing the note…",
  crm_update_status: "updating the pipeline…",
  recent_transfers: "sweeping for fresh deals…",
  pipeline_briefing: "reading the pipeline…",
  nightly_digest: "reading the overnight digest…",
  verdict: "running the kill-chain…",
  tax_sale_check: "checking the tax-sale pipeline…",
  tax_sale_radar: "sweeping for tax distress…",
  city_overlays: "checking city overlays…",
  where_is_this: "reading the ground…",
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
};

class VoiceClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Audio graph
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micWorklet: AudioWorkletNode | null = null;
  private playbackAnalyser: AnalyserNode | null = null;
  private levelRaf = 0;

  // Server-TTS playback
  private chunkParts: Uint8Array[] = [];
  private playQueue: Blob[] = [];
  private playing = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private synthTick: ReturnType<typeof setInterval> | null = null;

  // Browser STT
  private recognition: SpeechRecognitionLike | null = null;

  // Half-duplex echo guard: while HVI speaks, the mic worklet streams silence
  // instead of real frames so Deepgram stays alive but can't hear the speakers.
  private micGated = false;

  // The parcel "this one" refers to. Replayed to the gateway on every
  // (re)connect so voice CRM writes survive refreshes and dropped sockets.
  private focusAccount: string | null = null;

  // Utterances typed/spoken while the socket is down (e.g. mid-reconnect
  // after a gateway restart) — flushed on the next open instead of vanishing.
  private pendingTexts: ClientMsg[] = [];

  start() {
    if (this.ws) return;
    this.connect();
    this.levelLoop();
    this.restoreSavedMap();
  }

  /** Bring back the constellation from the last session, if any. */
  private restoreSavedMap() {
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      if (!saved) return;
      const restored = restoreConstellation(saved);
      if (!restored) return;
      useHvi.getState().setVisual(restored.focus);
      setOrbFlood(Boolean(restored.focus.sfha));
      this.focusAccount = restored.focus.hcadAccount;
      this.applyLayout(restored.layout);
    } catch {
      /* corrupted save — ignore */
    }
  }

  private applyLayout(layout: Layout) {
    useHvi.getState().setChips(layout.chips);
    setOrbTargets(layout.targets, layout.nodeKinds);
    setOrbLines(layout.lines);
    orbBus.anchors = layout.anchors;
    orbBus.cameraZ = layout.cameraZ;
  }

  private connect() {
    const base = process.env.NEXT_PUBLIC_GATEWAY_URL || "ws://localhost:8787";
    // Pairs with the gateway's HVI_SHARED_SECRET (set both or neither).
    const token = process.env.NEXT_PUBLIC_GATEWAY_TOKEN;
    const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      useHvi.getState().setConnected(true);
      this.send({ type: "hello" });
      if (this.focusAccount) this.send({ type: "focus", hcadAccount: this.focusAccount });
      const queued = this.pendingTexts;
      this.pendingTexts = [];
      for (const msg of queued) this.send(msg);
    };
    ws.onclose = () => {
      useHvi.getState().setConnected(false);
      this.ws = null;
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.handleServerMsg(JSON.parse(ev.data) as ServerMsg);
      else this.handleServerAudio(new Uint8Array(ev.data as ArrayBuffer));
    };
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else if (msg.type === "text") {
      // Don't lose what the user said to a reconnect window.
      this.pendingTexts = [...this.pendingTexts.slice(-2), msg];
    }
  }

  private handleServerMsg(msg: ServerMsg) {
    const s = useHvi.getState();
    switch (msg.type) {
      case "ready":
        s.setCaps(msg.caps);
        break;
      case "state":
        // "speaking" ends client-side when playback drains; ignore late idle
        // from the server if audio is still playing.
        if (msg.state === "idle" && (this.playing || this.playQueue.length)) return;
        this.applyState(msg.state);
        break;
      case "transcript":
        s.setTranscript(msg.text);
        if (msg.final && msg.text.trim()) s.beginTurn(msg.text.trim());
        break;
      case "assistant_text":
        if (msg.done) break;
        s.appendCaption(msg.text);
        s.appendTurnText(msg.text);
        break;
      case "speak":
        this.speakWithBrowser(msg.text);
        break;
      case "audio_chunk":
        // binary frame follows; `last` closes out one sentence blob
        this.pendingChunkMeta = msg;
        break;
      case "visual":
        if (msg.visual.kind === "parcel") {
          const layout = addParcel(msg.visual);
          s.setVisual(msg.visual);
          setOrbFlood(Boolean(msg.visual.sfha));
          this.focusAccount = msg.visual.hcadAccount;
          this.applyLayout(layout);
          try {
            const snapshot = serializeConstellation();
            if (snapshot) localStorage.setItem(SAVE_KEY, snapshot);
          } catch {
            /* storage full/blocked — the session still works */
          }
        }
        if (msg.visual.kind === "ground") {
          const layout = setGround(msg.visual);
          if (layout) {
            this.applyLayout(layout);
            try {
              const snapshot = serializeConstellation();
              if (snapshot) localStorage.setItem(SAVE_KEY, snapshot);
            } catch {
              /* storage full/blocked */
            }
          }
        }
        if (msg.visual.kind === "comps") {
          const layout = setComps(msg.visual);
          if (layout) {
            this.applyLayout(layout);
            try {
              const snapshot = serializeConstellation();
              if (snapshot) localStorage.setItem(SAVE_KEY, snapshot);
            } catch {
              /* storage full/blocked */
            }
          }
        }
        // "dissolve" (sent on interrupt) intentionally does NOT wipe the
        // constellation — the map you built persists until you clear it.
        break;
      case "tool":
        if (msg.status === "start") s.setActivity(TOOL_LABELS[msg.name] ?? `${msg.name.replace(/_/g, " ")}…`);
        else s.setActivity(null);
        break;
      case "error":
        s.setError(msg.message);
        setTimeout(() => useHvi.getState().setError(null), 6000);
        break;
    }
  }

  private applyState(state: "idle" | "listening" | "thinking" | "speaking") {
    useHvi.getState().setOrbState(state);
    setOrbMode(state);
    if (state === "thinking" || state === "listening") {
      useHvi.getState().resetCaption();
    }
    if (state === "idle" || state === "listening") {
      useHvi.getState().setActivity(null);
    }
    // The constellation persists across turns — no auto-dissolve. The map
    // you talked into existence stays until clearMap().
  }

  /** Dissolve the whole constellation back into the voice (and forget it). */
  clearMap() {
    clearConstellation();
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
    const s = useHvi.getState();
    s.setVisual(null);
    s.setChips([]);
    setOrbTargets(null);
    setOrbLines(null);
    setOrbFlood(false);
    this.focusAccount = null;
    orbBus.anchors = [];
    orbBus.screens.clear();
    orbBus.cameraZ = 4.2;
  }

  // ── User input ───────────────────────────────────────────────────────────
  sendText(text: string) {
    this.stopPlayback();
    // Called from a click/tap — unlock the AudioContext so mobile Safari
    // lets the reply actually play.
    void this.ensureCtx();
    useHvi.getState().setTranscript(text);
    useHvi.getState().beginTurn(text);
    this.send({ type: "text", text });
  }

  interrupt() {
    this.stopPlayback();
    this.send({ type: "interrupt" });
  }

  /** Node tap: instantly refocus the map + card from local constellation
   *  data (no round-trip), tell the gateway, and ask about it out loud. */
  focusNode(hcadAccount: string, label: string) {
    const res = focusParcelById(hcadAccount);
    if (res) {
      useHvi.getState().setVisual(res.visual);
      setOrbFlood(Boolean(res.visual.sfha));
      this.focusAccount = res.visual.hcadAccount;
      this.applyLayout(res.layout);
      try {
        const snapshot = serializeConstellation();
        if (snapshot) localStorage.setItem(SAVE_KEY, snapshot);
      } catch {
        /* ignore */
      }
      this.send({ type: "focus", hcadAccount: res.visual.hcadAccount });
    }
    this.sendText(`Tell me about ${label}`);
  }

  /** Dismiss the parcel card (map + focus stay). */
  dismissCard() {
    useHvi.getState().setVisual(null);
  }

  async toggleMic() {
    const s = useHvi.getState();
    if (s.micArmed) {
      this.stopMic();
      return;
    }
    this.stopPlayback();
    s.setMicArmed(true);
    const caps = s.caps;
    try {
      if (caps?.stt === "deepgram") await this.startServerStt();
      else this.startBrowserStt();
      this.applyState("listening");
    } catch (err) {
      s.setMicArmed(false);
      s.setError(err instanceof Error ? err.message : "Microphone unavailable");
    }
  }

  private stopMic() {
    useHvi.getState().setMicArmed(false);
    this.send({ type: "audio_stop" });
    this.micWorklet?.disconnect();
    this.micWorklet = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micAnalyser = null;
    this.recognition?.stop();
    if (useHvi.getState().orbState === "listening") this.applyState("idle");
  }

  private async ensureCtx(): Promise<AudioContext> {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  private async startServerStt() {
    const ctx = await this.ensureCtx();
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const src = ctx.createMediaStreamSource(this.micStream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;
    src.connect(this.micAnalyser);

    await ctx.audioWorklet.addModule("/worklets/pcm-processor.js");
    this.micWorklet = new AudioWorkletNode(ctx, "pcm-processor");
    src.connect(this.micWorklet);
    this.send({ type: "audio_start", sampleRate: ctx.sampleRate });
    this.micWorklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // While gated, send zero-filled frames of the same length: Deepgram's
      // stream keeps ticking (it closes after ~10s of no audio) but hears
      // nothing, so HVI can't transcribe its own voice.
      this.ws.send(this.micGated ? new ArrayBuffer(e.data.byteLength) : e.data);
    };
  }

  private startBrowserStt() {
    const Ctor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) throw new Error("This browser has no speech recognition — use Chrome, or type your question.");
    const rec: SpeechRecognitionLike = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      useHvi.getState().setTranscript((finalText + " " + interim).trim());
    };
    rec.onend = () => {
      useHvi.getState().setMicArmed(false);
      const text = finalText.trim();
      if (text) {
        useHvi.getState().beginTurn(text);
        this.send({ type: "text", text });
      } else if (useHvi.getState().orbState === "listening") this.applyState("idle");
    };
    rec.onerror = () => {
      useHvi.getState().setMicArmed(false);
      if (useHvi.getState().orbState === "listening") this.applyState("idle");
    };
    this.recognition = rec;
    rec.start();
    // Mic level for the orb (parallel tap; best-effort).
    void this.ensureCtx().then(async (ctx) => {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const src = ctx.createMediaStreamSource(this.micStream);
        this.micAnalyser = ctx.createAnalyser();
        this.micAnalyser.fftSize = 512;
        src.connect(this.micAnalyser);
      } catch {
        /* level stays synthetic */
      }
    });
  }

  // ── Server TTS playback ──────────────────────────────────────────────────
  private pendingChunkMeta: { seq: number; mime: string; last: boolean } | null = null;

  private handleServerAudio(bytes: Uint8Array) {
    const meta = this.pendingChunkMeta;
    this.pendingChunkMeta = null;
    this.chunkParts.push(bytes);
    if (meta?.last) {
      const blob = new Blob(this.chunkParts as BlobPart[], { type: meta.mime });
      this.chunkParts = [];
      this.playQueue.push(blob);
      void this.drainPlayQueue();
    }
  }

  private async drainPlayQueue() {
    if (this.playing) return;
    const blob = this.playQueue.shift();
    if (!blob) {
      this.micGated = false;
      if (useHvi.getState().orbState === "speaking") this.applyState("idle");
      return;
    }
    this.playing = true;
    this.micGated = true;
    this.applyState("speaking");
    // Web Audio, not <audio>: mobile Safari blocks Audio.play() outside a
    // touch handler, but a BufferSource on an already-unlocked AudioContext
    // (resumed by the first mic/Ask tap) plays fine.
    const ctx = await this.ensureCtx();
    try {
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buf;
      this.playbackAnalyser = ctx.createAnalyser();
      this.playbackAnalyser.fftSize = 512;
      src.connect(this.playbackAnalyser);
      this.playbackAnalyser.connect(ctx.destination);
      this.currentSource = src;
      src.onended = () => {
        this.playing = false;
        this.currentSource = null;
        void this.drainPlayQueue();
      };
      src.start();
    } catch {
      this.playing = false;
      this.currentSource = null;
      void this.drainPlayQueue();
    }
  }

  // ── Browser TTS fallback ─────────────────────────────────────────────────
  private speakWithBrowser(text: string) {
    if (!("speechSynthesis" in window)) return;
    this.applyState("speaking");
    this.micGated = true;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.onstart = () => {
      if (this.synthTick) clearInterval(this.synthTick);
      // No analyser access to speechSynthesis: synthesize a speech-like level.
      const t0 = performance.now();
      this.synthTick = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        setOrbLevel(0.35 + 0.3 * Math.abs(Math.sin(t * 7)) + Math.random() * 0.18);
      }, 50);
    };
    u.onend = () => {
      if (this.synthTick) clearInterval(this.synthTick);
      this.synthTick = null;
      if (!window.speechSynthesis.pending && !window.speechSynthesis.speaking) {
        this.micGated = false;
        this.applyState("idle");
      }
    };
    window.speechSynthesis.speak(u);
  }

  private stopPlayback() {
    this.micGated = false;
    this.playQueue = [];
    this.chunkParts = [];
    if (this.currentSource) {
      this.currentSource.onended = null;
      try {
        this.currentSource.stop();
      } catch {
        /* already stopped */
      }
      this.currentSource = null;
    }
    this.playing = false;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (this.synthTick) {
      clearInterval(this.synthTick);
      this.synthTick = null;
    }
  }

  // ── Orb level loop ───────────────────────────────────────────────────────
  private levelLoop() {
    const buf = new Uint8Array(512);
    const tick = () => {
      const mode = orbBus.mode;
      let analyser: AnalyserNode | null = null;
      if (mode === "listening") analyser = this.micAnalyser;
      else if (mode === "speaking") analyser = this.playbackAnalyser;
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Smooth toward the new level.
        setOrbLevel(orbBus.level * 0.7 + Math.min(1, rms * 4) * 0.3);
      } else if (mode === "idle" || mode === "thinking") {
        setOrbLevel(orbBus.level * 0.92);
      }
      this.levelRaf = requestAnimationFrame(tick);
    };
    this.levelRaf = requestAnimationFrame(tick);
  }
}

export const voice = new VoiceClient();
