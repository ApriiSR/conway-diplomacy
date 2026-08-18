import type { GameState, MapData, Power, ProvinceId } from '../engine/types.js';
import {
  BACKGROUND_LAND,
  BACKGROUND_SEA,
  brighten,
  IMPASSABLE_FILL,
  NEUTRAL_SC_FILL,
  POWER_COLORS,
  PROVINCE_STROKE,
  SEA_FILL,
  UNOWNED_FILL,
} from './colors.js';
import type { MapArt } from './map-art.js';
import { provinceLabel } from './map-art.js';
import { clear, svgEl } from './svg.js';

/**
 * The map itself: the tiles, their borders, the canal, the invisible hit layer, the
 * province names and the supply-centre dots. Everything here is a function of the *art*
 * and the map graph — the only per-render input is which power owns which centre, which
 * decides a tile's fill. The moving parts (units, orders, Life marks, selection) are
 * drawn over the top by `board.ts`.
 */

/**
 * The single border pass, in viewBox units. It can be this thin because the art build
 * grows every outline into a true partition: adjacent provinces share one exact edge, so
 * the two coincident strokes land on top of each other instead of reading as a doubled
 * hairline with a gap down the middle.
 */
const BORDER_WIDTH = 2;
/**
 * The frame around the whole board, in viewBox units. The art build now runs the tiles out
 * to the page edge, so the sea reaches the rim and this is the map's outer coastline: a
 * dark line like every other border, rather than a pale ring of out-of-play sea.
 * Drawn inset by half its width so the whole stroke lands inside the viewBox.
 */
const FRAME_WIDTH = 4;
/** The Kiel canal, Backstabbr-style: a band of sea this wide, with a dark shore either
 * side of it. Drawn under the border pass, so it never notches the coastline. */
const CANAL_WIDTH = 7;
const CANAL_EDGE = 2;
/** Halo under a province name, for the ones that have to cross their own border. */
const LABEL_HALO = 'rgba(255,255,255,0.85)';
const LABEL_HALO_WIDTH = 3;
/** How far a hovered province's fill is lifted — the old `brightness(1.13)`, in colour. */
const HOVER_BRIGHTEN = 1.13;

export interface StaticMapHost {
  art: MapArt;
  svg: SVGSVGElement;
  defs: SVGDefsElement;
  layers: Record<string, SVGGElement>;
  /** Filled in with the recolourable fill path of every province. */
  hitPaths: Map<ProvinceId, SVGPathElement>;
  onProvinceClick: (id: ProvinceId, ev: MouseEvent) => void;
  /** The pointer entered this province. */
  onHoverEnter: (id: ProvinceId) => void;
  /** The pointer left this province — clear the highlight only if it is still the one lit. */
  onHoverLeave: (id: ProvinceId | null) => void;
  /** The pointer left the map (or vanished mid-gesture): clear whatever is lit. */
  onHoverClear: () => void;
}

