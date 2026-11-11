/**
 * Turns the microphone's float samples into 16-bit PCM at `toRate`, the only audio Transcribe streaming takes. Each
 * output sample is the average of the input samples it covers, which also damps the pitches too high for the lower
 * rate (they would otherwise fold back as noise). Input past a whole output sample is left over: the caller carries it into the next call.
 */
export function downsample(input: Float32Array, fromRate: number, toRate = 16000): Int16Array {
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.floor((i + 1) * ratio);
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    out[i] = Math.round(Math.max(-1, Math.min(1, sum / (to - from))) * 32767);
  }
  return out;
}

/**
 * Collects PCM into fixed-size byte chunks (3,200 bytes is 100 ms at 16 kHz, the frame size Transcribe recommends).
 * The bytes are in the platform's order, which is little-endian in every browser, as Transcribe expects.
 */
export function chunker(bytesPerChunk = 3200, onChunk: (bytes: Uint8Array) => void): (pcm: Int16Array) => void {
  let pending = new Uint8Array(0);
  return (pcm) => {
    const bytes = new Uint8Array(pending.length + pcm.byteLength);
    bytes.set(pending);
    bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), pending.length);
    let at = 0;
    for (; at + bytesPerChunk <= bytes.length; at += bytesPerChunk) onChunk(bytes.slice(at, at + bytesPerChunk));
    pending = bytes.slice(at);
  };
}
