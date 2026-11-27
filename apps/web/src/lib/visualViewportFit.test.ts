import { describe, expect, it, vi } from "vite-plus/test";

import { fitShellToVisualViewport, VISUAL_VIEWPORT_FIT_ATTRIBUTE } from "./visualViewportFit";

function fixture() {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const properties = new Map<string, string>();
  const attributes = new Set<string>();
  const win = {
    innerHeight: 844,
    scrollY: 0,
    scrollTo: vi.fn(() => {
      win.scrollY = 0;
    }),
    visualViewport: viewport,
    document: {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
        setAttribute: (name: string) => attributes.add(name),
        removeAttribute: (name: string) => attributes.delete(name),
      },
    },
  };
  const change = (next: Partial<{ height: number; offsetTop: number; scale: number }>) => {
    Object.assign(viewport, next);
    viewport.dispatchEvent(new Event(next.height === undefined ? "scroll" : "resize"));
  };
  const shellFit = () => ({
    height: properties.get("--app-viewport-height"),
    offsetTop: properties.get("--app-viewport-offset-top"),
    active: attributes.has(VISUAL_VIEWPORT_FIT_ATTRIBUTE),
  });
  return { win, viewport, change, shellFit };
}

const install = (win: ReturnType<typeof fixture>["win"], isDesktop = false) =>
  fitShellToVisualViewport(win as unknown as Window, isDesktop);

describe("visual viewport shell fit", () => {
  // regression: iOS keyboard scrolled the PA Bots and thread headers off-screen
  it("fits the shell to an iOS keyboard and undoes the reveal scroll", () => {
    const { win, change, shellFit } = fixture();
    const stop = install(win);
    expect(shellFit()).toEqual({ height: undefined, offsetTop: undefined, active: false });

    win.scrollY = 380;
    change({ height: 464 });
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(win.scrollY).toBe(0);
    expect(shellFit()).toEqual({
      height: "calc(464px - env(safe-area-inset-top))",
      offsetTop: "0px",
      active: true,
    });

    change({ offsetTop: 120 });
    expect(shellFit().offsetTop).toBe("120px");

    change({ height: 844, offsetTop: 0 });
    expect(shellFit()).toEqual({ height: undefined, offsetTop: undefined, active: false });
    stop();
  });

  it("leaves browsers that resize the layout viewport alone", () => {
    const { win, change, shellFit } = fixture();
    const stop = install(win);
    win.innerHeight = 464;
    change({ height: 464 });
    expect(shellFit().active).toBe(false);
    expect(win.scrollTo).not.toHaveBeenCalled();
    stop();
  });

  it("ignores a pinch zoom", () => {
    const { win, change, shellFit } = fixture();
    const stop = install(win);
    change({ height: 422, scale: 2 });
    expect(shellFit().active).toBe(false);
    stop();
  });

  it("fits a keyboard that opened before it was installed, and clears on cleanup", () => {
    const { win, viewport, change, shellFit } = fixture();
    viewport.height = 464;
    const stop = install(win);
    expect(shellFit().active).toBe(true);

    stop();
    expect(shellFit()).toEqual({ height: undefined, offsetTop: undefined, active: false });
    change({ height: 400 });
    expect(shellFit().active).toBe(false);
  });

  it("does nothing on desktop", () => {
    const { win, viewport, shellFit } = fixture();
    viewport.height = 464;
    install(win, true)();
    expect(shellFit().active).toBe(false);
  });
});