/** Province fills + one border pass + hit targets; drawn once, recoloured per render. */
export function buildStaticLayers(host: StaticMapHost): void {
  const { art, layers, defs } = host;
  const off = art.pathOffset;
  // Backdrop, so the page and an exported PNG (whose canvas is white) agree. Nothing
  // shows through between provinces any more, so this only paints the margin outside the
  // drawn world and can be the out-of-play ocean rather than the old border-dark.
  const vb = art.viewBox;
  layers.background!.append(
    svgEl('rect', { x: vb.x, y: vb.y, width: vb.w, height: vb.h, fill: BACKGROUND_SEA }),
  );
  const g = svgEl('g', { transform: `translate(${off.x} ${off.y})` });
  for (const bg of art.backgroundPaths()) {
    g.append(svgEl('path', { d: bg.d, fill: bg.water ? BACKGROUND_SEA : BACKGROUND_LAND, stroke: 'none' }));
  }
  // Iceland and Ireland are holes in the tiling, and jDip's decorative outline of each
  // sits a few units inside its hole — which read as a light-blue fringe around the
  // island, sea showing between the drawn land and the coastline the surrounding sea
  // tiles stroke around the hole. Painting the hole itself, over jDip's shape, makes the
  // land meet that coastline exactly. It stays under the border pass, so the stroke that
  // draws every other coast draws these too.
  for (const d of art.islandPaths()) {
    g.append(svgEl('path', { d, fill: BACKGROUND_LAND, stroke: 'none' }));
  }
  layers.background!.append(g);

  // The tiles leave no dead ground between provinces, so the fills below take almost
  // every click themselves. What they don't cover is the water a land province owns —
  // the Bosporus, the Danish belts — which is a hole in the tile and would otherwise
  // click through to nothing. This layer fills that back in, invisibly.
  const hg = svgEl('g', { transform: `translate(${off.x} ${off.y})`, class: 'hit-layer' });
  const pg = svgEl('g', { transform: `translate(${off.x} ${off.y})` });
  // Two passes: fill every tile, then stroke every tile's outline once. Adjacent tiles
  // share an exact edge, so the two strokes are the same line drawn twice and it reads
  // as one — no growing the fills to meet, no border wide enough to bridge a gap.
  const bg = svgEl('g', {
    transform: `translate(${off.x} ${off.y})`,
    class: 'border-layer',
    fill: 'none',
    stroke: PROVINCE_STROKE,
    'stroke-width': BORDER_WIDTH,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'pointer-events': 'none',
  });
  // Water that belongs to a land province — the Danish belts, the Bosporus — is a hole
  // in that province's tile, and this fills the hole with sea. It goes UNDER the border
  // pass: the tile's outline runs around the hole, so the same stroke that draws every
  // other coast draws these, and Denmark's islands come out as closed shapes with their
  // own shoreline. The Bosporus is only ~5 units wide, so the border pass has to stay
  // thin enough not to swallow it.
  const wg = svgEl('g', {
    transform: `translate(${off.x} ${off.y})`,
    class: 'water-inset-layer',
    fill: SEA_FILL,
    stroke: 'none',
    'pointer-events': 'none',
  });
  const cg = svgEl('g', {
    transform: `translate(${off.x} ${off.y})`,
    class: 'canal-layer',
    'pointer-events': 'none',
  });
  for (const id of art.provinceIds) {
    const d = art.provincePath(id);
    if (!d) continue;
    const inset = art.waterInsetPath(id);
    if (art.provinceKind(id) !== 'impassable') {
      hg.append(
        svgEl('path', {
          // The strait's water is part of the province you click on.
          d: art.provinceArea(id) ?? d,
          class: 'province-hit',
          'data-province': id,
          fill: 'transparent',
          stroke: 'none',
          // Inline, not left to the stylesheet: this layer is what makes the board
          // clickable at all, and a stale cached style.css would silently make it
          // inert.
          style: 'pointer-events: fill; cursor: pointer',
        }),
      );
    }
    const path = svgEl('path', {
      d,
      class: 'province',
      'data-province': id,
      stroke: 'none',
    });
    host.hitPaths.set(id, path);
    pg.append(path);
    if (inset) wg.append(svgEl('path', { d: inset }));
    // A canal is a water channel, not a hairline: a dark band with a narrower band of
    // sea inside it, so it has shores like every other stretch of water. It sits above
    // the fills but BELOW the border pass.
    //
    // Clipped to the province's own tile, which is what makes both ends work. The band
    // is drawn from a line that runs a unit or so past each coast, so the water reaches
    // the sea instead of stopping in a dead stub — but its dark shore stroke went with
    // it and drew a spurious outline out into HEL and BAL. The clip cuts both strokes
    // off exactly at the coastline: the channel opens into open water with no cap.
    const canal = art.canalPath(id);
    if (canal) {
      const clipId = `canal-clip-${id}`;
      defs.append(
        svgEl('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' }, [
          svgEl('path', { d }),
        ]),
      );
      const clip = `url(#${clipId})`;
      cg.append(
        svgEl('path', {
          d: canal,
          'clip-path': clip,
          fill: 'none',
          stroke: PROVINCE_STROKE,
          'stroke-width': CANAL_WIDTH + CANAL_EDGE * 2,
          'stroke-linecap': 'butt',
        }),
        svgEl('path', {
          d: canal,
          'clip-path': clip,
          fill: 'none',
          stroke: SEA_FILL,
          'stroke-width': CANAL_WIDTH,
          'stroke-linecap': 'butt',
        }),
      );
    }
    bg.append(svgEl('path', { d }));
  }
  layers.borders!.append(cg, wg, bg);
  layers.borders!.append(
    svgEl('rect', {
      x: vb.x + FRAME_WIDTH / 2,
      y: vb.y + FRAME_WIDTH / 2,
      width: vb.w - FRAME_WIDTH,
      height: vb.h - FRAME_WIDTH,
      fill: 'none',
      stroke: PROVINCE_STROKE,
      'stroke-width': FRAME_WIDTH,
      'pointer-events': 'none',
    }),
  );
  const onClick = (ev: Event) => {
    const t = ev.target as Element;
    const id = t.getAttribute?.('data-province');
    if (id) host.onProvinceClick(id, ev as MouseEvent);
  };
  hg.addEventListener('click', onClick);
  pg.addEventListener('click', onClick);
  // Hover is driven from here rather than from `.province:hover` in the stylesheet:
  // WebKit *computes* `filter: brightness()` on an SVG child element but never paints
  // it, so a CSS highlight is invisible in Safari. Setting the lightened colour into
  // `fill` needs no filter and no selector against the invisible hit layer, so both
  // browsers agree.
  const provinceAt = (ev: Event): ProvinceId | null =>
    ((ev.target as Element | null)?.getAttribute?.('data-province') as ProvinceId | null) ?? null;
  // Touch has no hover: a tap would otherwise light a province and leave it lit.
  const fromTouch = (ev: Event): boolean => (ev as PointerEvent).pointerType === 'touch';
  const onOver = (ev: Event) => {
    if (fromTouch(ev)) return;
    const id = provinceAt(ev);
    if (!id) return;
    host.onHoverEnter(id);
  };
  const onOut = (ev: Event) => {
    if (fromTouch(ev)) return;
    // `pointerout` on the old target precedes `pointerover` on the new one, so the id
    // check only clears a hover nothing else has already taken over.
    host.onHoverLeave(provinceAt(ev));
  };
  for (const layer of [hg, pg]) {
    layer.addEventListener('pointerover', onOver);
    layer.addEventListener('pointerout', onOut);
  }
  // Leaving the map entirely (or a pointer that vanishes mid-gesture) clears it too.
  host.svg.addEventListener('pointerleave', () => host.onHoverClear());
  host.svg.addEventListener('pointercancel', () => host.onHoverClear());
  layers.hit!.append(hg);
  layers.provinces!.append(pg);
}

