import type { Power, Unit, UnitType } from '../engine/types.js';
import {
  NEUTRAL_UNIT_FILL,
  POWER_COLORS,
  UNIT_FILL_OPACITY,
  UNIT_STROKE_WIDTH,
} from './colors.js';
import { svgEl } from './svg.js';

/**
 * The board's mark vocabulary: units, births, arrows, brackets, crosses, and the small
 * geometry helpers they share. Nothing here knows about the game state or the layers —
 * every function takes the anchors it draws between, so the live overlays
 * (`board.ts`) and the export legend (`board-export.ts`) draw the *same* marks.
 */

export const UNIT_R = 15;
/** Arrowhead lengths, in viewBox units. The shaft stops this far short of the tip. */
export const HEAD_MOVE = 20;
export const HEAD_ASSIST = 15;

/** Two anchors close enough that a line between them is noise, not direction. */
export function degenerate(a: [number, number], b: [number, number]): boolean {
  return Math.hypot(b[0] - a[0], b[1] - a[1]) < UNIT_R;
}

export function fade(node: SVGElement, opacity: number): SVGElement {
  if (opacity >= 1) return node;
  node.setAttribute('opacity', String(opacity));
  return node;
}

/**
 * Cached `<marker>` elements, one per (colour, length): `refX: 0` and
 * `markerUnits: userSpaceOnUse` put the head's *base* at the line's end point and its tip
 * `len` further along, which is what lets `drawOrders` stop the shaft at the base instead
 * of running it out through the tip. Arrowheads are per-colour now that arrows carry the
 * power's legend colour.
 */
export class MarkerCache {
  private readonly markers = new Map<string, string>();

  constructor(private readonly defs: SVGDefsElement) {}

  /** The `url()` reference for an arrowhead in `color`, `len` viewBox units long. */
  ref(color: string, len: number): string {
    const key = `${color}|${len}`;
    const existing = this.markers.get(key);
    if (existing) return existing;
    const id = `arw-${this.markers.size}`;
    this.defs.append(
      svgEl(
        'marker',
        {
          id,
          viewBox: '0 0 10 8',
          refX: '0',
          refY: '4',
          markerUnits: 'userSpaceOnUse',
          markerWidth: len,
          markerHeight: len * 0.8,
          orient: 'auto',
        },
        [svgEl('path', { d: 'M 0 0 L 10 4 L 0 8 z', fill: color })],
      ),
    );
    const url = `url(#${id})`;
    this.markers.set(key, url);
    return url;
  }
}

/**
 * Backstabbr's unit treatment (opaque outline in the power's colour, translucent fill
 * of the same colour) plus a universal casing: a dark outer stroke and a light inner
 * halo, so France's lavender survives the lavender sea and Turkey's yellow survives
 * Turkish territory. No power initial: people read "A"/"F" as army/fleet, so identity
 * is carried by colour and the casing, and *type* by the shape alone — army ○,
 * fleet ▽ (vertex down, so it can't be confused with the old ▲).
 */
export function unitGlyph(u: Unit, a: [number, number], opts: { dislodged?: boolean } = {}): SVGGElement {
  const [x, y] = a;
  // Neutrals are units like any other; white is simply their power colour. The old
  // ghost treatment — dashed edge, dashed outer ring, no dark casing — borrowed the
  // birth marker's grammar, so a standing neutral and a pending birth read as the
  // same thing. Same casing, same halo, same shapes; only the colour differs.
  const neutral = u.power === 'NEUTRAL';
  const color = neutral ? NEUTRAL_UNIT_FILL : POWER_COLORS[u.power].unit;
  const g = svgEl('g', { class: 'unit', 'data-unit': u.loc, 'pointer-events': 'none' });
  const geom = shapeGeom(u.type, a, UNIT_R);
  const tag = geom.tag;
  const casing = (stroke: string, extra: number) =>
    svgEl(tag as 'circle', { ...geom.attrs, fill: 'none', stroke, 'stroke-width': UNIT_STROKE_WIDTH + extra });

  g.append(casing('#14161a', 4.5));
  g.append(casing('rgba(255,255,255,0.9)', 2));
  g.append(
    svgEl(tag as 'circle', {
      ...geom.attrs,
      fill: color,
      'fill-opacity': UNIT_FILL_OPACITY,
      stroke: color,
      'stroke-width': UNIT_STROKE_WIDTH,
    }),
  );
  if (opts.dislodged) {
    g.append(
      svgEl('circle', { cx: x, cy: y, r: UNIT_R + 8, fill: 'none', stroke: '#cc2b2b', 'stroke-width': 3.5 }),
    );
  }
  return g;
}

