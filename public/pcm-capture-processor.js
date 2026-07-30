class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samplesPerChunk = 1600; // 100 ms at 16 kHz
    this.samples = new Float32Array(this.samplesPerChunk);
    this.writeIndex = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];

    if (input && output) {
      output.set(input);
    }

    if (!input) {
      return true;
    }

    for (let index = 0; index < input.length; index += 1) {
      this.samples[this.writeIndex] = input[index];
      this.writeIndex += 1;

      if (this.writeIndex === this.samplesPerChunk) {
        const pcm = new Int16Array(this.samplesPerChunk);
        for (let sampleIndex = 0; sampleIndex < this.samplesPerChunk; sampleIndex += 1) {
          const sample = Math.max(-1, Math.min(1, this.samples[sampleIndex]));
          pcm[sampleIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);

