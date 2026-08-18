import type { GameState, Loc, MapData, Order, ProvinceId, Unit, UnitType } from '../engine/types.js';
import { moveTargets, provinceOf, seaNeighbours } from '../engine/map-utils.js';

export type ClickMode = 'move' | 'support' | 'convoy';

/** What the controller wants the app to do after a click. */
export type ClickOutcome =
  | { kind: 'none' }
  | { kind: 'redraw' }
  | { kind: 'order'; order: Order }
  /** Ambiguous coast: the app shows a picker and calls `resolveCoast`. */
  | { kind: 'need-coast'; province: ProvinceId; coasts: string[]; unit: Unit }
  /** Empty home centre clicked in ADJUSTMENT: the app asks A or F (and coast). */
  | { kind: 'need-build-type'; province: ProvinceId; coasts: string[] }
  | { kind: 'message'; text: string };

export function unitAt(state: GameState, loc: Loc): Unit | null {
  const p = provinceOf(loc);
  return state.units.find((u) => provinceOf(u.loc) === p) ?? null;
}

/** Locs this unit could legally be ordered to move to (adjacency only — not adjudication). */
export function legalDestinations(unit: Unit, map: MapData): Loc[] {
  return [...moveTargets(map, unit.type, unit.loc)];
}

/**
 * Coastal provinces an army at `from` could reach *by convoy*, ignoring whether the
 * fleets to do it exist or have been ordered: a BFS out of `from` through sea provinces
 * only, collecting every coastal province touched along the way.
 *
 * Offered because click entry restricted to direct adjacency cannot express a convoyed
 * move (`A Apu - Tri`) at all. Whether the convoy actually succeeds is the adjudicator's
 * business, not the order form's; the GM still has to order the convoying fleets
 * themselves.
 */
export function convoyDestinations(unit: Unit, map: MapData): ProvinceId[] {
  const from = provinceOf(unit.loc);
  if (unit.type !== 'A' || map.provinces[from]?.type !== 'coastal') return [];
  const out = new Set<ProvinceId>();
  const seen = new Set<ProvinceId>();
  const queue: ProvinceId[] = [];
  // Seed with the seas touching the army's own province.
  for (const n of seaNeighbours(map, from)) {
    if (map.provinces[n]?.type === 'sea' && !seen.has(n)) {
      seen.add(n);
      queue.push(n);
    }
  }
  while (queue.length) {
    const sea = queue.shift()!;
    for (const n of seaNeighbours(map, sea)) {
      const p = map.provinces[n];
      if (!p) continue;
      if (p.type === 'sea') {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      } else if (p.type === 'coastal' && n !== from) {
        out.add(n);
      }
    }
  }
  return [...out];
}

/** Adjacent target locs in a clicked province, for coast disambiguation. */
function destsInProvince(dests: Loc[], target: ProvinceId): Loc[] {
  return dests.filter((d) => provinceOf(d) === target);
}

export class ClickController {
  mode: ClickMode = 'move';
  selected: Loc | null = null;
  secondary: Loc | null = null;
  /** Highlighted legal destinations for the current selection. */
  targets: Loc[] = [];
  /** Reachable only via a convoy — glowed differently, since a fleet order is still owed. */
  convoyTargets: ProvinceId[] = [];

  constructor(private readonly map: MapData) {}

  reset(): void {
    this.selected = null;
    this.secondary = null;
    this.targets = [];
    this.convoyTargets = [];
  }

  setMode(mode: ClickMode): void {
    this.mode = mode;
    this.reset();
  }

  click(state: GameState, id: ProvinceId): ClickOutcome {
    switch (state.phase) {
      case 'MOVEMENT':
        return this.clickMovement(state, id);
      case 'RETREAT':
        return this.clickRetreat(state, id);
      case 'ADJUSTMENT':
        return this.clickAdjustment(state, id);
      default:
        return { kind: 'none' };
    }
  }

  private select(unit: Unit): ClickOutcome {
    this.selected = unit.loc;
    this.secondary = null;
    this.targets = legalDestinations(unit, this.map);
    const direct = new Set(this.targets.map((t) => provinceOf(t)));
    this.convoyTargets = convoyDestinations(unit, this.map).filter((p) => !direct.has(p));
    return { kind: 'redraw' };
  }

