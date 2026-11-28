import { PaAvatarShape } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  isPaAvatarObsidian,
  PA_AVATAR_COLORS,
  PA_AVATAR_GRID,
  PA_AVATAR_SHAPES,
  PA_AVATAR_WORKING_FRAMES,
  paAvatarAnimates,
  paAvatarColorOptions,
  paAvatarFrameTick,
  paAvatarCells,
  paAvatarLayers,
  paAvatarPalette,
  sanitizePaAvatarColor,
} from "./avatar.ts";

const SHAPES = PaAvatarShape.literals;
const at = (x: number, y: number) => y * PA_AVATAR_GRID + x;

function silhouette(shape: PaAvatarShape, status = {}, tick = 0): string {
  const cells = paAvatarCells(shape, status, tick);
  return [...cells.keys()].toSorted((a, b) => a - b).join(",");
}

describe("PA avatar palette", () => {
  it("keeps every stored shape key and every swatch a hex the server accepts", () => {
    expect(PA_AVATAR_SHAPES.map((shape) => shape.value).toSorted()).toEqual([...SHAPES].toSorted());
    for (const swatch of PA_AVATAR_COLORS) expect(swatch.value).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("keeps a stored legacy swatch selectable without duplicating built-in colors", () => {
    expect(paAvatarColorOptions("#64748B").at(-1)?.value).toBe("#64748b");
    expect(paAvatarColorOptions("#14B8A6")).toBe(PA_AVATAR_COLORS);
    expect(paAvatarColorOptions("url(#x)")).toBe(PA_AVATAR_COLORS);
  });

  it("draws Obsidian, and anything unsafe, in theme colors", () => {
    expect(isPaAvatarObsidian("#71717A")).toBe(true);
    expect(isPaAvatarObsidian("url(#x)")).toBe(true);
    expect(sanitizePaAvatarColor("red")).toBe(PA_AVATAR_COLORS[0].value);
    expect(paAvatarPalette("#71717a")).toBeNull();
    expect(paAvatarPalette("#000000")).toEqual({
      top: "#292929",
      bottom: "#000000",
      glow: "#474747",
      glint: "#737373",
    });
  });
});

describe("PA avatar cells", () => {
  it("gives the six shapes six different silhouettes", () => {
    expect(new Set(SHAPES.map((shape) => silhouette(shape))).size).toBe(SHAPES.length);
  });

  it("keeps every cell on the grid in every state and frame", () => {
    for (const shape of SHAPES) {
      for (let tick = 0; tick < PA_AVATAR_WORKING_FRAMES; tick++) {
        for (const cell of paAvatarCells(
          shape,
          { working: true, unread: true, isDefault: true },
          tick,
        ).keys()) {
          expect(cell).toBeGreaterThanOrEqual(0);
          expect(cell).toBeLessThan(PA_AVATAR_GRID * PA_AVATAR_GRID);
        }
      }
    }
  });

  it("cuts the face out of the body, so it shows what is behind", () => {
    const core = paAvatarCells("blob", {});
    expect(core.get(at(7, 8))).toBeUndefined();
    expect(core.get(at(12, 8))).toBeUndefined();
    expect(core.get(at(9, 8))).toBe("body");
  });

  it("moves only while working, looping over a fixed number of frames", () => {
    for (const shape of SHAPES) {
      const frames = new Set(
        Array.from({ length: PA_AVATAR_WORKING_FRAMES }, (_, tick) =>
          silhouette(shape, { working: true }, tick),
        ),
      );
      expect(frames.size).toBeGreaterThan(1);
      expect(silhouette(shape, { working: true }, PA_AVATAR_WORKING_FRAMES)).toBe(
        silhouette(shape, { working: true }, 0),
      );
      expect(silhouette(shape, {}, 3)).toBe(silhouette(shape, {}, 0));
    }
    expect(paAvatarAnimates({ working: true })).toBe(true);
    expect(paAvatarAnimates({ working: true, awaiting: true })).toBe(false);
    expect(paAvatarAnimates({ working: true, online: false })).toBe(false);
  });

  it("marks awaiting, unread and the default Bot in separate corners", () => {
    const cells = paAvatarCells("pumpkin", { awaiting: true, unread: true, isDefault: true });
    expect(cells.get(at(18, 0))).toBe("warn");
    expect(cells.get(at(19, 19))).toBe("warn");
    expect(cells.get(at(9, 0))).toBe("warn");
    expect(paAvatarCells("pumpkin", {}).get(at(18, 0))).toBeUndefined();
  });

  it("fades an offline Bot and keeps its unread badge", () => {
    const cells = paAvatarCells("circle", { online: false, unread: true });
    const tones = new Set(cells.values());
    expect(tones).toEqual(new Set(["muted", "success"]));
    expect(cells.size).toBeLessThan(paAvatarCells("circle", { unread: true }).size);
  });
});

describe("PA avatar layers", () => {
  it("draws one path per tone and reuses frames", () => {
    const layers = paAvatarLayers("pill", { awaiting: true });
    expect(layers.map((layer) => layer.tone)).toEqual(["body", "glint", "warn"]);
    expect(paAvatarLayers("pill", { awaiting: true })).toBe(layers);
    expect(paAvatarLayers("blob", { working: true }, 9)).toBe(
      paAvatarLayers("blob", { working: true }, 1),
    );
  });

  it.each([
    [NaN, 0],
    [Infinity, 0],
    [-Infinity, 0],
    [-1.8, 7],
    [9.8, 1],
    [-8, 0],
  ])("normalizes frame %s before drawing or caching", (invalid, expected) => {
    for (const shape of SHAPES) {
      const status = { working: true };
      expect(paAvatarCells(shape, status, invalid)).toEqual(paAvatarCells(shape, status, expected));
      expect(paAvatarLayers(shape, status, invalid)).toBe(paAvatarLayers(shape, status, expected));
    }
  });

  it("keeps crown corners rounded where they touch the body, including offline", () => {
    const crown = (online: boolean) =>
      paAvatarLayers("blob", { online, isDefault: true }).find((layer) => layer.tone === "warn")?.d;
    const path = crown(true);
    expect(path).toContain(
      "M7.425 1.975H7.575A0.45 0.45 0 0 1 8.025 2.425V2.575A0.45 0.45 0 0 1 7.575 3.025",
    );
    expect(crown(false)).toBe(path);
  });

  it("dots running and waiting Bots amber, unread finished Bots green, and idle Bots not at all", () => {
    const dot = (status: Parameters<typeof paAvatarCells>[1]) =>
      paAvatarCells("circle", status).get(at(18, 18));
    expect(dot({ working: true })).toBe("warn");
    expect(dot({ working: true, unread: true })).toBe("warn");
    expect(dot({ working: true, awaiting: true, unread: true })).toBe("warn");
    expect(dot({ unread: true })).toBe("success");
    expect(dot({})).toBeUndefined();
    expect(dot({ online: false, working: true })).toBeUndefined();
    expect(paAvatarLayers("circle", { unread: true }).map((layer) => layer.tone)).toContain(
      "success",
    );
    expect(
      paAvatarLayers("circle", { online: false, unread: true, isDefault: true }).map(
        (layer) => layer.tone,
      ),
    ).toEqual(["muted", "warn", "success"]);
  });

  it("rounds only outside corners", () => {
    const [body] = paAvatarLayers("blob", {});
    // The top-left cell of the core rounds its outer corner; an interior cell stays square.
    expect(body!.d).toContain("M4.425 2.975");
    expect(body!.d).toContain("M8.975 7.975H10.025V9.025H8.975V7.975Z");
  });
});

it("shares one frame timer and releases it when the last visible avatar leaves", () => {
  vi.useFakeTimers({ now: 0 });
  try {
    const first = paAvatarFrameTick.subscribe(() => {});
    const last = paAvatarFrameTick.subscribe(() => last());
    expect(vi.getTimerCount()).toBe(1);
    first();
    vi.advanceTimersByTime(180);
    expect(vi.getTimerCount()).toBe(0);
    const resume = paAvatarFrameTick.subscribe(() => {});
    vi.advanceTimersByTime(180);
    expect(paAvatarFrameTick.getSnapshot()).toBe(2);
    resume();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
