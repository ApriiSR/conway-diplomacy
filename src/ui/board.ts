import type {
  Dislodgement,
  GameState,
  LifeResult,
  Loc,
  MapData,
  Order,
  OrderResult,
  ProvinceId,
} from '../engine/types.js';
import { POWER_COLORS } from './colors.js';
import { renderCaption } from './board-export.js';
import {
  birthGlyph,
  cross,
  deathMark,
  degenerate,
  fade,
  HEAD_ASSIST,
  HEAD_MOVE,
  holdMark,
  MarkerCache,
  shaft,
  shift,
  trim,
  unitGlyph,
  UNIT_R,
} from './board-glyphs.js';
import {
  buildStaticLayers,
  paintTile,
  renderLabels,
  renderSupplyCenters,
  tileFill,
} from './board-map.js';
import { coastOf, provinceOf } from '../engine/map-utils.js';
import { type MapArt } from './map-art.js';
import { clear, svgEl } from './svg.js';

export interface BoardView {
  state: GameState;
  /** Result arrows to draw (the phase just adjudicated). */
  results?: { order: Order; result: OrderResult }[];
  /**
   * Orders parsed from what the GM is typing/clicking right now, drawn in the same
   * grammar at reduced opacity and with no result marks — so the board, not the
   * textarea, is where you check what has been entered.
   */
  pendingOrders?: Order[];
  dislodged?: Dislodgement[];
  life?: LifeResult;
  /** Province currently selected for click-order entry. */
  selected?: Loc | null;
  /** Provinces to glow as legal targets. */
  targets?: Loc[];
  /** Targets reachable only by convoy — glowed in a different colour, still needing a fleet. */
  convoyTargets?: ProvinceId[];
  /** Second selection (support/convoy: the supported unit). */
  secondary?: Loc | null;
  title?: string;
  phaseLabel?: string;
  /** Bake the phase/title text and the symbol legend into the SVG (for PNG export). */
  showCaption?: boolean;
  /** One-line Life summary for the exported margin, e.g. "Life: 2 deaths, 1 birth". */
  lifeSummary?: string;
}

/** Perpendicular nudge so a mutual bounce draws as two arrows, not one mush. */
const BOUNCE_OFFSET = 9;
/**
 * Adjudicated orders. Not 1: an arrow crossing a province still has to let the territory
 * colour under it read, and the two together are what say "this order, by this power".
 * An earlier revision drew them at full strength over a light under-stroke; the
 * under-stroke is gone (see `shaft`), so this is the whole of the arrow's presence now.
 */
const RESULT_OPACITY = 0.9;
/** Entered-but-not-adjudicated orders: same marks, visibly provisional. */
const PENDING_OPACITY = 0.55;
/** A failed support/convoy: dimmer again, but still on the same scale. */
const FAILED_ASSIST = 0.6;

/**
 * The board: one SVG, a fixed stack of layers, and a `render` that redraws everything
 * that moves. The map under it is built once by `board-map.ts`, the marks it draws come
 * from `board-glyphs.ts`, and the export-only caption/legend from `board-export.ts`.
 */
export class Board {
  readonly svg: SVGSVGElement;
  private readonly layers: Record<string, SVGGElement> = {};
  private onProvinceClick: ((id: ProvinceId, ev: MouseEvent) => void) | null = null;
  private hitPaths = new Map<ProvinceId, SVGPathElement>();
  /** The fill each tile would have with no pointer over it, so hover can be undone. */
  private baseFills = new Map<ProvinceId, string>();
  private hovered: ProvinceId | null = null;
  private readonly defsEl: SVGDefsElement;
  private readonly markers: MarkerCache;

