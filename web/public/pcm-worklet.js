// Runs on the audio thread and hands each block of mic samples (128 per render quantum) to the page. The block is
// copied because the engine reuses its buffers for the next quantum.
class PcmTap extends AudioWorkletProcessor {
  process([input]) {
    if (input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
}

registerProcessor("pcm-tap", PcmTap);
