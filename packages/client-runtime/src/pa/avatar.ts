// @effect-diagnostics globalDate:off - Animation clock for React hooks, outside an Effect runtime.

import type { PaAvatarShape } from "@t3tools/contracts";
import { msg } from "gt-i18n";

import { type ClockStore, makeTickStore } from "../clock.ts";

/** The monochrome swatch: stored as a plain hex, drawn in the theme's foreground. */
const PA_AVATAR_OBSIDIAN = "#71717a";

export const PA_AVATAR_COLORS = [
  { label: msg("Obsidian", { $context: "bot avatar color" }), value: PA_AVATAR_OBSIDIAN },
  { label: msg("Teal"), value: "#14b8a6" },
  { label: msg("Violet"), value: "#8b5cf6" },
  { label: msg("Ocean blue"), value: "#3b82f6" },
  { label: msg("Orange"), value: "#f97316" },
  { label: msg("Emerald"), value: "#10b981" },
  { label: msg("Amber"), value: "#f59e0b" },
  { label: msg("Crimson"), value: "#ef4444" },
] as const;

// Stored keys predate these designs; the keys stay so saved Bots keep their avatar.
export const PA_AVATAR_SHAPES = [
  { label: msg("Terminal Core", { $context: "bot avatar shape" }), value: "blob" },
  { label: msg("Twin-Ear", { $context: "bot avatar shape" }), value: "pumpkin" },
  { label: msg("Four-Spark", { $context: "bot avatar shape" }), value: "drop" },
  { label: msg("Cyber Visor", { $context: "bot avatar shape" }), value: "pill" },
  { label: msg("Hollow Iris", { $context: "bot avatar shape" }), value: "circle" },
  { label: msg("Symbiote Drift", { $context: "bot avatar shape" }), value: "cloud" },
] as const satisfies ReadonlyArray<{ readonly label: string; readonly value: PaAvatarShape }>;

/** What a new Bot starts with in the create form. */
export const PA_DEFAULT_AVATAR = { color: "#14b8a6", shape: "blob" } as const;

const SAFE_HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A stored color reaches an SVG fill, so anything but a plain hex falls back to the first swatch. */
export function sanitizePaAvatarColor(color: string): string {
  return SAFE_HEX_COLOR_RE.test(color) ? color : PA_AVATAR_COLORS[0].value;
}

export function paAvatarColorOptions(storedColor: string) {
  const value = sanitizePaAvatarColor(storedColor).toLowerCase();
  return PA_AVATAR_COLORS.some((option) => option.value === value)
    ? PA_AVATAR_COLORS
    : [...PA_AVATAR_COLORS, { value, label: msg("Current color") }];
}

export function isPaAvatarObsidian(color: string): boolean {
  return sanitizePaAvatarColor(color).toLowerCase() === PA_AVATAR_OBSIDIAN;
}

