import { createEffect, Index, Show } from "solid-js";
import ArrowDown from "~icons/ph/arrow-down-bold";
import ArrowLeft from "~icons/ph/arrow-left-bold";
import ArrowRight from "~icons/ph/arrow-right-bold";
import ArrowUp from "~icons/ph/arrow-up-bold";
import Mic from "~icons/ph/microphone-bold";
import SlidersHorizontal from "~icons/ph/sliders-horizontal-bold";
import AudioLines from "~icons/ph/waveform-bold";
import X from "~icons/ph/x-bold";

import { t } from "~/lib/i18n";

export interface MixChannel {
  slot: number | "vocals";
  label: string;
  level: number;
  max: number;
  status?: string;
  adjustable: boolean;
}

export default function LiveMixer(props: {
  open: boolean;
  channels: readonly MixChannel[];
  selected: MixChannel["slot"];
  onSelect: (channel: MixChannel["slot"]) => void;
  onLevel: (channel: MixChannel, level: number) => void;
  onToggle: () => void;
  onActivity: () => void;
}) {
  const selected = () => props.channels.find((channel) => channel.slot === props.selected);
  let faders: HTMLFieldSetElement | undefined;

  createEffect(() => {
    const slot = props.selected;
    if (!props.open || !faders?.contains(document.activeElement)) return;
    faders.querySelector<HTMLInputElement>(`[data-fader="${slot}"]`)?.focus({ preventScroll: true });
  });

  return (
    <aside
      class="pointer-events-none absolute right-3 bottom-full mb-9 flex max-w-[calc(100vw-1.5rem)] flex-col items-end text-white sm:right-6"
      aria-label={t("game.mixer.title")}
    >
      <Show
        when={props.open}
        fallback={
          <button
            type="button"
            aria-label={t("game.mixer.title")}
            aria-expanded="false"
            class="pointer-events-auto grid size-9 place-items-center rounded-lg bg-[#10232d]/80 text-white/75 shadow-md outline-offset-2 transition hover:bg-[#183944] hover:text-white focus-visible:outline-2 focus-visible:outline-cyan-200"
            onClick={() => props.onToggle()}
          >
            <SlidersHorizontal class="size-4" />
          </button>
        }
      >
        <div
          class="pointer-events-auto w-[min(var(--mixer-width),calc(100vw-1.5rem))] rounded-2xl bg-[#0d1c27]/98 shadow-[0_14px_36px_#0008]"
          style={{ "--mixer-width": `${Math.max(14, props.channels.length * 6 + 1)}rem` }}
          onFocusIn={() => props.onActivity()}
        >
          <div class="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
            <h2 class="flex items-center gap-2 text-sm font-bold">
              <SlidersHorizontal class="size-4 shrink-0 text-cyan-200" />
              {t("game.mixer.title")}
            </h2>
            <button
              type="button"
              class="grid size-8 shrink-0 place-items-center rounded-lg text-white/65 outline-offset-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-cyan-200"
              aria-label={t("game.mixer.close")}
              onClick={() => props.onToggle()}
            >
              <X class="size-4" />
            </button>
          </div>
          <fieldset
            ref={faders}
            class="grid gap-1 px-2"
            style={{ "grid-template-columns": `repeat(${props.channels.length}, minmax(0, 1fr))` }}
            aria-label={t("game.mixer.channels")}
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
          >
            <Index each={props.channels}>
              {(channel) => (
                <label
                  class="grid min-w-0 justify-items-center gap-1 rounded-lg px-1 py-1.5 text-center focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-cyan-200/60"
                  classList={{
                    "bg-cyan-200/18 text-cyan-100": channel().slot === props.selected,
                    "text-[#c4d5dd]": channel().slot !== props.selected,
                    "cursor-pointer": channel().adjustable,
                    "hover:bg-white/5": channel().adjustable && channel().slot !== props.selected,
                  }}
                  onPointerDown={() => props.onSelect(channel().slot)}
                  title={channel().status ?? channel().label}
                >
                  <span class="flex max-w-full min-w-0 items-center justify-center gap-1 text-xs leading-tight font-bold">
                    <Show
                      when={channel().slot === "vocals"}
                      fallback={<Mic class="size-3.5 shrink-0" aria-hidden="true" />}
                    >
                      <AudioLines class="size-3.5 shrink-0" aria-hidden="true" />
                    </Show>
                    <span class="min-w-0 wrap-anywhere">{channel().label}</span>
                  </span>
                  <span class="relative grid h-[clamp(2.5rem,11vh,4.75rem)] w-8 place-items-center">
                    <span
                      aria-hidden="true"
                      class="absolute inset-y-1 left-1/2 w-1.5 -translate-x-1/2 rounded-full bg-white/15"
                    >
                      <Show when={channel().adjustable}>
                        <span
                          class="absolute inset-x-0 bottom-0 rounded-full bg-current motion-safe:transition-[height] motion-safe:duration-100"
                          style={{ height: `${(channel().level / channel().max) * 100}%` }}
                        />
                        <Show when={channel().max > 100}>
                          <span
                            class="absolute left-full ml-1 h-px w-1.5 bg-current opacity-70"
                            style={{ bottom: `${10000 / channel().max}%` }}
                          />
                        </Show>
                      </Show>
                    </span>
                    <span
                      aria-hidden="true"
                      class="absolute inset-y-1 left-1/2 w-5 -translate-x-1/2"
                      classList={{ invisible: !channel().adjustable }}
                    >
                      <span
                        class="absolute inset-x-0 h-1.5 translate-y-1/2 rounded-sm bg-current motion-safe:transition-[bottom] motion-safe:duration-100"
                        style={{ bottom: `${(channel().level / channel().max) * 100}%` }}
                      />
                    </span>
                    <input
                      type="range"
                      class="relative z-1 h-full w-full cursor-ns-resize opacity-0"
                      style={{ "writing-mode": "vertical-lr", direction: "rtl" }}
                      min={0}
                      max={channel().max}
                      step={5}
                      value={channel().level}
                      disabled={!channel().adjustable}
                      data-fader={channel().slot}
                      aria-label={channel().label}
                      aria-orientation="vertical"
                      aria-valuetext={channel().adjustable ? `${channel().level}%` : channel().status}
                      onFocus={() => props.onSelect(channel().slot)}
                      onInput={(event) => props.onLevel(channel(), event.currentTarget.valueAsNumber)}
                    />
                  </span>
                  <span aria-hidden="true" class="text-sm leading-tight font-bold tabular-nums">
                    {channel().adjustable ? `${channel().level}%` : "—"}
                  </span>
                </label>
              )}
            </Index>
          </fieldset>
          <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 py-2 text-xs text-[#b7cbd3]">
            <span class="flex items-center gap-1">
              <ArrowLeft class="size-3" aria-hidden="true" />
              <ArrowRight class="size-3" aria-hidden="true" />
              {t("game.mixer.select")}
            </span>
            <span class="flex items-center gap-1">
              <ArrowUp class="size-3" aria-hidden="true" />
              <ArrowDown class="size-3" aria-hidden="true" />
              {t("game.mixer.adjust")}
            </span>
            <Show when={selected()?.status}>{(status) => <output class="w-full text-center">{status()}</output>}</Show>
          </div>
        </div>
      </Show>
    </aside>
  );
}
