import {
  PA_AVATAR_EYES,
  PA_AVATAR_ROTATION_ORIGIN,
  PA_AVATAR_VIEWBOX,
  paAvatarPrimitives,
  sanitizePaAvatarColor,
} from "@t3tools/client-runtime/pa/avatar";
import type { PaAvatarShape } from "@t3tools/contracts";
import { View } from "react-native";
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";

const ThemedPath = withUniwind(Path);
const ThemedEllipse = withUniwind(Ellipse);

const SIZES = { sm: 32, md: 44, lg: 80 } as const;

export function BotAvatar(props: {
  readonly color: string;
  readonly shape: PaAvatarShape;
  readonly size?: keyof typeof SIZES;
  readonly starred?: boolean;
  readonly unread?: boolean;
}) {
  const size = props.size ?? "md";
  const dimension = SIZES[size];
  const fill = sanitizePaAvatarColor(props.color);
  const origin = PA_AVATAR_ROTATION_ORIGIN;
  return (
    <View style={{ width: dimension, height: dimension }} className="shrink-0">
      <Svg width={dimension} height={dimension} viewBox={PA_AVATAR_VIEWBOX}>
        {paAvatarPrimitives(props.shape).map((primitive) => {
          switch (primitive.kind) {
            case "path":
              return primitive.paint === "stem" ? (
                <ThemedPath
                  key={primitive.d}
                  d={primitive.d}
                  colorClassName="accent-foreground-muted"
                  stroke="currentColor"
                  strokeWidth={primitive.strokeWidth}
                  strokeLinecap="round"
                  fill="none"
                />
              ) : (
                <Path key={primitive.d} d={primitive.d} fill={fill} />
              );
            case "rect":
              return (
                <Rect
                  key="rect"
                  x={primitive.x}
                  y={primitive.y}
                  width={primitive.width}
                  height={primitive.height}
                  rx={primitive.rx}
                  transform={`rotate(${primitive.rotate} ${origin.x} ${origin.y})`}
                  fill={fill}
                />
              );
            case "circle":
              return (
                <Circle
                  key="circle"
                  cx={primitive.cx}
                  cy={primitive.cy}
                  r={primitive.r}
                  fill={fill}
                />
              );
          }
        })}
        {PA_AVATAR_EYES.map((eye) => (
          <ThemedEllipse
            key={eye.cx}
            cx={eye.cx}
            cy={eye.cy}
            rx={eye.rx}
            ry={eye.ry}
            transform={`rotate(${eye.rotate} ${eye.cx} ${eye.cy})`}
            colorClassName="accent-screen"
            fill="currentColor"
            fillOpacity={0.88}
          />
        ))}
      </Svg>
      {props.starred ? (
        <View
          className={
            size === "lg"
              ? "absolute bottom-0 right-0 size-6 items-center justify-center rounded-full border-2 border-screen bg-warning"
              : "absolute bottom-0 right-0 size-4 items-center justify-center rounded-full border-2 border-screen bg-warning"
          }
        >
          <SymbolView
            name="star.fill"
            size={size === "lg" ? 12 : 8}
            tintColorClassName="accent-warning-foreground"
          />
        </View>
      ) : props.unread ? (
        <View
          className={
            size === "lg"
              ? "absolute bottom-0.5 right-0.5 size-3.5 rounded-full border-2 border-screen bg-primary"
              : "absolute bottom-0.5 right-0.5 size-2.5 rounded-full border-2 border-screen bg-primary"
          }
        />
      ) : null}
    </View>
  );
}
