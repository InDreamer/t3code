import type { PaAvatarShape } from "@t3tools/contracts";
import { msg } from "gt-i18n";

export const PA_AVATAR_COLORS = [
  { label: msg("Orange"), value: "#f97316" },
  { label: msg("Teal"), value: "#14b8a6" },
  { label: msg("Ocean blue"), value: "#3b82f6" },
  { label: msg("Emerald"), value: "#10b981" },
  { label: msg("Violet"), value: "#8b5cf6" },
  { label: msg("Crimson"), value: "#ef4444" },
  { label: msg("Amber"), value: "#f59e0b" },
  { label: msg("Slate"), value: "#64748b" },
] as const;

export const PA_AVATAR_SHAPES = [
  { label: msg("Pumpkin"), value: "pumpkin" },
  { label: msg("Sphere"), value: "circle" },
  { label: msg("Blob"), value: "blob" },
  { label: msg("Cloud"), value: "cloud" },
  { label: msg("Pill"), value: "pill" },
  { label: msg("Drop"), value: "drop" },
] as const satisfies ReadonlyArray<{ readonly label: string; readonly value: PaAvatarShape }>;

/** What a new Bot starts with in the create form. */
export const PA_DEFAULT_AVATAR = { color: PA_AVATAR_COLORS[1].value, shape: "blob" } as const;

const SAFE_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A stored color reaches an SVG fill, so anything but a plain hex falls back to the first swatch. */
export function sanitizePaAvatarColor(color: string): string {
  return SAFE_HEX_COLOR_RE.test(color) ? color : PA_AVATAR_COLORS[0].value;
}

/** One SVG element of an avatar on a 64×64 canvas; `body` takes the avatar color. */
export type PaAvatarPrimitive =
  | { readonly kind: "path"; readonly d: string; readonly paint: "body" }
  /** The pumpkin's stem: a stroke in the muted foreground color. */
  | {
      readonly kind: "path";
      readonly d: string;
      readonly paint: "stem";
      readonly strokeWidth: number;
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
      readonly rotate: number;
    }
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number };

export const PA_AVATAR_VIEWBOX = "0 0 64 64";

/** The body of each shape; web and mobile draw the same geometry. */
export function paAvatarPrimitives(shape: PaAvatarShape): ReadonlyArray<PaAvatarPrimitive> {
  switch (shape) {
    case "pumpkin":
      return [
        { kind: "path", d: "M29 14c0-5 2-8 6-9", paint: "stem", strokeWidth: 4.2 },
        {
          kind: "path",
          d: "M32 15c13.5 0 24 8.5 23.5 21.5C55 48.5 45.5 55 32 55S9 48.5 8.5 36.5C8 23.5 18.5 15 32 15Z",
          paint: "body",
        },
      ];
    case "cloud":
      return [
        {
          kind: "path",
          d: "M20 51c-7.5 0-13-5-13-11.5 0-5.4 3.8-9.8 9.2-11C18 20.4 24.4 15 32.5 15c8.4 0 15.1 5.8 16.4 13.7C54 29.7 58 34 58 39.5 58 46 52.5 51 45 51H20Z",
          paint: "body",
        },
      ];
    case "drop":
      return [
        {
          kind: "path",
          d: "M30 9c8 8 22 18.5 22 30.5C52 49.5 43.2 56 32 56S12 49.5 12 39.5C12 27.5 22 17 30 9Z",
          paint: "body",
        },
      ];
    case "pill":
      return [{ kind: "rect", x: 10, y: 12, width: 44, height: 42, rx: 16, rotate: -8 }];
    case "blob":
      return [
        {
          kind: "path",
          d: "M34 10c12.5 0 22 8.2 22 21.8C56 45.5 46.8 55 32.5 55 18 55 8 46.5 8 33.5 8 19.5 20.5 10 34 10Z",
          paint: "body",
        },
      ];
    case "circle":
    default:
      return [{ kind: "circle", cx: 32, cy: 33, r: 23 }];
  }
}

/** The two eyes every shape shares, drawn in the background color. */
export const PA_AVATAR_EYES = [
  { cx: 34, cy: 32, rx: 2.9, ry: 6.1, rotate: -12 },
  { cx: 43, cy: 30.5, rx: 2.9, ry: 6.1, rotate: -12 },
] as const;

/** The pill rotates about the canvas middle. */
export const PA_AVATAR_ROTATION_ORIGIN = { x: 32, y: 33 } as const;
