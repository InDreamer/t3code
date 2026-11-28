import {
  PA_AVATAR_VIEWBOX,
  paAvatarAnimates,
  paAvatarFrameTick,
  paAvatarLayers,
  paAvatarPalette,
  type PaAvatarTone,
} from "@t3tools/client-runtime/pa/avatar";
import type { PaAvatarShape } from "@t3tools/contracts";
import { useId, useSyncExternalStore } from "react";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useReduceMotionEnabled } from "../../lib/appState";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

const SIZES = { sm: 32, md: 44, lg: 80 } as const;

const STILL = () => () => {};
const FIRST_FRAME = () => 0;

const THEMED_TONES: Partial<Record<PaAvatarTone, { className: string; opacity: number }>> = {
  warn: { className: "accent-warning-foreground", opacity: 1 },
  info: { className: "accent-primary", opacity: 1 },
  muted: { className: "accent-foreground-muted", opacity: 0.6 },
};
const OBSIDIAN_OPACITY = {
  light: { body: 0.75, glow: 0.55, glint: 0.4 },
  dark: { body: 0.75, glow: 0.9, glint: 1 },
} as const;

export function BotAvatar(props: {
  readonly color: string;
  readonly shape: PaAvatarShape;
  readonly size?: keyof typeof SIZES;
  readonly online?: boolean;
  readonly running?: boolean;
  readonly visible?: boolean;
  readonly awaiting?: boolean;
  readonly unread?: boolean;
  /** The default Bot, drawn with a small crown. */
  readonly starred?: boolean;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const dimension = SIZES[props.size ?? "md"];
  const status = {
    online: props.online ?? true,
    working: props.running ?? false,
    awaiting: props.awaiting ?? false,
    unread: props.unread ?? false,
    isDefault: props.starred ?? false,
  };
  const reducedMotion = useReduceMotionEnabled();
  const animate = paAvatarAnimates(status) && props.visible === true && !reducedMotion;
  const frame = useSyncExternalStore(
    animate ? paAvatarFrameTick.subscribe : STILL,
    animate ? paAvatarFrameTick.getSnapshot : FIRST_FRAME,
  );
  const gradientId = `pa-avatar-${useId().replace(/[^\w-]/gu, "")}`;
  const palette = paAvatarPalette(props.color);

  return (
    <Svg width={dimension} height={dimension} viewBox={PA_AVATAR_VIEWBOX} style={{ flexShrink: 0 }}>
      {palette ? (
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={palette.top} />
            <Stop offset="1" stopColor={palette.bottom} />
          </LinearGradient>
        </Defs>
      ) : null}
      {paAvatarLayers(props.shape, status, frame).map((layer) => {
        const themed = THEMED_TONES[layer.tone];
        if (themed || !palette) {
          const opacity =
            themed?.opacity ??
            OBSIDIAN_OPACITY[themeAppearance][
              layer.tone === "glow" || layer.tone === "glint" ? layer.tone : "body"
            ];
          return (
            <ThemedPath
              key={layer.tone}
              d={layer.d}
              colorClassName={themed?.className ?? "accent-foreground"}
              fill="currentColor"
              fillOpacity={opacity}
            />
          );
        }
        const fill =
          layer.tone === "body"
            ? `url(#${gradientId})`
            : layer.tone === "glow"
              ? palette.glow
              : palette.glint;
        return <Path key={layer.tone} d={layer.d} fill={fill} />;
      })}
    </Svg>
  );
}
