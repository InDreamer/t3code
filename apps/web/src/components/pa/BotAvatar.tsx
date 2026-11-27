import {
  PA_AVATAR_EYES,
  PA_AVATAR_ROTATION_ORIGIN,
  PA_AVATAR_VIEWBOX,
  paAvatarPrimitives,
  sanitizePaAvatarColor,
} from "@t3tools/client-runtime/pa/avatar";
import type { PaAvatarShape } from "@t3tools/contracts";
import { StarIcon } from "lucide-react";

import { cn } from "../../lib/utils";

function ShapePath({ shape, color }: { readonly shape: PaAvatarShape; readonly color: string }) {
  const fill = sanitizePaAvatarColor(color);
  const { x, y } = PA_AVATAR_ROTATION_ORIGIN;
  return paAvatarPrimitives(shape).map((primitive) => {
    switch (primitive.kind) {
      case "path":
        return primitive.paint === "stem" ? (
          <path
            key={primitive.d}
            d={primitive.d}
            className="text-muted-foreground"
            stroke="currentColor"
            strokeWidth={primitive.strokeWidth}
            strokeLinecap="round"
            fill="none"
          />
        ) : (
          <path key={primitive.d} d={primitive.d} fill={fill} />
        );
      case "rect":
        return (
          <rect
            key="rect"
            x={primitive.x}
            y={primitive.y}
            width={primitive.width}
            height={primitive.height}
            rx={primitive.rx}
            transform={`rotate(${primitive.rotate} ${x} ${y})`}
            fill={fill}
          />
        );
      case "circle":
        return (
          <circle key="circle" cx={primitive.cx} cy={primitive.cy} r={primitive.r} fill={fill} />
        );
    }
  });
}

export function BotAvatar({
  color,
  shape,
  size = "md",
  starred = false,
  unread = false,
  running = false,
  className,
}: {
  readonly color: string;
  readonly shape: PaAvatarShape;
  readonly size?: "sm" | "md" | "lg";
  readonly starred?: boolean;
  readonly unread?: boolean;
  readonly running?: boolean;
  readonly className?: string;
}) {
  const dimension = size === "lg" ? "size-20" : size === "sm" ? "size-8" : "size-11";

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        dimension,
        className,
      )}
    >
      <svg
        viewBox={PA_AVATAR_VIEWBOX}
        className={cn("size-full drop-shadow-xs", running && "animate-pulse")}
        aria-hidden="true"
      >
        <ShapePath shape={shape} color={color} />
        <g className="text-background">
          {PA_AVATAR_EYES.map((eye) => (
            <ellipse
              key={eye.cx}
              cx={eye.cx}
              cy={eye.cy}
              rx={eye.rx}
              ry={eye.ry}
              transform={`rotate(${eye.rotate} ${eye.cx} ${eye.cy})`}
              fill="currentColor"
              fillOpacity="0.88"
            />
          ))}
        </g>
      </svg>

      {starred ? (
        <span
          className={cn(
            "absolute right-0 bottom-0 flex items-center justify-center rounded-full border-2 border-background bg-warning text-warning-foreground shadow-xs",
            size === "lg" ? "size-6" : "size-4",
          )}
        >
          <StarIcon className={cn("fill-current", size === "lg" ? "size-3.5" : "size-2.5")} />
        </span>
      ) : null}

      {unread && !starred ? (
        <span
          className={cn(
            "absolute right-0.5 bottom-0.5 rounded-full border-2 border-background bg-info",
            size === "lg" ? "size-3.5" : "size-2.5",
          )}
        />
      ) : null}
    </div>
  );
}
