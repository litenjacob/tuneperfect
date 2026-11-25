import { debounce } from "@solid-primitives/scheduled";
import { createEffect, createSignal, on, onCleanup } from "solid-js";

import { subscribePitchStream } from "~/lib/audio/pitch-stream";
import { requestRecording } from "~/lib/audio/recording-session";
import { t } from "~/lib/i18n";

interface MicLevelMeterProps {
  /** Stable device ID. Preferred over `name` for selecting the device. */
  deviceId: () => string | undefined;
  name: () => string | null;
  channel: () => number;
  gain: () => number;
  threshold: () => number;
}

export default function MicLevelMeter(props: MicLevelMeterProps) {
  const [level, setLevel] = createSignal(0);
  const [active, setActive] = createSignal(false);

  let preview: ReturnType<typeof requestRecording> | undefined;
  const startPreview = () => {
    preview?.release();
    const name = props.name();
    if (!name) return;
    const request = requestRecording([
      {
        deviceId: props.deviceId(),
        name,
        channel: props.channel(),
        gain: props.gain(),
        threshold: 0,
        delay: 0,
      },
    ]);
    preview = request;
    void request
      .ready()
      .then(() => {
        if (preview === request) setActive(true);
      })
      .catch(() => {});
  };
  // oxlint-disable-next-line solid/reactivity
  const debouncedRestart = debounce(startPreview, 300);
  createEffect(on([props.deviceId, props.name, props.channel, props.gain], () => debouncedRestart()));

  // dB scale so quiet sounds are still visible and loud ones don't just max out
  const ampToMeter = (amp: number): number => {
    if (amp <= 0) return 0;
    const db = 20 * Math.log10(amp);
    const minDb = -60;
    return Math.max(0, Math.min(1, (db - minDb) / -minDb));
  };

  // Smooth out the meter: jumps up instantly but falls off gradually, by 15% every 50 ms.
  let peakHold = 0;
  let lastBatchAt = 0;
  const DECAY_PER_50_MS = 0.85;

  // Levels come with the pitch stream, a batch about every 18 ms while recording.
  createEffect(() => {
    if (!active()) return;

    const unsubscribe = subscribePitchStream((batch, receivedAt) => {
      let peak = -1;
      for (const frame of batch.frames) if (frame.mic === preview?.slot(0)) peak = Math.max(peak, frame.level);
      if (peak < 0) return;

      const meter = ampToMeter(peak);
      const decay = DECAY_PER_50_MS ** ((receivedAt - (lastBatchAt || receivedAt)) / 50);
      lastBatchAt = receivedAt;
      peakHold = meter >= peakHold ? meter : peakHold * decay;
      setLevel(peakHold);
    });

    onCleanup(unsubscribe);
  });

  onCleanup(() => {
    debouncedRestart.clear();
    preview?.release();
    preview = undefined;
  });

  const percentage = () => level() * 100;

  // Matches the peak check in Rust's above_noise_threshold exactly
  const thresholdPercentage = () => ampToMeter(props.threshold() / 100) * 100;

  return (
    <div class="grid h-16 items-center overflow-hidden rounded-[0.8cqw]">
      <div class="z-2 col-start-1 row-start-1 grid w-full grid-cols-[2fr_3fr] items-center gap-8 px-10">
        <div class="truncate text-xl font-bold">{t("settings.sections.microphones.level")}</div>
        <div class="flex items-center gap-8">
          <div class="relative grid h-3 grow items-center overflow-hidden rounded-full">
            <div class="col-start-1 row-start-1 h-full w-full rounded-full bg-black/20" />
            <div
              class="col-start-1 row-start-1 h-full w-full transition-[clip-path] duration-75"
              style={{
                background:
                  "linear-gradient(to right, #155e75 0%, #10b981 50%, #10b981 75%, #fbbf24 90%, #ef4444 100%)",
                "clip-path": `inset(0 ${100 - percentage()}% 0 0)`,
              }}
            />
            <div
              class="z-1 col-start-1 row-start-1 h-full w-0.5 bg-white/50"
              style={{ "margin-left": `${thresholdPercentage()}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
