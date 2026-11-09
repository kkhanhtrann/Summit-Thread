class SummitThreadPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.samples = new Float32Array(1600);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;

    const frameLength = channels[0].length;
    for (let index = 0; index < frameLength; index += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] ?? 0;
      sample /= channels.length;
      // Accumulate arbitrary device sample rates into a 16 kHz output stream
      this.phase += 16000;
      while (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.samples[this.offset++] = sample;
        if (this.offset === this.samples.length) {
          // Transfer each 100 ms mono buffer without copying its PCM samples
          const packet = this.samples;
          this.samples = new Float32Array(1600);
          this.offset = 0;
          this.port.postMessage(packet, [packet.buffer]);
        }
      }
    }

    return true;
  }
}

registerProcessor('summit-thread-pcm-capture', SummitThreadPcmCaptureProcessor);
