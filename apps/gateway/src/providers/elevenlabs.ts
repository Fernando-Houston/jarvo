// ElevenLabs streaming TTS (Flash v2.5) — one HTTP streaming request per
// sentence, chunks forwarded to the client as they arrive. Sentences are
// synthesized in order (serialized) so audio can't interleave.
// Upgrade path: websocket stream-input for continuous prosody.

export function elevenLabsAvailable(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

// Turbo works with ALL voice classes (professional clones garble on Flash).
// Override with ELEVENLABS_MODEL_ID=eleven_flash_v2_5 when using premade voices.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";

export type TtsSink = {
  onChunk: (audio: Buffer, mime: string, last: boolean) => void;
  onError: (err: string) => void;
};

export function createTtsQueue(sink: TtsSink) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "Z3R5wn05IrDiVCyEkUrK";
  let chain: Promise<void> = Promise.resolve();
  let aborted = false;

  async function synthesize(text: string): Promise<void> {
    if (aborted) return;
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: { stability: 0.5, similarity_boost: 0.6, style: 0.1, use_speaker_boost: true },
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok || !res.body) {
      sink.onError(`ElevenLabs HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    let prev: Buffer | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      if (done) break;
      if (prev) sink.onChunk(prev, "audio/mpeg", false);
      prev = Buffer.from(value);
    }
    if (prev) sink.onChunk(prev, "audio/mpeg", true);
  }

  return {
    enqueue(text: string) {
      chain = chain.then(() => synthesize(text)).catch((e) => sink.onError(String(e)));
    },
    abort() {
      aborted = true;
    },
  };
}