  private clickMovement(state: GameState, id: ProvinceId): ClickOutcome {
    const clicked = unitAt(state, id);

    if (!this.selected) {
      if (!clicked) return { kind: 'none' };
      if (clicked.power === 'NEUTRAL') return { kind: 'message', text: 'Neutral units take no orders.' };
      return this.select(clicked);
    }

    const mover = unitAt(state, this.selected);
    if (!mover) {
      this.reset();
      return { kind: 'redraw' };
    }

    if (this.mode === 'move') {
      if (provinceOf(this.selected) === id) {
        const order: Order = { kind: 'hold', unit: mover };
        this.reset();
        return { kind: 'order', order };
      }
      const options = destsInProvince(this.targets, id);
      if (options.length === 0) {
        // Reachable only by sea: write the plain `A Apu - Tri`. The parser and engine
        // already read a non-adjacent army move as a convoy attempt, and DATC's "intent
        // to convoy" marker (`via convoy`) is only meaningful when the destination is
        // ALSO directly adjacent — which, here, by construction, it is not.
        if (this.convoyTargets.includes(id)) {
          const order: Order = { kind: 'move', unit: mover, to: id };
          this.reset();
          return { kind: 'order', order };
        }
        // treat as re-selection rather than an illegal order
        if (clicked && clicked.power !== 'NEUTRAL') return this.select(clicked);
        return { kind: 'message', text: `${mover.type} ${provinceOf(mover.loc).toUpperCase()} cannot reach ${id.toUpperCase()}.` };
      }
      if (options.length > 1) {
        return {
          kind: 'need-coast',
          province: id,
          coasts: options.map((o) => o.slice(o.indexOf('/') + 1)),
          unit: mover,
        };
      }
      const order: Order = { kind: 'move', unit: mover, to: options[0]! };
      this.reset();
      return { kind: 'order', order };
    }

    // support / convoy: second click picks the assisted unit, third its destination
    if (!this.secondary) {
      if (!clicked) return { kind: 'none' };
      if (provinceOf(clicked.loc) === provinceOf(mover.loc)) return { kind: 'none' };
      if (this.mode === 'convoy' && clicked.type !== 'A') {
        return { kind: 'message', text: 'Convoy assists an army.' };
      }
      this.secondary = clicked.loc;
      this.targets = legalDestinations(clicked, this.map);
      if (this.mode === 'convoy') {
        // a convoyed army may be moved anywhere coastal; don't over-restrict the glow
        this.targets = Object.values(this.map.provinces)
          .filter((p) => p.type === 'coastal')
          .map((p) => p.id);
      }
      return { kind: 'redraw' };
    }

    const assisted = unitAt(state, this.secondary);
    if (!assisted) {
      this.reset();
      return { kind: 'redraw' };
    }
    if (provinceOf(assisted.loc) === id) {
      if (this.mode === 'convoy') return { kind: 'message', text: 'A convoy needs a destination.' };
      const order: Order = { kind: 'support', unit: mover, target: assisted };
      this.reset();
      return { kind: 'order', order };
    }
    // A support names the destination *province*: `F MAO S F Gas - Spa` supports the
    // move to either coast of Spain, which is what the supporter means and what the
    // adjudicator reads. Picking a coast here would be both narrower-looking than the
    // order really is and, if the picker guessed the other one, plainly wrong.
    const order: Order =
      this.mode === 'convoy'
        ? { kind: 'convoy', unit: mover, target: assisted, to: id }
        : { kind: 'support', unit: mover, target: assisted, to: id };
    this.reset();
    return { kind: 'order', order };
  }

  private clickRetreat(state: GameState, id: ProvinceId): ClickOutcome {
    const dislodged = state.dislodged ?? [];
    if (!this.selected) {
      const d = dislodged.find((x) => provinceOf(x.unit.loc) === id);
      if (!d) return { kind: 'none' };
      this.selected = d.unit.loc;
      this.targets = d.retreatOptions;
      return { kind: 'redraw' };
    }
    const d = dislodged.find((x) => x.unit.loc === this.selected);
    if (!d) {
      this.reset();
      return { kind: 'redraw' };
    }
    if (provinceOf(d.unit.loc) === id) {
      this.reset();
      return { kind: 'order', order: { kind: 'disband', unit: d.unit } };
    }
    const options = destsInProvince(d.retreatOptions, id);
    if (!options.length) return { kind: 'message', text: `${id.toUpperCase()} is not a legal retreat.` };
    if (options.length > 1) {
      return { kind: 'need-coast', province: id, coasts: options.map((o) => o.slice(o.indexOf('/') + 1)), unit: d.unit };
    }
    this.reset();
    return { kind: 'order', order: { kind: 'retreat', unit: d.unit, to: options[0]! } };
  }

  private clickAdjustment(state: GameState, id: ProvinceId): ClickOutcome {
    const occupant = unitAt(state, id);
    if (occupant) {
      this.reset();
      return { kind: 'order', order: { kind: 'remove', unit: occupant } };
    }
    const p = this.map.provinces[id];
    if (!p?.sc) return { kind: 'none' };
    const owner = (Object.entries(state.centers) as [string, ProvinceId[]][]).find(([, l]) => l?.includes(id))?.[0];
    if (!owner || owner !== p.home) {
      return { kind: 'message', text: `${id.toUpperCase()} is not an unoccupied home centre you own.` };
    }
    return { kind: 'need-build-type', province: id, coasts: p.coasts };
  }

  /** Finish a click that needed a coast choice. */
  resolveCoast(state: GameState, unit: Unit, prov: ProvinceId, coast: string): Order {
    const to: Loc = coast ? `${prov}/${coast}` : prov;
    this.reset();
    return state.phase === 'RETREAT' ? { kind: 'retreat', unit, to } : { kind: 'move', unit, to };
  }

  /** Finish an adjustment click. */
  resolveBuild(power: string, prov: ProvinceId, type: UnitType, coast?: string): Order {
    this.reset();
    return {
      kind: 'build',
      unit: { power: power as Unit['power'], type, loc: coast ? `${prov}/${coast}` : prov },
    };
  }
}