  constructor(
    private readonly art: MapArt,
    private readonly map: MapData,
  ) {
    const vb = art.viewBox;
    this.svg = svgEl('svg', {
      viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`,
      xmlns: 'http://www.w3.org/2000/svg',
      class: 'board-svg',
      preserveAspectRatio: 'xMidYMid meet',
    });
    this.defsEl = svgEl('defs');
    this.markers = new MarkerCache(this.defsEl);
    this.svg.append(this.defsEl);
    for (const name of ['background', 'hit', 'provinces', 'borders', 'sc', 'labels', 'pending', 'orders', 'units', 'life', 'highlight', 'caption']) {
      const g = svgEl('g', { class: `layer-${name}` });
      this.layers[name] = g;
      this.svg.append(g);
    }
    buildStaticLayers({
      art: this.art,
      svg: this.svg,
      defs: this.defsEl,
      layers: this.layers,
      hitPaths: this.hitPaths,
      onProvinceClick: (id, ev) => this.onProvinceClick?.(id, ev),
      onHoverEnter: (id) => this.setHovered(id),
      onHoverLeave: (id) => {
        if (id === this.hovered) this.setHovered(null);
      },
      onHoverClear: () => this.setHovered(null),
    });
  }

  /** Pan/zoom (mobile): set the visible window, or reset to the art's full extent. */
  setViewBox(x: number, y: number, w: number, h: number): void {
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }

  resetViewBox(): void {
    const vb = this.art.viewBox;
    this.setViewBox(vb.x, vb.y, vb.w, vb.h);
  }

  get fullViewBox(): { x: number; y: number; w: number; h: number } {
    return this.art.viewBox;
  }

  setProvinceClickHandler(fn: ((id: ProvinceId, ev: MouseEvent) => void) | null): void {
    this.onProvinceClick = fn;
  }

  /** Coast picker support: which coasts does this province have? */
  coastsOf(id: ProvinceId): string[] {
    return this.art.coastsOf(id).map((l) => coastOf(l)).filter(Boolean);
  }

  /** Move the hover highlight, repainting only the two tiles that change. */
  private setHovered(id: ProvinceId | null): void {
    if (id === this.hovered) return;
    const previous = this.hovered;
    this.hovered = id && this.art.provinceKind(id) !== 'impassable' ? id : null;
    if (previous) this.paintFill(previous);
    if (this.hovered) this.paintFill(this.hovered);
  }

  private paintFill(id: ProvinceId): void {
    const path = this.hitPaths.get(id);
    const base = this.baseFills.get(id);
    if (!path || !base) return;
    paintTile(path, base, this.hovered === id);
  }

  render(view: BoardView): void {
    const { state } = view;
    // --- province fills
    for (const [id, path] of this.hitPaths) {
      this.baseFills.set(id, tileFill(this.art, this.map, state, id));
      path.classList.toggle('impassable', this.art.provinceKind(id) === 'impassable');
      this.paintFill(id);
    }

    renderSupplyCenters(this.art, this.map, state, this.layers.sc!);
    renderLabels(this.art, this.map, this.layers.labels!);
    this.renderOrders(view);
    this.renderUnits(view);
    this.renderLife(view);
    this.renderHighlight(view);
    renderCaption(this.layers.caption!, view, this.art, this.markers);
  }

  private anchor(loc: Loc): [number, number] | null {
    return this.art.unitAnchor(loc);
  }

  private renderUnits(view: BoardView): void {
    const g = this.layers.units!;
    clear(g);
    const dislodgedLocs = new Set((view.dislodged ?? []).map((d) => provinceOf(d.unit.loc)));
    for (const u of view.state.units) {
      const a = this.anchor(u.loc);
      if (!a) continue;
      g.append(unitGlyph(u, a, { dislodged: dislodgedLocs.has(provinceOf(u.loc)) }));
    }
    // dislodged units are off the board in `state.units`; draw them at the offset anchor
    for (const d of view.dislodged ?? []) {
      const a = this.art.dislodgedAnchor(d.unit.loc);
      if (!a) continue;
      g.append(unitGlyph(d.unit, a, { dislodged: true }));
    }
    // pending births: hollow dashed markers, so SPAWN_CHOICE is a shareable board
    for (const b of view.state.pendingBirths ?? []) {
      const a = this.anchor(b.province);
      if (!a) continue;
      g.append(birthGlyph(b.power, a, null));
    }
  }

  private renderOrders(view: BoardView): void {
    clear(this.layers.orders!);
    clear(this.layers.pending!);
    this.drawOrders(
      this.layers.orders!,
      (view.results ?? []).map((r) => ({ order: r.order, result: r.result })),
      false,
    );
    this.drawOrders(
      this.layers.pending!,
      (view.pendingOrders ?? []).map((order) => ({ order })),
      true,
    );
  }

  /**
   * One drawing pass for both entered ("pending") and adjudicated orders: identical
   * geometry, so an arrow doesn't move when it's adjudicated — pending is just dimmer and
   * carries no result marks.
   */
  private drawOrders(
    g: SVGGElement,
    entries: { order: Order; result?: OrderResult }[],
    pending: boolean,
  ): void {
    const alpha = pending ? PENDING_OPACITY : RESULT_OPACITY;
    // Mutual bounces (A→B while B→A) would otherwise draw one on top of the other.
    const moves = new Set<string>();
    for (const { order } of entries) {
      if (order.kind === 'move' || order.kind === 'retreat') {
        moves.add(`${provinceOf(order.unit.loc)}>${provinceOf(order.to)}`);
      }
    }
    for (const { order, result } of entries) {
      const from = 'unit' in order ? this.anchor(order.unit.loc) : null;
      const color = 'unit' in order ? POWER_COLORS[order.unit.power].unit : '#5a5a5a';
      if (order.kind === 'build') {
        // No unit exists yet — show where one is being ordered into being.
        const at = this.anchor(order.unit.loc);
        if (at) g.append(fade(birthGlyph(order.unit.power, at, order.unit.type), alpha));
        continue;
      }
      if (!from) continue;
      if (order.kind === 'move' || order.kind === 'retreat') {
        const to = this.anchor(order.to);
        // A move whose source and destination are the same province ('A Con - Con') is
        // degenerate: `trim` on a zero-length segment produced a nonsense stub, so treat
        // it as the hold it effectively is rather than drawing anything curved.
        if (!to || degenerate(from, to)) {
          g.append(fade(holdMark(from, color), alpha));
          continue;
        }
        const mutual = moves.has(`${provinceOf(order.to)}>${provinceOf(order.unit.loc)}`);
        const [a, b] = mutual ? shift(from, to, BOUNCE_OFFSET) : [from, to];
        // The arrowhead occupies the last HEAD_MOVE units, so the shaft is trimmed back
        // by that much: the head's tip, not the shaft, lands at UNIT_R + 12 from the
        // destination. Otherwise the line runs out through the point of the head.
        const [x1, y1, x2, y2] = trim(a, b, UNIT_R + 6, UNIT_R + 12 + HEAD_MOVE);
        const tip = trim(a, b, UNIT_R + 6, UNIT_R + 12);
        g.append(
          fade(shaft(x1, y1, x2, y2, color, 5.5, this.markers.ref(color, HEAD_MOVE)), alpha),
        );
        // The ✕ sits at the arrowhead's tip, where the bounce actually happened.
        if (!pending && result !== 'ok') {
          g.append(cross([tip[2], tip[3]], '#cc2b2b', 12, 4.5, true));
        }
      } else if (order.kind === 'support' || order.kind === 'convoy') {
        const tgt = this.anchor(order.target.loc);
        // Self-support ('A Con S A Con') has nowhere to point: bracket, don't scribble.
        if (!tgt || degenerate(from, tgt)) {
          g.append(fade(holdMark(from, color), alpha));
          continue;
        }
        const dest = order.to !== undefined ? this.anchor(order.to) : null;
        const faded = (!pending && result !== 'ok' ? FAILED_ASSIST : 1) * alpha;
        // leg 1: assistant → assisted unit; leg 2: assisted unit → where it's being helped to
        const l1 = trim(from, tgt, UNIT_R + 5, UNIT_R + 7);
        g.append(shaft(l1[0], l1[1], l1[2], l1[3], color, 4, undefined, '11 8', faded));
        if (dest && !degenerate(tgt, dest)) {
          const l2 = trim(tgt, dest, UNIT_R + 5, UNIT_R + 12 + HEAD_ASSIST);
          g.append(
            shaft(
              l2[0], l2[1], l2[2], l2[3],
              color, 4, this.markers.ref(color, HEAD_ASSIST), '11 8', faded,
            ),
          );
        }
      } else if (order.kind === 'hold') {
        g.append(fade(holdMark(from, color), alpha));
      } else if (order.kind === 'disband' || order.kind === 'remove') {
        g.append(fade(cross(from, '#cc2b2b', 15, 5, true), alpha));
      }
    }
  }

  private renderLife(view: BoardView): void {
    const g = this.layers.life!;
    clear(g);
    if (!view.life) return;
    for (const ev of view.life.events) {
      // A dying unit is marked where it stands (its coast, for a fleet), not at the
      // province's generic anchor.
      const a = this.anchor(ev.kind === 'death' && ev.unit ? ev.unit.loc : ev.province);
      if (!a) continue;
      if (ev.kind === 'death') g.append(deathMark(a));
      else g.append(birthGlyph(ev.power, a, ev.pending ? null : (ev.unit?.type ?? null)));
    }
  }

  private renderHighlight(view: BoardView): void {
    const g = this.layers.highlight!;
    clear(g);
    const off = this.art.pathOffset;
    /**
     * Wash + thin edge, never a fat outline. Several jDip province paths are several
     * subpaths (Constantinople and Denmark carry their strait's water as separate loops),
     * so a 7px stroke traced each of them and read as a thick orange scribble looping the
     * province rather than as "this province is selected".
     */
    const outline = (loc: Loc, stroke: string, width: number, wash: number, dash?: string) => {
      const d = this.art.provinceArea(provinceOf(loc));
      if (!d) return;
      g.append(
        svgEl('g', { transform: `translate(${off.x} ${off.y})`, 'pointer-events': 'none' }, [
          svgEl('path', { d, fill: stroke, 'fill-opacity': wash, stroke: 'none' }),
          svgEl('path', {
            d,
            fill: 'none',
            stroke,
            'stroke-width': width,
            'stroke-dasharray': dash,
            'stroke-linejoin': 'round',
          }),
        ]),
      );
    };
    // Convoy-only destinations are a paler, finer dash: reachable, but only if the GM
    // also orders the fleets that carry the army.
    for (const t of view.convoyTargets ?? []) outline(t, '#67d5c4', 2, 0.12, '5 8');
    for (const t of view.targets ?? []) outline(t, '#ffd34d', 2.5, 0.2, '9 6');
    if (view.secondary) outline(view.secondary, '#4db6ff', 3, 0.26);
    if (view.selected) outline(view.selected, '#ff8a00', 3.5, 0.3);
  }
}
