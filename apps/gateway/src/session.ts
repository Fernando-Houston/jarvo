// One Session per WebSocket connection: owns the STT stream, the brain,
// the TTS queue, and the turn lifecycle (listening → thinking → speaking).

import type { Capabilities, ServerMsg, ParcelVisual, CompsVisual, GroundVisual } from "@hvi/shared";

/** Minimal socket surface Session needs — satisfied by both the `ws`
 *  package (Node gateway) and the Workers server-side WebSocket (via a
 *  tiny adapter that supplies OPEN/readyState). */
export type WsLike = {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
};
import type { Brain } from "./brain/types";
import { createClaudeBrain } from "./brain/claude";
import { createRulesBrain } from "./brain/rules";
import { createDeepgramSession, deepgramAvailable, type SttSession } from "./providers/deepgram";
import { createTtsQueue, elevenLabsAvailable } from "./providers/elevenlabs";
import { crmAvailable } from "./tools/crm";
import { lookupByAccount, type Parcel } from "./tools/hcad";
import type { SessionMemory } from "./tools/index";

export class Session {
  private ws: WsLike;
  private brain: Brain;
  private caps: Capabilities;
  private stt: SttSession | null = null;
  private turnAbort: AbortController | null = null;
  private audioSeq = 0;
  /** Half-duplex echo guard: while a turn is speaking, drop STT results so
   *  HVI never transcribes (and answers) its own voice. Barge-in comes later. */
  private turnSpeaking = false;
  /** Rules brain standing in while Claude can't bill (created on first need). */
  private fallbackBrain: Brain | null = null;
  /** Set when the client restores focus on a fresh session (reconnect after
   *  a phone lock, DO hibernation...). Prepended to the next utterance so
   *  the brain knows what "it" means despite having no history. */
  private focusNote: string | null = null;
  /** Cross-turn context: what "this one" refers to, and parcels already seen. */
  private memory: SessionMemory = {
    lastAccount: null,
    lastMatches: 0,
    user: null,
    knownParcels: new Map(),
    floodByAccount: new Map(),
    leadStatusByAccount: new Map(),
    ch42ByAccount: new Map(),
    compsMedianByAccount: new Map(),
  };

  constructor(ws: WsLike, opts: { user?: string | null } = {}) {
    this.ws = ws;
    if (opts.user) {
      // Named session (?u=fernando): attribution for notes and logs.
      this.memory.user = opts.user.slice(0, 40);
      console.log(`[session] user=${this.memory.user}`);
    }
    this.caps = {
      stt: deepgramAvailable() ? "deepgram" : "client",
      tts: elevenLabsAvailable() ? "elevenlabs" : "client",
      brain: process.env.ANTHROPIC_API_KEY ? "claude" : "rules",
      crm: crmAvailable(),
    };
    this.brain = this.caps.brain === "claude" ? createClaudeBrain() : createRulesBrain();
    this.send({ type: "ready", caps: this.caps });
    this.send({ type: "state", state: "idle" });
  }

  private send(msg: ServerMsg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendBinary(buf: Uint8Array) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(buf);
  }

