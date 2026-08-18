import type { BoardView } from './board.js';
import {
  birthGlyph,
  cross,
  deathMark,
  degenerate,
  HEAD_ASSIST,
  HEAD_MOVE,
  holdMark,
  MarkerCache,
  measureWidth,
  scaled,
  shaft,
  unitGlyph,
} from './board-glyphs.js';
import type { MapArt } from './map-art.js';
import { clear, svgEl } from './svg.js';

/**
 * Export furniture: the title/phase caption top-left and a symbol legend top-right,
 * so a board pasted into chat explains its own arrows without the GM narrating them.
 * Nothing here is drawn on screen — `showCaption` is set only for the PNG render.
 */
export function renderCaption(
  g: SVGGElement,
  view: BoardView,
  art: MapArt,
  markers: MarkerCache,
): void {
  clear(g);
  if (!view.showCaption) return;
  const vb = art.viewBox;

  const parts = [view.title, view.phaseLabel].filter(Boolean) as string[];
  if (parts.length) {
    const lines = [parts.join('  —  ')];
    if (view.lifeSummary) lines.push(view.lifeSummary);
    captionBox(g, vb.x + 16, vb.y + 14, lines);
  }
  legendBox(g, view, art, markers);
}

/**
 * White plate behind `lines`, measured after layout rather than estimated. The
 * measurement happens live, on-page, inside this app's own stylesheet cascade — but the
 * export this box is sized for gets rasterized from a standalone copy of the SVG, outside
 * that cascade, where font fallback can resolve slightly differently (and jsdom/detached
 * callers hit `measureWidth`'s character-count fallback, which needs each line's own
 * font-size, not a flat guess). Both mean "measured width" is a lower bound, not a
 * promise — so the box is sized up from it rather than trusting it to the pixel.
 */
function captionBox(g: SVGGElement, x: number, y: number, lines: string[]): void {
  const pad = 14;
  const fontSize = (i: number) => (i === 0 ? 30 : 23);
  const texts = lines.map((text, i) =>
    svgEl('text', {
      x: x + pad,
      y: y + 38 + i * 34,
      'font-size': fontSize(i),
      'font-weight': i === 0 ? 700 : 500,
      'font-family': 'system-ui, -apple-system, Helvetica, Arial, sans-serif',
      fill: i === 0 ? '#1a1a1a' : '#3c3c3c',
    }, [text]),
  );
  for (const t of texts) g.append(t);
  const measured = Math.max(...texts.map((t, i) => measureWidth(t, fontSize(i))));
  const width = measured * 1.08 + pad * 2 + 12;
  const height = 20 + lines.length * 34;
  const rect = svgEl('rect', {
    x, y,
    width,
    height,
    rx: 8,
    fill: '#ffffff',
    'fill-opacity': 0.9,
    stroke: '#333',
    'stroke-width': 1.5,
  });
  g.insertBefore(rect, texts[0]!);
}

/**
 * Which legend rows apply to this particular render: army/fleet are always shown,
 * everything else only if that exact mark is actually drawn somewhere on the board
 * right now. Mirrors the conditions in `drawOrders`/`renderUnits`/`renderLife` rather
 * than just checking order *kinds*, so a self-support or a degenerate move — which
 * draw as a hold bracket, not an arrow — count toward "hold", not their nominal kind.
 */
function legendFlags(view: BoardView, art: MapArt): {
  neutral: boolean;
  move: boolean;
  failed: boolean;
  supportConvoy: boolean;
  hold: boolean;
  dislodged: boolean;
  lifeDies: boolean;
  lifeBorn: boolean;
  birthUndecided: boolean;
} {
  const results = view.results ?? [];
  let move = false, failed = false, supportConvoy = false, hold = false;
  for (const { order, result } of results) {
    const from = 'unit' in order ? art.unitAnchor(order.unit.loc) : null;
    if (order.kind === 'hold') hold = true;
    else if (order.kind === 'move' || order.kind === 'retreat') {
      if (!from) continue;
      const to = art.unitAnchor(order.to);
      if (!to || degenerate(from, to)) hold = true;
      else {
        move = true;
        if (result !== 'ok') failed = true;
      }
    } else if (order.kind === 'support' || order.kind === 'convoy') {
      if (!from) continue;
      const tgt = art.unitAnchor(order.target.loc);
      if (!tgt || degenerate(from, tgt)) hold = true;
      else supportConvoy = true;
    }
  }
  const neutral =
    view.state.units.some((u) => u.power === 'NEUTRAL') ||
    (view.dislodged ?? []).some((d) => d.unit.power === 'NEUTRAL') ||
    (view.state.pendingBirths ?? []).some((b) => b.power === 'NEUTRAL') ||
    (view.life?.events ?? []).some((e) => e.power === 'NEUTRAL');
  const lifeEvents = view.life?.events ?? [];
  return {
    neutral,
    move,
    failed,
    supportConvoy,
    hold,
    dislodged: (view.dislodged ?? []).length > 0,
    lifeDies: lifeEvents.some((e) => e.kind === 'death'),
    lifeBorn: lifeEvents.some((e) => e.kind === 'birth' && !e.pending),
    birthUndecided:
      lifeEvents.some((e) => e.kind === 'birth' && e.pending) ||
      (view.state.pendingBirths ?? []).length > 0,
  };
}

