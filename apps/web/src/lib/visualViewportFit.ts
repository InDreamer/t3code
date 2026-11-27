type FitWindow = Pick<Window, "innerHeight" | "scrollY" | "scrollTo" | "visualViewport"> & {
  readonly document: {
    readonly documentElement: Pick<HTMLElement, "style" | "setAttribute" | "removeAttribute">;
  };
};

const KEYBOARD_THRESHOLD = 150;
const HEIGHT_PROPERTY = "--app-viewport-height";
const OFFSET_PROPERTY = "--app-viewport-offset-top";
export const VISUAL_VIEWPORT_FIT_ATTRIBUTE = "data-visual-viewport-fit";

/**
 * iOS WebKit ignores `interactive-widget=resizes-content`: its keyboard shrinks only the visual
 * viewport and scrolls the full-height page up to the focused field, taking the header with it.
 * While that happens this sizes the shell to the visible area and pins it there. Browsers that
 * resize the layout viewport keep `innerHeight` equal to the visual height and never trip it.
 */
export function fitShellToVisualViewport(
  win: FitWindow | undefined,
  isDesktop: boolean,
): () => void {
  const viewport = isDesktop ? undefined : win?.visualViewport;
  if (!win || !viewport) return () => {};
  const root = win.document.documentElement;
  let fitted: { height: number; offsetTop: number } | null = null;

  const release = () => {
    root.style.removeProperty(HEIGHT_PROPERTY);
    root.style.removeProperty(OFFSET_PROPERTY);
    root.removeAttribute(VISUAL_VIEWPORT_FIT_ATTRIBUTE);
    fitted = null;
  };

  const update = () => {
    const height = Math.round(viewport.height);
    // A pinch zoom shrinks the visual viewport too; only a keyboard does it at scale 1.
    const covered =
      Math.abs(viewport.scale - 1) < 0.01 && win.innerHeight - height > KEYBOARD_THRESHOLD;
    if (!covered && fitted === null) return;
    // The app never scrolls the window, so any drift is the keyboard's reveal scroll.
    if (win.scrollY !== 0) win.scrollTo(0, 0);
    if (!covered) {
      release();
      return;
    }
    const offsetTop = Math.max(0, Math.round(viewport.offsetTop));
    if (fitted?.height !== height) {
      // The shell sits under #root's top safe-area padding.
      root.style.setProperty(HEIGHT_PROPERTY, `calc(${height}px - env(safe-area-inset-top))`);
    }
    if (fitted?.offsetTop !== offsetTop) root.style.setProperty(OFFSET_PROPERTY, `${offsetTop}px`);
    if (fitted === null) root.setAttribute(VISUAL_VIEWPORT_FIT_ATTRIBUTE, "");
    fitted = { height, offsetTop };
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    if (fitted !== null) release();
  };
}
