const audio = document.querySelector("audio");
const slider = document.querySelector("#vocals");
const context = new AudioContext();
const source = context.createMediaElementSource(audio);
const splitter = context.createChannelSplitter(4);
const output = context.createGain();

function connectStereoPair(firstChannel) {
  const stereo = context.createChannelMerger(2);
  const gain = context.createGain();
  splitter.connect(stereo, firstChannel, 0);
  splitter.connect(stereo, firstChannel + 1, 1);
  stereo.connect(gain).connect(output);
  return gain.gain;
}

source.connect(splitter);
const original = connectStereoPair(0);
const backing = connectStereoPair(2);
original.value = 1;
backing.value = 0;
output.connect(context.destination);

const rampSeconds = 0.025;
let previousRamp = { start: 0, from: 1, to: 1 };

function updateVocalLevel(value) {
  const level = value / 100;
  const now = context.currentTime;
  const progress = Math.min(1, (now - previousRamp.start) / rampSeconds);
  const current = previousRamp.from + (previousRamp.to - previousRamp.from) * progress;

  // Anchor at this update so rapid input continues from the in-progress gain.
  for (const [parameter, from, target] of [
    [original, current, level],
    [backing, 1 - current, 1 - level],
  ]) {
    parameter.cancelAndHoldAtTime(now);
    parameter.setValueAtTime(from, now);
    parameter.linearRampToValueAtTime(target, now + rampSeconds);
  }
  previousRamp = { start: now, from: current, to: level };
}

slider.addEventListener("input", () => {
  updateVocalLevel(slider.valueAsNumber);
  document.querySelector("#level").value = `${slider.value}%`;
});
audio.addEventListener("play", () => void context.resume());
document.addEventListener("pointerdown", () => void context.resume(), { once: true });
audio.addEventListener("error", () => {
  document.querySelector("#error").textContent = audio.error?.message ?? "Could not load the song";
});
audio.src = "media://vocal-level/song.flac";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventOnce = (target, event) => new Promise((resolve) => target.addEventListener(event, resolve, { once: true }));

function requireValue(condition, description) {
  if (!condition) throw new Error(description);
}

async function checkPlayback(testTones) {
  await context.audioWorklet.addModule("/measure.js");
  const meter = new AudioWorkletNode(context, "measure-output", {
    numberOfInputs: 2,
    numberOfOutputs: 0,
    channelInterpretation: "discrete",
  });
  output.connect(meter);
  source.connect(meter, 0, 1);
  const measure = async (level = slider.valueAsNumber / 100) => {
    const response = eventOnce(meter.port, "message");
    meter.port.start();
    const port = meter.port;
    port.postMessage(level);
    const result = (await response).data;
    requireValue(result.rms > 0.001, "Expected audible samples");
    requireValue(result.peakError < 0.000001, `Unexpected mix error ${result.peakError}`);
    return result;
  };
  const assertTones = (measured, expected) => {
    if (!testTones) return;
    expected.forEach((channel, index) => {
      channel.forEach((value, tone) => {
        requireValue(
          Math.abs(measured.tones[index][tone] - value) < 0.003,
          `Channel ${index}, tone ${tone}: expected ${value}, got ${measured.tones[index][tone]}`,
        );
      });
    });
  };

  let seeks = 0;
  let stalls = 0;
  audio.addEventListener("seeking", () => seeks++);
  audio.addEventListener("waiting", () => stalls++);
  await context.resume();
  // Capture the real graph while keeping the speaker silent in automated runs.
  output.disconnect(context.destination);
  await audio.play();
  if (!testTones) {
    const seeked = eventOnce(audio, "seeked");
    audio.currentTime = audio.duration * 0.25;
    await seeked;
  }
  await delay(100);
  const starts = { seeks, stalls, time: audio.currentTime };
  const full = await measure();
  assertTones(full, [
    [0.2, 0, 0.1, 0, 0, 0],
    [0, 0.2, 0, 0.1, 0, 0],
  ]);

  const moveSlider = (value) => {
    slider.value = value;
    slider.dispatchEvent(new Event("input"));
  };
  const setSlider = async (value) => {
    moveSlider(value);
    await delay(55);
    return measure();
  };
  const half = await setSlider(50);
  assertTones(half, [
    [0.2, 0, 0.05, 0, 0, 0],
    [0, 0.2, 0, 0.05, 0, 0],
  ]);
  const off = await setSlider(0);
  assertTones(off, [
    [0.2, 0, 0, 0, 0, 0],
    [0, 0.2, 0, 0, 0, 0],
  ]);
  let ramp10To90Ms;
  if (testTones) {
    const transition = measure(null);
    await delay(35);
    moveSlider(100);
    const { ramp, blockSize } = await transition;
    const aboveTen = ramp.findIndex((level) => level >= 0.1);
    const aboveNinety = ramp.findIndex((level) => level >= 0.9);
    requireValue(ramp[0] < 0.02 && ramp.at(-1) > 0.98, "Expected both settled ends of the gain ramp");
    ramp10To90Ms = ((aboveNinety - aboveTen) * blockSize * 1000) / context.sampleRate;
    requireValue(ramp10To90Ms > 15 && ramp10To90Ms < 24, `Unexpected ramp time ${ramp10To90Ms} ms`);
    moveSlider(0);
  }
  requireValue(
    seeks === starts.seeks && stalls === starts.stalls && audio.currentTime > starts.time,
    "The vocal slider disturbed media playback",
  );

  audio.pause();
  const paused = audio.currentTime;
  await delay(70);
  requireValue(audio.currentTime === paused, "Media clock advanced while paused");
  const seeked = eventOnce(audio, "seeked");
  const target = testTones ? 3 : audio.duration * 0.87;
  audio.currentTime = target;
  await seeked;
  requireValue(Math.abs(audio.currentTime - target) < 0.01, "Media clock did not reach seek target");
  await audio.play();
  await delay(85);
  const afterSeek = await measure();
  assertTones(afterSeek, [
    [0, 0, 0, 0, 0.2, 0],
    [0, 0, 0, 0, 0, 0.2],
  ]);
  audio.pause();
  return { sampleRate: context.sampleRate, full, half, off, afterSeek, ramp10To90Ms, sliderSeeks: 0, sliderStalls: 0 };
}

window.checkPlayback = checkPlayback;