/**
 * One marker grammar for births — for every power including NEUTRAL, whose colour is
 * just white: a hollow, dashed outline in the owner's colour over a dark casing. The
 * *shape* carries what is known — circle for an army, ▽ for a fleet, and a circle with
 * "?" only while the GM still has to pick. (A sea birth is always a fleet, so it draws
 * as one; the "?" now appears solely for great-power coastal births.) Dashes are the
 * thing that says "not yet real", and they belong only here — a standing unit never
 * gets them.
 */
export function birthGlyph(power: Power, a: [number, number], type: UnitType | null): SVGGElement {
  const [x, y] = a;
  const c = POWER_COLORS[power];
  const edge = power === 'NEUTRAL' ? NEUTRAL_UNIT_FILL : c.unit;
  const geom = shapeGeom(type ?? 'A', a, UNIT_R + 6);
  const tag = geom.tag as 'circle';
  const g = svgEl('g', { class: 'birth', 'pointer-events': 'none' }, [
    svgEl(tag, {
      ...geom.attrs,
      fill: '#ffffff',
      'fill-opacity': 0.7,
      stroke: '#14161a',
      'stroke-width': 6.5,
      'stroke-dasharray': '6 5',
    }),
    svgEl(tag, {
      ...geom.attrs,
      fill: 'none',
      stroke: edge,
      'stroke-width': 4,
      'stroke-dasharray': '6 5',
    }),
  ]);
  if (!type) g.append(glyphLabel('?', x, y + 8, 22, c.edge));
  return g;
}

/**
 * A bare line in the power's colour, with no outline under it: a marker-drawn
 * arrowhead can't carry an under-stroke, so a halo would outline the shaft and stop
 * dead at the head, which reads worse than no outline at all. Opacity and width are
 * what make the arrow stand off the map.
 */
export function shaft(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  marker?: string,
  dash?: string,
  opacity = 1,
): SVGGElement {
  return svgEl('g', { 'pointer-events': 'none', opacity }, [
    svgEl('line', {
      x1, y1, x2, y2,
      stroke: color,
      'stroke-width': width,
      'stroke-linecap': 'round',
      'stroke-dasharray': dash,
      'marker-end': marker,
    }),
  ]);
}

/**
 * Holds get a bracketed square, deliberately a different *shape* from the dislodged
 * ring — colour alone doesn't survive a compressed screenshot.
 */
