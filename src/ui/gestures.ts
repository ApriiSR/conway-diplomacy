import type { App } from './main.js';
import { el } from './svg.js';

/** Below this the panel becomes a bottom sheet and the board takes the whole viewport.
 *  Two thresholds (not one) give the switch hysteresis: once mobile, width has to climb
 *  past MOBILE_EXIT — not just back past MOBILE_MAX — before it reverts. Without that gap
 *  a width sitting right on the line (a fractional zoom level, a scrollbar toggling on/off)
 *  flips the layout back and forth on every recheck. */
export const MOBILE_MAX = 699;
export const MOBILE_EXIT = 719;
/** Roughly the centre of the played-on landmass, for the phone's opening crop. */
const LAND_CENTRE_X = 830;

/**
 * Hysteresis around the boundary: stay in whatever mode we were last in until the
 * width clears the *other* threshold, not just the nearer one.
 */
export function isMobile(wasMobile: boolean): boolean {
  const w = window.innerWidth;
  if (wasMobile) return w <= MOBILE_EXIT;
  return w <= MOBILE_MAX;
}

/**
 * A landscape map inside a portrait phone letterboxes to a useless sliver, so the phone
 * opens on a height-filling crop of central Europe instead of the whole board; a
 * double-tap swaps between that and the full map.
 */
function mobileFit(app: App): { x: number; y: number; w: number; h: number } {
  const full = app.board.fullViewBox;
  const svg = app.board.svg;
  const vw = svg.clientWidth || 375;
  const vh = svg.clientHeight || 700;
  const w = Math.min(full.w, full.h * (vw / vh));
  const x = Math.min(Math.max(LAND_CENTRE_X - w / 2, full.x), full.x + full.w - w);
  return { x, y: full.y, w, h: full.h };
}

/**
 * Touch-only viewBox gestures: one finger pans, two pinch, double-tap resets. Mouse
 * clicks are untouched, so the desktop click-to-order flow is unaffected.
 */
export function installGestures(app: App): void {
  const svg = app.board.svg;
  const full = app.board.fullViewBox;
  let vb = { ...full };
  let start: { vb: typeof vb; pts: { x: number; y: number }[]; dist: number } | null = null;
  let moved = false;
  let lastTap = 0;

  app.applyMobileView = (fit: boolean) => {
    vb = fit ? mobileFit(app) : { ...full };
    app.board.setViewBox(vb.x, vb.y, vb.w, vb.h);
  };

  const scale = () => vb.w / (svg.clientWidth || vb.w);
  const centre = (t: TouchList) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < t.length; i++) {
      x += t[i]!.clientX;
      y += t[i]!.clientY;
    }
    return { x: x / t.length, y: y / t.length };
  };
  const spread = (t: TouchList) =>
    t.length < 2 ? 0 : Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);

  svg.addEventListener(
    'touchstart',
    (e) => {
      if (!app.mobile) return;
      moved = false;
      const c = centre(e.touches);
      start = { vb: { ...vb }, pts: [c], dist: spread(e.touches) };
      if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 320) {
          // Toggle: whole board ⇄ the height-filling crop.
          app.applyMobileView(Math.abs(vb.w - full.w) < 4);
          moved = true;
        }
        lastTap = now;
      }
    },
    { passive: true },
  );

  svg.addEventListener(
    'touchmove',
    (e) => {
      if (!app.mobile || !start) return;
      const c = centre(e.touches);
      const k = scale();
      let w = start.vb.w;
      let h = start.vb.h;
      if (e.touches.length >= 2 && start.dist > 0) {
        const ratio = spread(e.touches) / start.dist;
        const clamped = Math.min(4, Math.max(0.35, ratio));
        w = start.vb.w / clamped;
        h = start.vb.h / clamped;
      }
      const dx = (c.x - start.pts[0]!.x) * k;
      const dy = (c.y - start.pts[0]!.y) * k;
      if (Math.hypot(dx, dy) > 6 || w !== start.vb.w) moved = true;
      if (!moved) return;
      e.preventDefault();
      vb = {
        x: start.vb.x - dx + (start.vb.w - w) / 2,
        y: start.vb.y - dy + (start.vb.h - h) / 2,
        w,
        h,
      };
      app.board.setViewBox(vb.x, vb.y, vb.w, vb.h);
    },
    { passive: false },
  );

  const end = () => {
    start = null;
  };
  svg.addEventListener('touchend', end, { passive: true });
  svg.addEventListener('touchcancel', end, { passive: true });
}

export function syncLayoutClass(app: App): void {
  const html = document.documentElement;
  const wasMobile = app.mobileState;
  app.mobileState = app.mobile;
  html.classList.toggle('is-mobile', app.mobileState);
  html.classList.toggle('sheet-open', app.mobileState && app.sheetOpen);
  if (app.mobileState !== wasMobile) {
    // Let the class change lay out before measuring the SVG for the fit.
    requestAnimationFrame(() => app.applyMobileView(app.mobileState));
  }
}

/** The bottom sheet's grab handle: the only way to reach the panel on a phone. */
export function sheetHandle(app: App): HTMLElement {
  const b = el('button', { class: 'sheet-handle', 'aria-expanded': String(app.sheetOpen) }, [
    app.sheetOpen ? 'Hide orders ▾' : 'Orders ▴',
  ]);
  b.addEventListener('click', () => {
    app.sheetOpen = !app.sheetOpen;
    syncLayoutClass(app);
    app.render();
  });
  return b;
}