/**
 * Compact key to the order/Life marks. Tucked into the top-right corner (the least
 * contested corner of the map — the caption already owns top-left) and kept small:
 * it only has to be legible up close on a shared image, not read across a room.
 * Only lists rows for marks that are actually on the board
 * right now, so a plain Spring 1901 export gets army/fleet and nothing else.
 */
function legendBox(g: SVGGElement, view: BoardView, art: MapArt, markers: MarkerCache): void {
  const flags = legendFlags(view, art);
  type Row = [(cx: number, cy: number) => SVGElement, string];
  const rows: Row[] = [
    // Units carry no letters any more, so the legend has to say what the shapes mean.
    [(cx, cy) => scaled(unitGlyph({ power: 'ENGLAND', type: 'A', loc: 'lon' }, [cx, cy]), cx, cy, 0.62), 'army'],
    [(cx, cy) => scaled(unitGlyph({ power: 'ENGLAND', type: 'F', loc: 'lon' }, [cx, cy]), cx, cy, 0.62), 'fleet'],
  ];
  if (flags.neutral) {
    rows.push([(cx, cy) => scaled(unitGlyph({ power: 'NEUTRAL', type: 'A', loc: 'lon' }, [cx, cy]), cx, cy, 0.62), 'neutral — white (never moves)']);
  }
  if (flags.move) {
    rows.push([(cx, cy) => shaft(cx - 20, cy, cx + 6, cy, '#2f6fd0', 5.5, markers.ref('#2f6fd0', HEAD_MOVE)), 'move (power colour)']);
  }
  if (flags.failed) {
    rows.push([(cx, cy) => cross([cx, cy], '#cc2b2b', 12, 4.5, true), 'move failed / bounced']);
  }
  if (flags.supportConvoy) {
    rows.push([(cx, cy) => shaft(cx - 20, cy, cx + 3, cy, '#2f6fd0', 4, markers.ref('#2f6fd0', HEAD_ASSIST), '11 8'), 'support / convoy']);
  }
  if (flags.hold) {
    rows.push([(cx, cy) => scaled(holdMark([cx, cy], '#2f6fd0'), cx, cy, 0.66), 'hold']);
  }
  if (flags.dislodged) {
    rows.push([(cx, cy) => svgEl('circle', { cx, cy, r: 15, fill: 'none', stroke: '#cc2b2b', 'stroke-width': 3.5 }), 'dislodged']);
  }
  if (flags.lifeDies) {
    rows.push([(cx, cy) => scaled(deathMark([cx, cy]), cx, cy, 0.72), 'Life: dies']);
  }
  if (flags.lifeBorn) {
    rows.push([(cx, cy) => scaled(birthGlyph('ITALY', [cx, cy], 'A'), cx, cy, 0.72), 'Life: born']);
  }
  if (flags.birthUndecided) {
    rows.push([(cx, cy) => scaled(birthGlyph('ITALY', [cx, cy], null), cx, cy, 0.72), 'Life: born (type pending)']);
  }

  const rowH = 42;
  const width = 380;
  const height = rows.length * rowH + 18;
  const scale = 0.5;
  const inset = 16;
  const vb = art.viewBox;
  const tx = vb.x + vb.w - inset - width * scale;
  const ty = vb.y + inset;

  const inner = svgEl('g');
  inner.append(
    svgEl('rect', {
      x: 0, y: 0, width, height, rx: 8,
      fill: '#ffffff',
      'fill-opacity': 0.8,
      stroke: '#333',
      'stroke-width': 1.5,
    }),
  );
  rows.forEach(([draw, label], i) => {
    const cy = 9 + rowH * i + rowH / 2;
    inner.append(draw(38, cy));
    inner.append(
      svgEl('text', {
        x: 72,
        y: cy + 8,
        'font-size': 23,
        'font-family': 'system-ui, -apple-system, Helvetica, Arial, sans-serif',
        fill: '#1a1a1a',
      }, [label]),
    );
  });
  g.append(svgEl('g', { transform: `translate(${tx} ${ty}) scale(${scale})` }, [inner]));
}