export function holdMark([x, y]: [number, number], color: string): SVGGElement {
  const r = UNIT_R + 10;
  const arm = 12;
  const corners = [
    `M ${x - r} ${y - r + arm} L ${x - r} ${y - r} L ${x - r + arm} ${y - r}`,
    `M ${x + r - arm} ${y - r} L ${x + r} ${y - r} L ${x + r} ${y - r + arm}`,
    `M ${x + r} ${y + r - arm} L ${x + r} ${y + r} L ${x + r - arm} ${y + r}`,
    `M ${x - r + arm} ${y + r} L ${x - r} ${y + r} L ${x - r} ${y + r - arm}`,
  ].join(' ');
  return svgEl('g', { class: 'hold-mark', 'pointer-events': 'none' }, [
    svgEl('path', { d: corners, fill: 'none', stroke: color, 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  ]);
}

export function cross([x, y]: [number, number], color: string, r = 12, w = 4, halo = false): SVGElement {
  const g = svgEl('g', { 'pointer-events': 'none' });
  if (halo) {
    g.append(
      svgEl('line', { x1: x - r, y1: y - r, x2: x + r, y2: y + r, stroke: '#ffffff', 'stroke-width': w + 4, 'stroke-linecap': 'round' }),
      svgEl('line', { x1: x - r, y1: y + r, x2: x + r, y2: y - r, stroke: '#ffffff', 'stroke-width': w + 4, 'stroke-linecap': 'round' }),
    );
  }
  g.append(
    svgEl('line', { x1: x - r, y1: y - r, x2: x + r, y2: y + r, stroke: color, 'stroke-width': w, 'stroke-linecap': 'round' }),
    svgEl('line', { x1: x - r, y1: y + r, x2: x + r, y2: y - r, stroke: color, 'stroke-width': w, 'stroke-linecap': 'round' }),
  );
  return g;
}

/**
 * A Life death, deliberately unlike the thin ✕ that marks a failed move: a pale
 * halo, a white outline stroke and a heavy red ✕ over it, drawn above the units so
 * a screenshot reads at a glance.
 */
export function deathMark(a: [number, number]): SVGElement {
  const [x, y] = a;
  const g = svgEl('g', { class: 'life-death', 'pointer-events': 'none' }, [
    svgEl('circle', { cx: x, cy: y, r: UNIT_R + 12, fill: '#ffffff', 'fill-opacity': 0.55 }),
  ]);
  g.append(cross(a, '#ffffff', 20, 12));
  g.append(cross(a, '#c40d0d', 20, 6.5));
  return g;
}

/**
 * The one place unit-vs-fleet geometry is defined: army = circle of `r`, fleet = triangle
 * with the vertex DOWN, sized to sit inside the same circle. Used by live units and by
 * birth markers, so the two share a shape vocabulary and differ only in their stroke.
 */
function shapeGeom(
  type: UnitType,
  [x, y]: [number, number],
  r: number,
): { tag: 'circle' | 'path'; attrs: Record<string, string | number> } {
  if (type === 'A') return { tag: 'circle', attrs: { cx: x, cy: y, r } };
  const w = r + 2;
  return {
    tag: 'path',
    attrs: {
      d: `M ${x} ${y + r + 2} L ${x + w} ${y - r + 3} L ${x - w} ${y - r + 3} z`,
      'stroke-linejoin': 'round',
    },
  };
}

/** A letter drawn over a busy glyph: dark ink, white casing, via `paint-order: stroke`. */
function glyphLabel(text: string, x: number, y: number, size: number, fill: string): SVGTextElement {
  return svgEl('text', {
    x,
    y,
    'text-anchor': 'middle',
    'font-size': size,
    'font-weight': 800,
    'font-family': 'system-ui, -apple-system, Helvetica, Arial, sans-serif',
    fill,
    stroke: '#ffffff',
    'stroke-width': size * 0.22,
    'stroke-opacity': 0.92,
    'paint-order': 'stroke',
    'stroke-linejoin': 'round',
    'pointer-events': 'none',
  }, [text]);
}

/** Measured text width, falling back to a rough estimate when layout isn't available. */
export function measureWidth(node: SVGTextElement, fontSize: number): number {
  try {
    const w = node.getComputedTextLength();
    if (w > 0) return w;
  } catch {
    /* jsdom / detached SVG */
  }
  return (node.textContent ?? '').length * fontSize * 0.58;
}

export function scaled(node: SVGElement, cx: number, cy: number, k: number): SVGElement {
  return svgEl('g', { transform: `translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})` }, [node]);
}

/** Slide a segment sideways by `d`, so a mutual bounce draws as two parallel arrows. */
export function shift(
  a: [number, number],
  b: [number, number],
  d: number,
): [[number, number], [number, number]] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * d;
  const ny = (dx / len) * d;
  return [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
  ];
}

/**
 * Segment from `a` to `b` with the ends pulled in. If the two pads don't fit they are
 * scaled down together rather than clipped independently, so the ratio between them —
 * and with it the room reserved for the arrowhead — survives on a short arrow.
 */
export function trim(a: [number, number], b: [number, number], startPad: number, endPad: number): [number, number, number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const room = Math.max(len - 2, 0);
  const k = startPad + endPad > room ? room / (startPad + endPad) : 1;
  const s = startPad * k;
  const e = endPad * k;
  return [a[0] + ux * s, a[1] + uy * s, b[0] - ux * e, b[1] - uy * e];
}
