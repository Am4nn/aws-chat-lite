let context: AudioContext | undefined;

export function playMentionTick() {
  try {
    context ??= new AudioContext();
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain).connect(context.destination);
    osc.start();
    osc.stop(context.currentTime + 0.06);
  } catch {
    // Autoplay policy or no audio support: the tick is optional.
  }
}
