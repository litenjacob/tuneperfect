/** The packed file is a single quad stream in original L/R, backing L/R order. */
export function connectVocalMix(source: AudioNode, output: AudioNode, initial: number) {
  const context = source.context;
  const splitter = context.createChannelSplitter(4);
  const pairs = [0, 2].map((channel) => {
    const stereo = context.createChannelMerger(2);
    const gain = context.createGain();
    splitter.connect(stereo, channel, 0);
    splitter.connect(stereo, channel + 1, 1);
    stereo.connect(gain).connect(output);
    return { stereo, gain };
  });
  const [original, backing] = [pairs[0]!.gain.gain, pairs[1]!.gain.gain];
  const seconds = 0.025;
  let ramp = { start: context.currentTime, from: initial, to: initial };
  original.value = initial;
  backing.value = 1 - initial;
  source.connect(splitter);

  return {
    setLevel(level: number) {
      if (level === ramp.to) return;
      const now = context.currentTime;
      const progress = Math.min(1, (now - ramp.start) / seconds);
      const current = ramp.from + (ramp.to - ramp.from) * progress;
      for (const [parameter, from, to] of [
        [original, current, level],
        [backing, 1 - current, 1 - level],
      ] as const) {
        parameter.cancelAndHoldAtTime(now);
        parameter.setValueAtTime(from, now);
        parameter.linearRampToValueAtTime(to, now + seconds);
      }
      ramp = { start: now, from: current, to: level };
    },
    disconnect() {
      source.disconnect(splitter);
      splitter.disconnect();
      for (const { stereo, gain } of pairs) {
        stereo.disconnect();
        gain.disconnect();
      }
    },
  };
}
