// Converts mic Float32 samples to 16-bit PCM and posts them to the main
// thread in ~64ms batches for streaming to the gateway (server STT mode).
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.samples = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.buffer.push(pcm);
      this.samples += pcm.length;
      if (this.samples >= 3072) {
        const merged = new Int16Array(this.samples);
        let o = 0;
        for (const b of this.buffer) {
          merged.set(b, o);
          o += b.length;
        }
        this.port.postMessage(merged.buffer, [merged.buffer]);
        this.buffer = [];
        this.samples = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-processor", PcmProcessor);
