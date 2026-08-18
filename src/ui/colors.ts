import type { Power } from '../engine/types.js';

/**
 * Backstabbr's palette, which keeps *two* colours per power. The **legend**
 * colour, from its `colors_default.css`, is what text, units and order arrows
 * use; the **map** colour is a perceptibly desaturated version, eyedropped from
 * the home-supply-centre squares, composited over the land at ~31% alpha to make
 * the territory fill. Russia is not recorded in that stylesheet — its magenta is
 * approximated from screenshots and reused for both roles.
 */
export interface PowerPalette {
  /** Legend colour: units, arrows, chips, tab accents. */
  unit: string;
  /** Territory fill = `map` composited at 31% over LAND_FILL. */
  fill: string;
  /** Desaturated map colour (the home-SC square). */
  map: string;
  /** A darker draw-on-light variant of `unit`, for small text. */
  edge: string;
}

export const POWER_COLORS: Record<Power, PowerPalette> = {
  AUSTRIA: { unit: '#cc0000', map: '#bb271a', fill: '#d4a593', edge: '#67150e' },
  ENGLAND: { unit: '#0000aa', map: '#0000a3', fill: '#9a98bd', edge: '#00005a' },
  FRANCE:  { unit: '#9999ff', map: '#9999f8', fill: '#c9c8d8', edge: '#545488' },
  GERMANY: { unit: '#000000', map: '#000000', fill: '#9a988b', edge: '#000000' },
  ITALY:   { unit: '#00aa00', map: '#4ca730', fill: '#b1cc9a', edge: '#2a5c1a' },
  RUSSIA:  { unit: '#cc33cc', map: '#cc33cc', fill: '#d9a8ca', edge: '#701c70' },
  TURKEY:  { unit: '#bbbb00', map: '#bbbb3b', fill: '#d4d29d', edge: '#676720' },
  NEUTRAL: { unit: '#8a8a8a', map: '#8a8a8a', fill: '#c5c3b5', edge: '#4c4c4c' },
};

/** Land that isn't a supply centre. */
export const UNOWNED_FILL = '#dfddc9';
/** A supply centre nobody owns — the same ground, lifted 30% toward white. */
export const NEUTRAL_SC_FILL = '#e9e7d9';
export const SEA_FILL = '#b9bce4';
/** Impassable ground: solid, near the border ink, unlike any power tint. */
export const IMPASSABLE_FILL = '#2b2f33';
export const BACKGROUND_LAND = '#cfcdb9';
export const BACKGROUND_SEA = '#a9acd4';
export const PROVINCE_STROKE = '#33383d';
/** Painted behind everything; shows through the hairline gaps between province paths. */
export const BACKDROP = '#22262a';

/** Units: an opaque outline in the power's colour carries the shape... */
export const UNIT_STROKE_WIDTH = 3;
/** ...while the fill only tints, so black Germany still reads on a dark territory. */
export const UNIT_FILL_OPACITY = 0.55;

/**
 * Neutrals are drawn as ghosts, not as a grey power. A mid-grey solid sat one step from
 * Germany's black and was unreadable beside it; a neutral never moves and never issues an
 * order, so it gets a near-white body, a mid-grey edge and a dashed ring — "inert" rather
 * than "an eighth player in grey". Deliberately no dark casing: the pale body is the cue.
 */
export const NEUTRAL_UNIT_FILL = '#f4f4f0';
export const NEUTRAL_UNIT_EDGE = '#8a8a8a';
export const NEUTRAL_UNIT_CASING = '#ffffff';


/** One letter per power — the identity cue that survives a compressed chat image. */
export const POWER_INITIAL: Record<Power, string> = {
  AUSTRIA: 'A',
  ENGLAND: 'E',
  FRANCE: 'F',
  GERMANY: 'G',
  ITALY: 'I',
  RUSSIA: 'R',
  TURKEY: 'T',
  NEUTRAL: 'N',
};

/** Perceptual luminance of a `#rrggbb` colour, 0 (black) – 1 (white). */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
}

/**
 * A `#rrggbb` colour with every channel scaled by `factor` and clamped — what
 * `filter: brightness()` would have done, done to the fill itself.
 *
 * It has to be done this way: WebKit computes `filter: brightness()` on an SVG child
 * element but never paints it, so a CSS-filter hover highlight is invisible in Safari.
 * Writing the lightened colour straight into `fill` needs no filter and works everywhere.
 */
export function brighten(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(c * factor))),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The under-stroke drawn beneath an order line in `color`: near-white under dark
 * colours, near-black under pale ones. Either way the arrow keeps its own edge over
 * a green Italian province, a lavender sea or a black-bordered German tint.
 */
export function haloFor(color: string): string {
  return luminance(color) > 0.55 ? '#1b1d22' : '#ffffff';
}

export const POWER_ADJECTIVE: Record<Power, string> = {
  AUSTRIA: 'Austrian',
  ENGLAND: 'English',
  FRANCE: 'French',
  GERMANY: 'German',
  ITALY: 'Italian',
  RUSSIA: 'Russian',
  TURKEY: 'Turkish',
  NEUTRAL: 'neutral',
};

export function powerTitle(p: Power): string {
  return p.charAt(0) + p.slice(1).toLowerCase();
}
