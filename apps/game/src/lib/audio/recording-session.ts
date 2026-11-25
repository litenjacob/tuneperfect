import { createEffect, createMemo, createRoot, createSignal } from "solid-js";

import { native } from "~/lib/native/client";
import type { MicrophoneOptions } from "~/lib/native/types.gen";
import { settings, settingsInitialized, settingsStore } from "~/stores/settings";

type Input = MicrophoneOptions | null | undefined;
type Device = Awaited<ReturnType<typeof native.microphones.list>>[number];

const [requests, setRequests] = createSignal<readonly (readonly Input[])[]>([]);
const [devices, setDevices] = createSignal<Device[]>();
const [available, setAvailable] = createSignal(false);

const sameInput = (a: Input, b: Input) =>
  !!a && !!b && a.channel === b.channel && (a.deviceId && b.deviceId ? a.deviceId === b.deviceId : a.name === b.name);

export function microphoneLevelSlot(input: Input, fallback: number) {
  const configured = settingsStore.microphones().findIndex((mic) => sameInput(mic, input));
  return configured < 0 ? fallback : configured;
}

const plan = createRoot(() =>
  createMemo(() => {
    if (!settingsInitialized()) return;
    const enabled = settingsStore.general().micPlaybackEnabled;
    const configured = settingsStore.microphones();
    const levels = settings().mixer.microphones;
    const known = devices();
    const defaultDevice = known?.[0];
    const fallback =
      enabled &&
      defaultDevice &&
      !configured.some((mic) =>
        known?.some(
          (device) =>
            sameInput(mic, {
              name: device.name,
              deviceId: device.id,
              channel: mic.channel,
              gain: 1,
              threshold: 0,
              delay: 0,
            }) && mic.channel < device.channels,
        ),
      )
        ? { name: defaultDevice.name, deviceId: defaultDevice.id, channel: 0, gain: 1, threshold: 1, delay: 0 }
        : undefined;

    const inputs: MicrophoneOptions[] = [];
    const gains: number[] = [];
    const keys: string[] = [];
    const add = (mic: MicrophoneOptions, level: number) => {
      const key = JSON.stringify([mic.deviceId || mic.name, mic.channel, mic.gain, mic.threshold]);
      const existing = keys.indexOf(key);
      if (existing >= 0) return existing;
      const duplicate = inputs.some((input) => sameInput(input, mic));
      keys.push(key);
      inputs.push(mic);
      gains.push(duplicate ? 0 : level);
      return inputs.length - 1;
    };

    if (enabled) {
      for (const [index, mic] of configured.entries()) add(mic, levels[index] ?? 1);
      if (fallback) add(fallback, levels[0] ?? 1);
    }
    const slots = new Map(
      requests().map((request) => [
        request,
        request.map((mic, index) => (mic ? add(mic, levels[microphoneLevelSlot(mic, index)] ?? 1) : -1)),
      ]),
    );
    return {
      inputs,
      gains,
      slots,
      enabled,
      master: settingsStore.volume().micPlayback,
      key: JSON.stringify([keys, known?.map((device) => [device.id, device.name, device.channels])]),
    };
  }),
);

let chain = Promise.resolve();
let running: string | undefined;
let lastPlayback: string | undefined;
type Plan = NonNullable<ReturnType<typeof plan>>;

function reconcile(next: Plan) {
  const operation = chain.then(async () => {
    if (!next.inputs.length) {
      if (running !== undefined) await native.recording.stop().catch(() => {});
      running = undefined;
      setAvailable(false);
      return;
    }
    const playback = JSON.stringify([next.enabled, next.master, next.gains]);
    if (running !== next.key) {
      running = undefined;
      const ready = await native.recording.start({
        microphones: next.inputs.map((mic) => ({
          ...mic,
          gain: mic.gain ?? 1,
          threshold: mic.threshold ?? 1,
          delay: mic.delay ?? 0,
        })),
        playbackEnabled: next.enabled,
        playbackVolume: next.master,
        microphoneLevels: next.gains,
      });
      running = next.key;
      setAvailable(ready);
    } else if (playback !== lastPlayback) {
      await native.recording.setPlayback({
        enabled: next.enabled,
        volume: next.master,
        microphoneLevels: next.gains,
      });
    }
    lastPlayback = playback;
  });
  chain = operation.catch((error) => {
    setAvailable(false);
    console.warn("Microphone monitoring could not start:", error);
  });
  return operation;
}

let refreshing = false;
let offeredDefault = false;
async function refreshDevices() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await native.microphones.list();
    if (JSON.stringify(next) !== JSON.stringify(devices())) setDevices(next);
    const first = next[0];
    if (first && !offeredDefault && !settingsStore.microphones().length) {
      settingsStore.saveMicrophone(0, {
        deviceId: first.id ?? undefined,
        name: first.name,
        channel: 0,
        color: "sky",
        delay: 0,
        gain: 1,
        threshold: 1,
      });
    }
    if (first) offeredDefault = true;
  } finally {
    refreshing = false;
  }
}

createRoot(() => {
  createEffect(() => {
    if (!settingsInitialized()) return;
    void refreshDevices().catch(() => {});
  });
  createEffect(() => {
    const next = plan();
    if (next) void reconcile(next).catch(() => {});
  });
  window.setInterval(() => {
    if (settingsInitialized() && (settingsStore.general().micPlaybackEnabled || requests().length)) {
      void refreshDevices().catch(() => {});
    }
  }, 5000);
});

export function requestRecording(microphones: readonly Input[]) {
  // Each caller owns its slots and releases only its own request, leaving monitoring running.
  const request = [...microphones];
  setRequests((current) => [...current, request]);
  return {
    slot: (index: number) => plan()?.slots.get(request)?.[index] ?? -1,
    ready: () => {
      const next = plan();
      return next ? reconcile(next) : Promise.resolve();
    },
    release: () => setRequests((current) => current.filter((item) => item !== request)),
  };
}

export const micPlaybackAvailable = available;