function mixHex(color: string, target: number, amount: number): string {
  const value = Number.parseInt(color.slice(1), 16);
  const channel = (shift: number) => {
    const c = (value >> shift) & 0xff;
    return Math.round(c + (target - c) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** Fills for a chromatic avatar; `null` for Obsidian, which each client draws in theme colors. */
export function paAvatarPalette(color: string): {
  readonly top: string;
  readonly bottom: string;
  readonly glow: string;
  readonly glint: string;
} | null {
  if (isPaAvatarObsidian(color)) return null;
  const base = sanitizePaAvatarColor(color);
  return {
    top: mixHex(base, 255, 0.16),
    bottom: mixHex(base, 0, 0.16),
    glow: mixHex(base, 255, 0.28),
    glint: mixHex(base, 255, 0.45),
  };
}

// Pixel avatars: a 16×16 mask centered on a 20×20 grid, leaving a margin for badges and motion.

export const PA_AVATAR_GRID = 20;
export const PA_AVATAR_VIEWBOX = `0 0 ${PA_AVATAR_GRID} ${PA_AVATAR_GRID}`;
/** Working motion loops over this many frames. */
export const PA_AVATAR_WORKING_FRAMES = 8;
const PA_AVATAR_FRAME_MS = 180;

export const paAvatarFrameTick: ClockStore<number> = makeTickStore(
  () => Math.floor(Date.now() / PA_AVATAR_FRAME_MS) % PA_AVATAR_WORKING_FRAMES,
  PA_AVATAR_FRAME_MS,
);

function workingFrame(mode: Mode, tick: number): number {
  if (mode !== "working" || !Number.isFinite(tick)) return 0;
  const frame = Math.trunc(tick) % PA_AVATAR_WORKING_FRAMES;
  return frame < 0 ? frame + PA_AVATAR_WORKING_FRAMES : frame;
}

const MASK_OFFSET = 2;

const MASKS: Readonly<Record<PaAvatarShape, ReadonlyArray<string>>> = {
  blob: [
    "................",
    "..############..",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    "..############..",
    "................",
    "................",
  ],
  pumpkin: [
    ".##..........##.",
    ".###........###.",
    ".####......####.",
    ".#####....#####.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    ".##############.",
    "..############..",
    "...##########...",
    "....########....",
    "................",
    "................",
    "................",
  ],
  drop: [
    ".......##.......",
    "......####......",
    "......####......",
    ".....######.....",
    "....########....",
    "...##########...",
    ".##############.",
    "################",
    "################",
    ".##############.",
    "...##########...",
    "....########....",
    ".....######.....",
    "......####......",
    "......####......",
    ".......##.......",
  ],
  pill: [
    "................",
    "................",
    "................",
    "..############..",
    ".##############.",
    "################",
    "################",
    "################",
    "################",
    "################",
    "################",
    ".##############.",
    "..############..",
    "................",
    "................",
    "................",
  ],
  circle: [
    ".....######.....",
    "...##########...",
    "..############..",
    ".#####....#####.",
    ".####......####.",
    "####........####",
    "####........####",
    "####........####",
    "####........####",
    "####........####",
    "####........####",
    ".####......####.",
    ".#####....#####.",
    "..############..",
    "...##########...",
    ".....######.....",
  ],
  cloud: [
    "....########....",
    "..############..",
    ".##############.",
    ".##############.",
    "################",
    "################",
    "################",
    "################",
    "################",
    "################",
    ".###..####..###.",
    ".###..####..###.",
    ".##....##....##.",
    ".##....##....##.",
    "..#....##....#..",
    "................",
  ],
};

export type PaAvatarTone = "body" | "glow" | "glint" | "warn" | "info" | "muted";

/** What the avatar shows; each client maps its Bot fields onto this. */
export interface PaAvatarStatus {
  /** `false` draws the faded, sleeping avatar. */
  readonly online?: boolean;
  readonly working?: boolean;
  /** The Bot is blocked on the user (an approval, a question). */
  readonly awaiting?: boolean;
  readonly unread?: boolean;
  /** The default Bot wears a small crown. */
  readonly isDefault?: boolean;
}

type Mode = "online" | "working" | "awaiting" | "offline";

function resolveMode(status: PaAvatarStatus): Mode {
  if (status.online === false) return "offline";
  if (status.awaiting) return "awaiting";
  if (status.working) return "working";
  return "online";
}

/** Whether this status moves; only working avatars do, and only while not awaiting or offline. */
export function paAvatarAnimates(status: PaAvatarStatus): boolean {
  return resolveMode(status) === "working";
}

const key = (x: number, y: number) => y * PA_AVATAR_GRID + x;
const inGrid = (x: number, y: number) =>
  x >= 0 && x < PA_AVATAR_GRID && y >= 0 && y < PA_AVATAR_GRID;

interface Mask {
  readonly body: ReadonlySet<number>;
  readonly cx: number;
  readonly cy: number;
  readonly top: number;
}

const maskCache = new Map<PaAvatarShape, Mask>();

function maskFor(shape: PaAvatarShape): Mask {
  const cached = maskCache.get(shape);
  if (cached) return cached;
  const body = new Set<number>();
  let sx = 0;
  let sy = 0;
  let top = PA_AVATAR_GRID;
  (MASKS[shape] ?? MASKS.blob).forEach((row, gy) => {
    for (let gx = 0; gx < row.length; gx++) {
      if (row[gx] !== "#") continue;
      const x = gx + MASK_OFFSET;
      const y = gy + MASK_OFFSET;
      body.add(key(x, y));
      sx += x;
      sy += y;
      top = Math.min(top, y);
    }
  });
  const mask = { body, cx: sx / body.size, cy: sy / body.size, top };
  maskCache.set(shape, mask);
  return mask;
}

/** Empty cells touching the mask, where rolling bumps grow. */
function rim(body: ReadonlySet<number>): number[] {
  const out = new Set<number>();
  for (const cell of body) {
    const x = cell % PA_AVATAR_GRID;
    const y = Math.floor(cell / PA_AVATAR_GRID);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (inGrid(x + dx, y + dy) && !body.has(key(x + dx, y + dy))) out.add(key(x + dx, y + dy));
    }
  }
  return [...out];
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const SCAN = [-1, 0, 1, 0] as const;
const SWEEP = [-2, -1, 0, 1, 2, 1, 0, -1] as const;
const ORBIT = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

/** The face: cells cut out of the body, plus cells painted over it. */
function face(
  shape: PaAvatarShape,
  mode: Mode,
  tick: number,
  cut: (x: number, y: number) => void,
  paint: (x: number, y: number, tone: PaAvatarTone) => void,
) {
  const closed = mode === "offline";
  const working = mode === "working";
  const awaiting = mode === "awaiting";
  const dx = working ? SCAN[tick % 4]! : 0;
  switch (shape) {
    case "circle": {
      if (closed) return;
      const [ox, oy] = working ? ORBIT[tick % 8]! : [0, 0];
      const tone = awaiting ? "warn" : working ? "glow" : "body";
      for (let y = 9; y <= 10; y++) for (let x = 9; x <= 10; x++) paint(x + ox, y + oy, tone);
      return;
    }
    case "pill": {
      for (let y = 8; y <= 10; y++) for (let x = 5; x <= 14; x++) cut(x, y);
      if (closed) return;
      if (working) {
        const sx = 9 + SWEEP[tick % 8]!;
        paint(sx, 9, "glint");
        paint(sx + 1, 9, "glint");
      } else {
        paint(7, 9, awaiting ? "warn" : "glint");
        paint(12, 9, awaiting ? "warn" : "glint");
      }
      return;
    }
    case "drop": {
      if (closed) {
        for (let x = 8; x <= 11; x++) cut(x, 10);
        return;
      }
      for (let y = 9; y <= 10; y++) for (let x = 9; x <= 10; x++) cut(x, y);
      if (awaiting || (working && tick % 4 < 2)) {
        for (const [x, y] of [
          [9, 8],
          [10, 8],
          [8, 9],
          [11, 9],
          [8, 10],
          [11, 10],
          [9, 11],
          [10, 11],
        ] as const)
          cut(x, y);
      }
      return;
    }
    case "pumpkin": {
      if (closed) {
        for (const x of [6, 7, 8, 11, 12, 13]) cut(x, 10);
      } else if (awaiting) {
        for (let y = 8; y <= 10; y++) for (const x of [6, 7, 12, 13]) cut(x, y);
      } else {
        for (const x of [6, 7, 8, 11, 12, 13]) cut(x + dx, 9);
      }
      return;
    }
    case "cloud": {
      if (closed) {
        for (const x of [6, 7, 8, 11, 12, 13]) cut(x, 8);
      } else {
        const lift = awaiting ? -1 : 0;
        for (let y = 7 + lift; y <= 8; y++) for (const x of [7, 8, 11, 12]) cut(x + dx, y);
      }
      return;
    }
    case "blob":
    default: {
      if (closed) {
        for (const x of [6, 7, 8, 11, 12, 13]) cut(x, 9);
      } else {
        const bottom = awaiting ? 10 : 9;
        for (let y = 7; y <= bottom; y++) for (const x of [7, 12]) cut(x + dx, y);
      }
    }
  }
}

/** Each motion is drawn for its shape so the six stay apart even while working. */
function workingMotion(
  shape: PaAvatarShape,
  mask: Mask,
  tick: number,
  cells: Map<number, PaAvatarTone>,
) {
  const angle = (tick * Math.PI * 2) / PA_AVATAR_WORKING_FRAMES;
  const set = (x: number, y: number, tone: PaAvatarTone) => {
    if (inGrid(x, y)) cells.set(key(x, y), tone);
  };
  switch (shape) {
    case "cloud": {
      const shift = SCAN[(tick + 1) % 4]!;
      const tips = [...cells].filter(([cell]) => cell >= key(0, 15));
      for (const [cell] of tips) cells.delete(cell);
      for (const [cell] of tips)
        set((cell % PA_AVATAR_GRID) + shift, Math.floor(cell / PA_AVATAR_GRID), "glow");
      return;
    }
    case "drop": {
      const outward = tick % 2 === 0;
      const tips = outward
        ? [
            [9, 1],
            [10, 1],
            [9, 18],
            [10, 18],
            [1, 9],
            [1, 10],
            [18, 9],
            [18, 10],
          ]
        : [
            [9, 2],
            [10, 2],
            [9, 17],
            [10, 17],
            [2, 9],
            [2, 10],
            [17, 9],
            [17, 10],
          ];
      for (const [x, y] of tips) set(x!, y!, "glow");
      return;
    }
    case "pumpkin": {
      if (tick % 2 === 0) for (const x of [3, 4, 15, 16]) set(x, 1, "glow");
      for (const cell of rim(mask.body)) {
        const x = cell % PA_AVATAR_GRID;
        const y = Math.floor(cell / PA_AVATAR_GRID);
        if (y > 7 && Math.cos(Math.atan2(y - mask.cy, x - mask.cx) * 2 - angle) > 0.78)
          cells.set(cell, "body");
      }
      return;
    }
    case "pill": {
      if (tick % 2 === 0) for (const y of [8, 9, 10]) for (const x of [1, 18]) set(x, y, "glow");
      return;
    }
    case "circle":
      return;
    case "blob":
    default: {
      for (const cell of rim(mask.body)) {
        const x = cell % PA_AVATAR_GRID;
        const y = Math.floor(cell / PA_AVATAR_GRID);
        const a = Math.atan2(y - mask.cy, x - mask.cx);
        if (Math.cos(a * 2 - angle) + 0.5 * Math.sin(a * 3 + angle) > 0.75) cells.set(cell, "body");
      }
    }
  }
}

const AWAITING_MARK = [
  [18, 0],
  [19, 0],
  [18, 1],
  [19, 1],
  [18, 2],
  [19, 2],
  [18, 4],
  [19, 4],
] as const;

/**
 * One frame of an avatar as painted cells. Cut-out cells are absent, so the face shows whatever is
 * behind the avatar. `tick` only matters while working.
 */
export function paAvatarCells(
  shape: PaAvatarShape,
  status: PaAvatarStatus,
  tick = 0,
): ReadonlyMap<number, PaAvatarTone> {
  const mode = resolveMode(status);
  const mask = maskFor(shape);
  const frame = workingFrame(mode, tick);
  const cells = new Map<number, PaAvatarTone>();
  for (const cell of mask.body) cells.set(cell, "body");
  if (mode === "working") workingMotion(shape, mask, frame, cells);

  const cut = new Set<number>();
  face(
    shape,
    mode,
    frame,
    (x, y) => {
      if (inGrid(x, y)) cut.add(key(x, y));
    },
    (x, y, tone) => {
      if (!inGrid(x, y)) return;
      cut.delete(key(x, y));
      cells.set(key(x, y), tone);
    },
  );
  for (const cell of cut) cells.delete(cell);

  const cx = Math.round(mask.cx);
  if (mode === "offline") {
    for (const cell of cells.keys()) {
      const x = cell % PA_AVATAR_GRID;
      const y = Math.floor(cell / PA_AVATAR_GRID);
      if ((x + y) % 2 === 1 && hash(x, y) < 0.42) cells.delete(cell);
      else cells.set(cell, "muted");
    }
  } else {
    for (const [x, y] of [
      [cx - 3, mask.top + 2],
      [cx - 2, mask.top + 1],
    ] as const) {
      if (cells.get(key(x, y)) === "body") cells.set(key(x, y), "glint");
    }
  }

  if (mode === "awaiting") for (const [x, y] of AWAITING_MARK) cells.set(key(x, y), "warn");
  if (status.unread && !(status.working && !status.awaiting)) {
    for (let y = 17; y <= 19; y++) for (let x = 17; x <= 19; x++) cells.set(key(x, y), "info");
  }
  if (status.isDefault) {
    // Three prongs around the grid's middle columns, the center one taller, like the effort glyph.
    const base = Math.max(1, mask.top - 1);
    for (const [x, y] of [
      [7, base],
      [9, base],
      [9, base - 1],
      [10, base],
      [10, base - 1],
      [12, base],
    ] as const)
      cells.set(key(x, y), "warn");
  }
  return cells;
}

/** Cells overlap by this much so neighbours fuse without antialiasing seams. */
const CELL_BLEED = 0.025;
const CORNER_RADIUS = 0.45;

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * One subpath per cell, rounding only corners on the outside of the silhouette, so shapes read as
 * soft blobs while joins between cells stay solid at every size.
 */
function cellsPath(cells: ReadonlyArray<number>, occupied: (x: number, y: number) => boolean) {
  const parts: string[] = [];
  for (const cell of cells) {
    const x = cell % PA_AVATAR_GRID;
    const y = Math.floor(cell / PA_AVATAR_GRID);
    const up = occupied(x, y - 1);
    const down = occupied(x, y + 1);
    const left = occupied(x - 1, y);
    const right = occupied(x + 1, y);
    const tl = !up && !left ? CORNER_RADIUS : 0;
    const tr = !up && !right ? CORNER_RADIUS : 0;
    const br = !down && !right ? CORNER_RADIUS : 0;
    const bl = !down && !left ? CORNER_RADIUS : 0;
    const x0 = round(x - CELL_BLEED);
    const y0 = round(y - CELL_BLEED);
    const x1 = round(x + 1 + CELL_BLEED);
    const y1 = round(y + 1 + CELL_BLEED);
    const arc = (r: number, ex: number, ey: number) =>
      r > 0 ? `A${r} ${r} 0 0 1 ${ex} ${ey}` : "";
    parts.push(
      `M${round(x0 + tl)} ${y0}H${round(x1 - tr)}${arc(tr, x1, round(y0 + tr))}` +
        `V${round(y1 - br)}${arc(br, round(x1 - br), y1)}` +
        `H${round(x0 + bl)}${arc(bl, x0, round(y1 - bl))}` +
        `V${round(y0 + tl)}${arc(tl, round(x0 + tl), y0)}Z`,
    );
  }
  return parts.join("");
}

export interface PaAvatarLayer {
  readonly tone: PaAvatarTone;
  readonly d: string;
}

const TONE_ORDER: ReadonlyArray<PaAvatarTone> = ["body", "muted", "glow", "glint", "warn", "info"];
const layerCache = new Map<string, ReadonlyArray<PaAvatarLayer>>();

/** The frame as one path per tone, cached since every Bot list draws the same few frames. */
export function paAvatarLayers(
  shape: PaAvatarShape,
  status: PaAvatarStatus,
  tick = 0,
): ReadonlyArray<PaAvatarLayer> {
  const mode = resolveMode(status);
  const frame = workingFrame(mode, tick);
  const unread = status.unread && !(status.working && !status.awaiting);
  const cacheKey = `${shape}|${mode}|${frame}|${unread ? 1 : 0}|${status.isDefault ? 1 : 0}`;
  const cached = layerCache.get(cacheKey);
  if (cached) return cached;
  const cells = paAvatarCells(shape, status, frame);
  const layers = TONE_ORDER.flatMap((tone) => {
    const occupied = (x: number, y: number) => inGrid(x, y) && cells.get(key(x, y)) === tone;
    const own = [...cells].filter(([, t]) => t === tone).map(([cell]) => cell);
    return own.length > 0 ? [{ tone, d: cellsPath(own, occupied) }] : [];
  });
  layerCache.set(cacheKey, layers);
  return layers;
}

// The nav mark: the Terminal Core as a line icon, on the 24×24 grid line icons share.
export const PA_BOTS_MARK_VIEWBOX = "0 0 24 24";
export const PA_BOTS_MARK_PATH =
  "M8 4h8a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5ZM9.5 10v4M14.5 10v4";
