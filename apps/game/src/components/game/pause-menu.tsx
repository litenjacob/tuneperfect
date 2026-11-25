import { useNavigation } from "~/hooks/navigation";
import { MAX_MIC_PLAYBACK_GAIN } from "~/lib/audio/mic-playback";
import { t } from "~/lib/i18n";
import { settingsStore } from "~/stores/settings";

import Menu, { type MenuItem, select } from "../menu";

interface PauseMenuProps {
  onClose?: () => void;
  onRestart?: () => void;
  onNext?: () => void;
  onExit?: () => void;
  showNext?: boolean;
  micPlaybackAvailable?: boolean;
  class?: string;
  gradient?: "gradient-sing" | "gradient-party";
}

export default function PauseMenu(props: PauseMenuProps) {
  useNavigation({
    layer: 1,
    actions: { back: () => props.onClose?.() },
  });

  const micPlaybackEnabled = () => settingsStore.general().micPlaybackEnabled;
  const micPlaybackToggle = select({
    label: t("game.pause.micPlayback"),
    value: () => (micPlaybackEnabled() ? "on" : "off"),
    options: ["off", "on"],
    renderValue: (value) => (value === "on" ? t("game.pause.on") : t("game.pause.off")),
    onChange: (value) => settingsStore.saveGeneral({ ...settingsStore.general(), micPlaybackEnabled: value === "on" }),
  });
  const micPlaybackLevel: MenuItem = {
    type: "slider",
    label: t("game.pause.micVolume"),
    value: () => Math.round(settingsStore.volume().micPlayback * 100),
    min: 0,
    max: MAX_MIC_PLAYBACK_GAIN * 100,
    step: 5,
    renderValue: (value) => `${value}%`,
    onInput: (value) => settingsStore.saveVolume({ ...settingsStore.volume(), micPlayback: value / 100 }),
  };
  const micPlaybackUnavailable: MenuItem = {
    type: "custom",
    interactive: false,
    render: () => <p class="py-2 text-center text-lg text-white/80">{t("game.pause.micPlaybackUnavailable")}</p>,
  };

  const menuItems = (): MenuItem[] => [
    {
      type: "button",
      label: t("game.pause.resume"),
      action: () => props.onClose?.(),
    },
    ...(props.micPlaybackAvailable
      ? micPlaybackEnabled()
        ? [micPlaybackToggle, micPlaybackLevel]
        : [micPlaybackToggle]
      : props.micPlaybackAvailable === false
        ? [micPlaybackUnavailable]
        : []),
    {
      type: "button",
      label: t("game.pause.restart"),
      action: () => props.onRestart?.(),
    },
    ...(props.showNext
      ? [
          {
            type: "button" as const,
            label: t("game.pause.next"),
            action: () => props.onNext?.(),
          },
        ]
      : []),
    {
      type: "button",
      label: t("game.pause.exit"),
      action: () => props.onExit?.(),
    },
  ];

  return (
    <div
      class="h-full w-full p-16"
      classList={{
        [props.class || ""]: true,
      }}
    >
      <Menu items={menuItems()} layer={1} gradient={props.gradient} />
    </div>
  );
}