/** Owner of a supply centre, or null. */
export function scOwner(state: GameState, id: ProvinceId): Power | null {
  for (const [power, list] of Object.entries(state.centers) as [Power, ProvinceId[]][]) {
    if (list?.includes(id)) return power;
  }
  return null;
}

/** A tile's colour with no pointer over it: sea, impassable, owned centre or plain land. */
export function tileFill(art: MapArt, map: MapData, state: GameState, id: ProvinceId): string {
  const kind = art.provinceKind(id);
  if (kind === 'sea') return SEA_FILL;
  // Impassable ground (Switzerland, and only Switzerland here) is solid near-black:
  // the old grey landed within a few percent of Germany's territory tint and read as
  // "someone owns this". No power's colour is anywhere near it. It also gets no
  // label and no hit target — see renderLabels and buildStaticLayers.
  if (kind === 'impassable') return IMPASSABLE_FILL;
  if (map.provinces[id]?.sc) {
    // Only supply centres are tinted; plain land stays the neutral ground.
    const owner = scOwner(state, id);
    return owner ? POWER_COLORS[owner].fill : NEUTRAL_SC_FILL;
  }
  return UNOWNED_FILL;
}

/** Paint a tile's base colour, lightened while the pointer is over it. */
export function paintTile(path: SVGPathElement, base: string, hot: boolean): void {
  path.setAttribute('fill', hot ? brighten(base, HOVER_BRIGHTEN) : base);
  path.classList.toggle('is-hover', hot);
}

export function renderSupplyCenters(art: MapArt, map: MapData, state: GameState, g: SVGGElement): void {
  clear(g);
  for (const id of Object.keys(map.provinces)) {
    if (!map.provinces[id]?.sc) continue;
    const dot = art.scDot(id);
    if (!dot) continue;
    const owner = scOwner(state, id);
    const home = map.provinces[id]?.home;
    g.append(
      svgEl('circle', {
        cx: dot[0],
        cy: dot[1],
        r: 7,
        fill: owner ? POWER_COLORS[owner].map : '#ffffff',
        stroke: '#1c1c1c',
        'stroke-width': home ? 2.4 : 1.4,
      }),
    );
  }
}

/** Sea provinces shout (NTH, MAO); land provinces don't (Par, Bur, Stp). */
function isSea(art: MapArt, map: MapData, id: ProvinceId): boolean {
  const type = map.provinces[id]?.type;
  return type ? type === 'sea' : art.provinceKind(id) === 'sea';
}

export function renderLabels(art: MapArt, map: MapData, g: SVGGElement): void {
  if (g.childNodes.length) return; // static
  for (const id of art.provinceIds) {
    // Impassable ground is a black hole on the board: no name, nothing to click.
    if (art.provinceKind(id) === 'impassable') continue;
    const l = art.labelAnchor(id);
    if (!l) continue;
    g.append(
      svgEl('text', {
        x: l.x,
        y: l.y,
        class: 'prov-label',
        'text-anchor': 'middle',
        'font-size': 20,
        'font-family': 'system-ui, -apple-system, Helvetica, Arial, sans-serif',
        'font-weight': 600,
        fill: '#2a2a2a',
        // Nine names (Nap, Lon, Cly, Wal, Yor, …) belong to provinces too small or too
        // narrow to hold their own box, so they cross a border however they are placed.
        // A pale halo under the glyphs, painted before the ink, keeps them legible where
        // they do — and is invisible everywhere else, since it is barely lighter than
        // the ground it sits on.
        stroke: LABEL_HALO,
        'stroke-width': LABEL_HALO_WIDTH,
        'stroke-linejoin': 'round',
        'paint-order': 'stroke',
        'pointer-events': 'none',
      }, [provinceLabel(l.text.toLowerCase(), isSea(art, map, id))]),
    );
  }
}