  handleText(raw: string) {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        this.send({ type: "ready", caps: this.caps });
        break;
      case "text":
        if (typeof msg.text === "string" && msg.text.trim()) {
          void this.runTurn(msg.text.trim());
        }
        break;
      case "focus":
        if (typeof msg.hcadAccount === "string" && msg.hcadAccount.trim()) {
          this.setFocus(msg.hcadAccount.trim());
        }
        break;
      case "audio_start":
        this.startStt(typeof msg.sampleRate === "number" ? msg.sampleRate : 16000);
        break;
      case "audio_stop":
        this.stopStt();
        break;
      case "interrupt":
        this.interrupt();
        break;
    }
  }

  handleAudio(chunk: Uint8Array) {
    this.stt?.sendAudio(chunk);
  }

  /** The client restored its constellation (or refocused): "this one" now
   *  means this parcel. Hydrate the full record lazily for CRM writes. */
  private setFocus(account: string) {
    this.memory.lastAccount = account;
    this.focusNote = `HCAD ${account}`;
    if (!this.memory.knownParcels.has(account)) {
      void lookupByAccount(account)
        .then((p) => {
          if (p) {
            this.memory.knownParcels.set(p.hcadAccount, p);
            if (this.focusNote) this.focusNote = `${p.address} (HCAD ${p.hcadAccount})`;
          }
        })
        .catch(() => {
          /* resolveParcel will retry live at write time */
        });
    }
  }

  private startStt(sampleRate: number) {
    if (this.caps.stt !== "deepgram") {
      this.send({ type: "error", message: "Server STT not configured; use client speech recognition." });
      return;
    }
    this.stopStt();
    this.send({ type: "state", state: "listening" });
    this.stt = createDeepgramSession({
      sampleRate,
      onPartial: (text) => {
        if (this.turnSpeaking) return;
        this.send({ type: "transcript", text, final: false });
      },
      onFinal: (text) => {
        if (this.turnSpeaking) return;
        this.send({ type: "transcript", text, final: true });
        if (text.trim()) void this.runTurn(text.trim());
      },
      onError: (message) => this.send({ type: "error", message }),
    });
  }

  private stopStt() {
    this.stt?.close();
    this.stt = null;
  }

  private interrupt() {
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.turnSpeaking = false;
    this.send({ type: "state", state: "idle" });
    this.send({ type: "visual", visual: { kind: "dissolve" } });
  }

  private async runTurn(userText: string) {
    // A new utterance interrupts any in-flight turn.
    this.turnAbort?.abort();
    const abort = new AbortController();
    this.turnAbort = abort;
    this.turnSpeaking = false;

    this.send({ type: "state", state: "thinking" });

    const parcels = new Map<string, Parcel>();
    const emitVisual = (v: ParcelVisual | CompsVisual | GroundVisual) => {
      if (!abort.signal.aborted) this.send({ type: "visual", visual: v });
    };

    let spokeAnything = false;
    const events = {
      onTextDelta: (delta: string) => {
        if (abort.signal.aborted) return;
        this.send({ type: "assistant_text", text: delta, done: false });
      },
      onSentence: (sentence: string) => {
        if (abort.signal.aborted) return;
        if (!spokeAnything) {
          spokeAnything = true;
          this.turnSpeaking = true;
          this.send({ type: "state", state: "speaking" });
        }
        if (tts) tts.enqueue(sentence);
        else this.send({ type: "speak", text: sentence });
      },
      onTool: (name: string, status: "start" | "end") => {
        if (!abort.signal.aborted) this.send({ type: "tool", name, status });
      },
    };
    const tts =
      this.caps.tts === "elevenlabs"
        ? createTtsQueue({
            onChunk: (audio, mime, last) => {
              if (abort.signal.aborted) return;
              this.send({ type: "audio_chunk", seq: this.audioSeq++, mime, last });
              this.sendBinary(audio);
            },
            onError: (message) => this.send({ type: "error", message }),
          })
        : null;
    abort.signal.addEventListener("abort", () => tts?.abort());

    const toolCtx = { parcels, memory: this.memory, emitVisual };
    // Resumed session: give the brain the on-screen context exactly once.
    const effectiveText = this.focusNote
      ? `(Context: the property currently shown on the user's screen is ${this.focusNote} — "it"/"this one" refers to that parcel.) ${userText}`
      : userText;
    this.focusNote = null;
    try {
      await this.brain.run(effectiveText, events, toolCtx, abort.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Claude configured but the org can't bill (no credits yet): degrade to
      // the rules brain for this session instead of apologizing. The moment
      // credits land, a gateway restart puts Claude back in charge.
      const creditIssue = /credit balance|plans & billing|billing|insufficient.*credit/i.test(message);
      if (!abort.signal.aborted && creditIssue && this.brain.name === "claude" && !spokeAnything) {
        console.warn("[session] Claude brain unavailable (credits) — answering with the rules brain");
        if (!this.fallbackBrain) this.fallbackBrain = createRulesBrain();
        try {
          await this.fallbackBrain.run(effectiveText, events, toolCtx, abort.signal);
        } catch (err2) {
          if (!abort.signal.aborted) {
            this.send({ type: "error", message: err2 instanceof Error ? err2.message : String(err2) });
            const apology = "Sorry, I hit a snag reaching my data. Try that again.";
            if (tts) tts.enqueue(apology);
            else this.send({ type: "speak", text: apology });
          }
        }
      } else if (!abort.signal.aborted) {
        this.send({ type: "error", message });
        const apology = "Sorry, I hit a snag reaching my data. Try that again.";
        if (tts) tts.enqueue(apology);
        else this.send({ type: "speak", text: apology });
      }
    } finally {
      // Release the STT gate only if this turn still owns it (a newer turn
      // may have started speaking while this one was winding down). The
      // client's own mic gate covers the remaining playback tail.
      if (this.turnAbort === abort) this.turnSpeaking = false;
      if (!abort.signal.aborted) {
        this.send({ type: "assistant_text", text: "", done: true });
        // Client returns the orb to idle when audio playback finishes;
        // "speaking" state ends client-side. If nothing was spoken, go idle now.
        if (!spokeAnything) this.send({ type: "state", state: "idle" });
      }
    }
  }

  destroy() {
    this.turnAbort?.abort();
    this.stopStt();
  }
}
