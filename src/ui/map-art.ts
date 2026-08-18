import type { Loc, ProvinceId } from '../engine/types.js';
import { coastOf, provinceOf } from '../engine/map-utils.js';

export interface MapArtData {
  source: string;
  viewBox: string;
  /** Province outlines live in a translated group; anchors/labels are in page coords. */
  pathOffset: { x: number; y: number };
  /**
   * `d` is the *tile*: jDip's outline grown into a true partition of the board, so
   * neighbours share an exact edge and there is nothing between them to hide. `raw` is
   * jDip's own outline, kept for reference — the tiles are derived from it and nothing
   * draws it. See `src/data/build-standard-art.py`.
   */
  provinces: Record<ProvinceId, { d: string; raw?: string; kind: 'land' | 'sea' | 'impassable' }>;
  /**
   * Water that lies *inside* a land province and belongs to it: the Danish belts and the
   * Bosporus. Not part of the province fill (it is water), but part of the province for
   * clicking, and outlined with it.
   */
  waterInsets: Record<ProvinceId, string>;
  /** Tile ∪ water inset: the whole of what a click on the province should cover. */
  hitAreas?: Record<ProvinceId, string>;
  /** Navigable cuts drawn as a thin sea-coloured line across a province (Kiel). */
  canals: Record<ProvinceId, string>;
  /** Outlines for split-coast halves, keyed 'spa/nc'. */
  coasts: Record<Loc, string>;
  /** Decorative out-of-play landmass / ocean. */
  background: Record<string, string>;
  /**
   * Out-of-play islands that sit as holes in the tiling — Iceland and Ireland. These are
   * the *holes themselves*, not jDip's decorative outline of each island: the outline is a
   * few units inside its hole, so drawing it left a ring of sea between the island and the
   * coastline the surrounding sea tiles draw around it.
   */
  islands?: string[];
  unitAnchors: Record<Loc, [number, number]>;
  dislodgedAnchors: Record<Loc, [number, number]>;
  labels: Record<ProvinceId, { x: number; y: number; text: string }>;
  scDots: Record<ProvinceId, [number, number]>;
  /** Alternate province spellings ('gol' -> 'lyo'). */
  aliases: Record<string, ProvinceId>;
}

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Everything the board renderer needs from the map art, so art can be swapped. */
export interface MapArt {
  readonly viewBox: ViewBox;
  readonly pathOffset: { x: number; y: number };
  readonly provinceIds: ProvinceId[];
  provincePath(id: ProvinceId): string | null;
  /** Province outline plus any water inset: what a click on the province should cover. */
  provinceArea(id: ProvinceId): string | null;
  waterInsetPath(id: ProvinceId): string | null;
  canalPath(id: ProvinceId): string | null;
  provinceKind(id: ProvinceId): 'land' | 'sea' | 'impassable' | null;
  coastPath(loc: Loc): string | null;
  coastsOf(id: ProvinceId): Loc[];
  /** Where to draw a unit sitting at `loc` (coast-aware, falls back to the province). */
  unitAnchor(loc: Loc): [number, number] | null;
  dislodgedAnchor(loc: Loc): [number, number] | null;
  labelAnchor(id: ProvinceId): { x: number; y: number; text: string } | null;
  scDot(id: ProvinceId): [number, number] | null;
  backgroundPaths(): { id: string; d: string; water: boolean }[];
  /** Land to paint over the holes in the tiling (Iceland, Ireland). */
  islandPaths(): string[];
  /** Canonical province id for an arbitrary spelling; null if unknown. */
  canonical(raw: string): ProvinceId | null;
}

function parseViewBox(s: string): ViewBox {
  const [x = 0, y = 0, w = 0, h = 0] = s.trim().split(/[\s,]+/).map(Number);
  return { x, y, w, h };
}

/**
 * How a province name is written for a human: seas shout (NTH, MAO), land does not
 * (Par, Bur, Stp). Order *parsing* is untouched — this is presentation only.
 */
export function provinceLabel(id: ProvinceId, isSea: boolean): string {
  return isSea ? id.toUpperCase() : id.charAt(0).toUpperCase() + id.slice(1).toLowerCase();
}

export function createMapArt(data: MapArtData): MapArt {
  const vb = parseViewBox(data.viewBox);
  const ids = Object.keys(data.provinces).sort();
  const coastsByProvince = new Map<ProvinceId, Loc[]>();
  for (const loc of Object.keys(data.coasts)) {
    const p = provinceOf(loc);
    const list = coastsByProvince.get(p) ?? [];
    list.push(loc);
    coastsByProvince.set(p, list);
  }

  const canon = (raw: string): ProvinceId | null => {
    const p = provinceOf(raw.trim().toLowerCase());
    if (data.provinces[p]) return p;
    const alias = data.aliases[p];
    return alias && data.provinces[alias] ? alias : null;
  };

  const resolveLoc = (loc: Loc): Loc | null => {
    const p = canon(loc);
    if (!p) return null;
    const c = coastOf(loc.trim().toLowerCase());
    return c ? `${p}/${c}` : p;
  };

  return {
    viewBox: vb,
    pathOffset: data.pathOffset,
    provinceIds: ids,
    provincePath: (id) => {
      const p = canon(id);
      return p ? (data.provinces[p]?.d ?? null) : null;
    },
    provinceArea: (id) => {
      const p = canon(id);
      if (!p) return null;
      return data.hitAreas?.[p] ?? data.provinces[p]?.d ?? null;
    },
    waterInsetPath: (id) => {
      const p = canon(id);
      return p ? (data.waterInsets?.[p] ?? null) : null;
    },
    canalPath: (id) => {
      const p = canon(id);
      return p ? (data.canals?.[p] ?? null) : null;
    },
    provinceKind: (id) => {
      const p = canon(id);
      return p ? (data.provinces[p]?.kind ?? null) : null;
    },
    coastPath: (loc) => {
      const l = resolveLoc(loc);
      return l ? (data.coasts[l] ?? null) : null;
    },
    coastsOf: (id) => {
      const p = canon(id);
      return p ? (coastsByProvince.get(p) ?? []) : [];
    },
    unitAnchor: (loc) => {
      const l = resolveLoc(loc);
      if (!l) return null;
      return data.unitAnchors[l] ?? data.unitAnchors[provinceOf(l)] ?? null;
    },
    dislodgedAnchor: (loc) => {
      const l = resolveLoc(loc);
      if (!l) return null;
      return data.dislodgedAnchors[l] ?? data.dislodgedAnchors[provinceOf(l)] ?? null;
    },
    labelAnchor: (id) => {
      const p = canon(id);
      return p ? (data.labels[p] ?? null) : null;
    },
    scDot: (id) => {
      const p = canon(id);
      return p ? (data.scDots[p] ?? null) : null;
    },
    backgroundPaths: () =>
      Object.entries(data.background).map(([id, d]) => ({ id, d, water: id.includes('water') })),
    islandPaths: () => data.islands ?? [],
    canonical: canon,
  };
}
