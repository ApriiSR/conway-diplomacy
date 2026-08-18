import type {
  BuildOrder,
  Dislodgement,
  GameState,
  Loc,
  MapData,
  MovementOrder,
  Order,
  OrderResult,
  ResultEntry,
  Power,
  ProvinceId,
  RetreatOrder,
  Unit,
} from './types.js';
import { GREAT_POWERS } from './types.js';
import {
  abutsProvince,
  canMoveDirect,
  convoyRoutes,
  convoyerProvinces,
  distanceToHome,
  hasConvoyRoute,
  hasConvoyRouteThrough,
  isCoastal,
  isSea,
  moveTargets,
  provinceOf,
  coastOf,
  reachableLocsIn,
} from './map-utils.js';

export type { ResultEntry };

export interface MovementOutcome {
  results: ResultEntry[];
  dislodged: Dislodgement[];
  next: GameState;
}

export interface PhaseOutcome {
  results: ResultEntry[];
  next: GameState;
}

// ============================================================== movement phase

type Kind = 'move' | 'hold' | 'support' | 'convoy';

interface Adj {
  idx: number;
  unit: Unit;
  prov: ProvinceId;
  order: MovementOrder | null;
  kind: Kind;
  voided: boolean;
  /** kind === 'move' and the order was legal — voided orders behave as holds. */
  mv: boolean;
  results: OrderResult[];
  // move
  dest: Loc;
  destProv: ProvinceId;
  via: boolean;
  usesConvoy: boolean;
  routes: ProvinceId[][];
  // support
  supProv: ProvinceId;
  supDest: ProvinceId | null;
  // convoy
  cvFrom: ProvinceId;
  cvTo: ProvinceId;
  onRoute: boolean;
}

const UNRESOLVED = 0;
const GUESSING = 1;
const RESOLVED = 2;

/**
 * DATC adjudicator following Lucas B. Kruijswijk's "The Math of Adjudication":
 * binary decisions (move / support / dislodge / path) resolved recursively with
 * guess-based cycle detection; numeric strengths are computed on demand from the
 * binary decisions. Cycles resolve as circular movement (all moves succeed) when
 * they contain only move decisions, and by the Szykman rule (the convoyed move
 * fails) when a convoy path decision is involved.
 */
class Adjudicator {
  readonly n: number;
  readonly adjs: Adj[];
  readonly map: MapData;
  readonly byProv = new Map<ProvinceId, number>();
  readonly movesTo = new Map<ProvinceId, number[]>();
  readonly supportsFor: number[][] = [];
  readonly holdSupports: number[][] = [];
  readonly h2h: number[];

  private readonly state: Uint8Array;
  private readonly res: boolean[];
  private deps: number[] = [];

  constructor(map: MapData, adjs: Adj[]) {
    this.map = map;
    this.adjs = adjs;
    this.n = adjs.length;
    const n = this.n;
    this.state = new Uint8Array(4 * n);
    this.res = new Array(4 * n).fill(false);
    for (const a of adjs) this.byProv.set(a.prov, a.idx);
    for (const a of adjs) {
      if (a.mv) {
        const list = this.movesTo.get(a.destProv);
        if (list) list.push(a.idx);
        else this.movesTo.set(a.destProv, [a.idx]);
      }
    }
    for (let i = 0; i < n; i++) {
      this.supportsFor.push([]);
      this.holdSupports.push([]);
    }
    for (const a of adjs) {
      if (a.kind !== 'support' || a.voided) continue;
      const tgt = this.byProv.get(a.supProv);
      if (tgt === undefined) continue;
      const t = adjs[tgt]!;
      if (a.supDest === null) {
        if (!t.mv) this.holdSupports[tgt]!.push(a.idx);
      } else if (t.mv && t.destProv === a.supDest) {
        this.supportsFor[tgt]!.push(a.idx);
      }
    }
    this.h2h = new Array(n).fill(-1);
    for (const a of adjs) {
      if (!a.mv || a.usesConvoy) continue;
      const other = this.byProv.get(a.destProv);
      if (other === undefined) continue;
      const b = adjs[other]!;
      if (b.mv && !b.usesConvoy && b.destProv === a.prov) this.h2h[a.idx] = other;
    }
  }

  // decision ids
  private mv(i: number): number { return i; }
  private sp(i: number): number { return this.n + i; }
  private dl(i: number): number { return 2 * this.n + i; }
  private pa(i: number): number { return 3 * this.n + i; }
  private kindOf(d: number): number { return Math.floor(d / this.n); }
  private idxOf(d: number): number { return d % this.n; }

  moves(i: number): boolean { return this.resolve(this.mv(i)); }
  supported(i: number): boolean { return this.resolve(this.sp(i)); }
  isDislodged(i: number): boolean { return this.resolve(this.dl(i)); }
  hasPath(i: number): boolean { return this.resolve(this.pa(i)); }

  private resolve(d: number): boolean {
    if (this.state[d] === RESOLVED) return this.res[d]!;
    if (this.state[d] === GUESSING) {
      // Always record the dependency (duplicates included): the caller uses the
      // growth of this list to tell whether its own adjudication leaned on a
      // guess. De-duplicating here would let a decision that depended on an
      // already-listed guess be marked RESOLVED with a contaminated value.
      this.deps.push(d);
      return this.res[d]!;
    }
    const old = this.deps.length;
    this.res[d] = false;
    this.state[d] = GUESSING;
    const first = this.adjudicate(d);
    if (this.deps.length === old) {
      this.state[d] = RESOLVED;
      this.res[d] = first;
      return first;
    }
    if (this.deps[old] !== d) {
      this.deps.push(d);
      this.res[d] = first;
      return first;
    }
    while (this.deps.length > old) this.state[this.deps.pop()!] = UNRESOLVED;
    this.res[d] = true;
    this.state[d] = GUESSING;
    const second = this.adjudicate(d);
    if (first === second) {
      while (this.deps.length > old) this.state[this.deps.pop()!] = UNRESOLVED;
      this.state[d] = RESOLVED;
      this.res[d] = first;
      return first;
    }
    this.backup(old);
    return this.resolve(d);
  }

  private backup(old: number): void {
    const cycle = this.deps.slice(old);
    this.deps.length = old;
    const paths = cycle.filter((d) => this.kindOf(d) === 3);
    if (paths.length > 0) {
      // Convoy paradox: Szykman — the convoyed move(s) in the cycle fail.
      for (const d of cycle) this.state[d] = UNRESOLVED;
      for (const d of paths) {
        this.res[d] = false;
        this.state[d] = RESOLVED;
      }
      return;
    }
    const allMoves = cycle.every((d) => this.kindOf(d) === 0);
    for (const d of cycle) this.state[d] = UNRESOLVED;
    for (const d of cycle) {
      this.res[d] = allMoves;
      this.state[d] = RESOLVED;
    }
  }

  private adjudicate(d: number): boolean {
    const i = this.idxOf(d);
    switch (this.kindOf(d)) {
      case 0: return this.adjMove(i);
      case 1: return this.adjSupport(i);
      case 2: return this.adjDislodge(i);
      default: return this.adjPath(i);
    }
  }

  private adjPath(i: number): boolean {
    const a = this.adjs[i]!;
    if (!a.usesConvoy) return true;
    for (const route of a.routes) {
      let ok = true;
      for (const sea of route) {
        const f = this.byProv.get(sea);
        if (f === undefined || this.isDislodged(f)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  private supportCount(i: number, exclude?: Power): number {
    let c = 0;
    for (const s of this.supportsFor[i]!) {
      if (exclude !== undefined && this.adjs[s]!.unit.power === exclude) continue;
      if (this.supported(s)) c++;
    }
    return c;
  }

  private holdStrength(i: number): number {
    const a = this.adjs[i]!;
    if (a.mv) return this.moves(i) ? 0 : 1;
    let c = 1;
    for (const s of this.holdSupports[i]!) if (this.supported(s)) c++;
    return c;
  }

  private attackStrength(i: number): number {
    const a = this.adjs[i]!;
    if (!this.hasPath(i)) return 0;
    const occ = this.byProv.get(a.destProv);
    if (occ === undefined) return 1 + this.supportCount(i);
    const b = this.adjs[occ]!;
    const head = this.h2h[i] === occ;
    if (!head && b.mv && this.moves(occ)) return 1 + this.supportCount(i);
    if (b.unit.power === a.unit.power) return 0;
    return 1 + this.supportCount(i, b.unit.power);
  }

  private defendStrength(i: number): number {
    return 1 + this.supportCount(i);
  }

  private preventStrength(i: number): number {
    if (!this.hasPath(i)) return 0;
    const opp = this.h2h[i] ?? -1;
    if (opp !== -1 && this.moves(opp)) return 0;
    return 1 + this.supportCount(i);
  }

  private adjMove(i: number): boolean {
    const a = this.adjs[i]!;
    if (!this.hasPath(i)) return false;
    const atk = this.attackStrength(i);
    if (atk === 0) return false;
    const opp = this.h2h[i] ?? -1;
    if (opp !== -1) {
      if (atk <= this.defendStrength(opp)) return false;
    } else {
      const occ = this.byProv.get(a.destProv);
      if (occ !== undefined && atk <= this.holdStrength(occ)) return false;
    }
    for (const j of this.movesTo.get(a.destProv) ?? []) {
      if (j === i) continue;
      if (atk <= this.preventStrength(j)) return false;
    }
    return true;
  }

  private adjSupport(i: number): boolean {
    const a = this.adjs[i]!;
    if (a.voided) return false;
    if (this.isDislodged(i)) return false;
    for (const j of this.movesTo.get(a.prov) ?? []) {
      const b = this.adjs[j]!;
      if (b.unit.power === a.unit.power) continue;
      if (a.supDest !== null && b.prov === a.supDest) continue;
      if (this.hasPath(j)) return false;
    }
    return true;
  }

  private adjDislodge(i: number): boolean {
    const a = this.adjs[i]!;
    if (a.mv && this.moves(i)) return false;
    for (const j of this.movesTo.get(a.prov) ?? []) {
      if (j !== i && this.moves(j)) return true;
    }
    return false;
  }

  /**
   * True when move `i` failed only because a power may not dislodge its own
   * unit: it would have carried the destination had every support counted.
   * (When the move is contested on equal terms by a third party the support
   * still "had effect" and is not voided — DATC 6.E.12.)
   */
  selfDislodgeBounce(i: number): boolean {
    const a = this.adjs[i]!;
    if (!a.mv || this.moves(i) || !this.hasPath(i)) return false;
    const occ = this.byProv.get(a.destProv);
    if (occ === undefined) return false;
    let full = 1;
    for (const s of this.supportsFor[i]!) if (this.supported(s)) full++;
    const opp = this.h2h[i] ?? -1;
    if (opp !== -1) {
      if (full <= this.defendStrength(opp)) return false;
    } else if (full <= this.holdStrength(occ)) {
      return false;
    }
    for (const j of this.movesTo.get(a.destProv) ?? []) {
      if (j === i) continue;
      if (full <= this.preventStrength(j)) return false;
    }
    return true;
  }

  /** The unit sitting in `prov` at the end of the phase, if it never left. */
  stayingOccupant(prov: ProvinceId): Adj | undefined {
    const occ = this.byProv.get(prov);
    if (occ === undefined) return undefined;
    const a = this.adjs[occ]!;
    if (a.mv && this.moves(occ)) return undefined;
    return a;
  }

  /** Index of the move that dislodged the unit at `i`, or -1. */
  dislodgerOf(i: number): number {
    for (const j of this.movesTo.get(this.adjs[i]!.prov) ?? []) {
      if (j !== i && this.moves(j)) return j;
    }
    return -1;
  }
}

function unitCopy(u: Unit): Unit {
  return { power: u.power, type: u.type, loc: u.loc };
}

/** Resolve a movement phase. */
export function resolveMovement(
  state: GameState,
  orders: readonly Order[],
  map: MapData,
): MovementOutcome {
  const results: ResultEntry[] = [];
  const adjs: Adj[] = [];
  const byProv = new Map<ProvinceId, Adj>();

  const blank = (unit: Unit, order: MovementOrder | null, kind: Kind): Adj => ({
    idx: adjs.length,
    unit,
    prov: provinceOf(unit.loc),
    order,
    kind,
    voided: false,
    mv: false,
    results: [],
    dest: '',
    destProv: '',
    via: false,
    usesConvoy: false,
    routes: [],
    supProv: '',
    supDest: null,
    cvFrom: '',
    cvTo: '',
    onRoute: false,
  });

  // One Adj per unit on the board; unmatched/duplicate orders are voided.
  const orderFor = new Map<ProvinceId, MovementOrder>();
  const strayOrders: Order[] = [];
  for (const o of orders) {
    if (o.kind === 'build' || o.kind === 'remove' || o.kind === 'waive' ||
        o.kind === 'retreat' || o.kind === 'disband') {
      strayOrders.push(o);
      continue;
    }
    const p = provinceOf(o.unit.loc);
    const board = state.units.find((u) => provinceOf(u.loc) === p);
    if (!board || board.power !== o.unit.power || board.power === 'NEUTRAL') {
      strayOrders.push(o);
      continue;
    }
    if (orderFor.has(p)) results.push({ order: orderFor.get(p)!, result: 'void' });
    orderFor.set(p, o);
  }
  for (const o of strayOrders) results.push({ order: o, result: 'void' });

  for (const u of state.units) {
    const o = u.power === 'NEUTRAL' ? undefined : orderFor.get(provinceOf(u.loc));
    const kind: Kind = o ? o.kind : 'hold';
    const a = blank(unitCopy(u), o ?? null, kind);
    adjs.push(a);
    byProv.set(a.prov, a);
  }

  const seaFleets = convoyerProvinces(map, state.units);

  // ---- validate moves ----
  for (const a of adjs) {
    const o = a.order;
    if (!o || o.kind !== 'move') continue;
    {
      a.via = o.viaConvoy === true;
      let dest: Loc = o.to;
      const dp = provinceOf(dest);
      const dprov = map.provinces[dp];
      if (!dprov || dp === a.prov) {
        a.voided = true;
      } else if (a.unit.type === 'A') {
        dest = dp; // coasts are irrelevant for armies (DATC 4.B.6 / 6.B.12)
        if (dprov.type === 'sea') {
          a.voided = true;
        } else {
          const direct = canMoveDirect(map, 'A', a.unit.loc, dp);
          if (!direct || a.via) {
            if (
              !isCoastal(map, a.prov) ||
              !isCoastal(map, dp) ||
              !hasConvoyRoute(map, seaFleets, a.prov, dp)
            ) {
              if (!direct) a.voided = true;
              else a.via = false; // VIA with no possible convoy: fall back to land
            }
          }
        }
      } else {
        if (a.via) a.voided = true;
        if (dprov.coasts.length > 0 && coastOf(dest) === '') {
          const opts = reachableLocsIn(map, 'F', a.unit.loc, dp);
          if (opts.length === 1) dest = opts[0]!;
          else a.voided = true;
        }
        if (!a.voided && !canMoveDirect(map, 'F', a.unit.loc, dest)) a.voided = true;
      }
      a.dest = dest;
      a.destProv = dp;
      a.mv = !a.voided;
    }
  }

  // ---- validate supports and convoys (they reference validated moves) ----
  for (const a of adjs) {
    const o = a.order;
    if (!o) continue;
    if (o.kind === 'support') {
      const tp = provinceOf(o.target.loc);
      a.supProv = tp;
      const tgt = byProv.get(tp);
      if (!tgt || tp === a.prov) {
        a.voided = true;
      } else if (o.to === undefined) {
        a.supDest = null;
        if (!abutsProvince(map, a.unit.type, a.unit.loc, tp)) a.voided = true;
        else if (tgt.mv) a.voided = true;
      } else {
        const dp = provinceOf(o.to);
        a.supDest = dp;
        if (!map.provinces[dp] || !abutsProvince(map, a.unit.type, a.unit.loc, dp)) {
          a.voided = true;
        } else if (!tgt.mv || tgt.destProv !== dp) {
          a.voided = true;
        } else if (
          !abutsProvince(map, tgt.unit.type, tgt.unit.loc, dp) &&
          !(tgt.unit.type === 'A' && hasConvoyRoute(map, seaFleets, tp, dp))
        ) {
          a.voided = true;
        }
      }
    } else if (o.kind === 'convoy') {
      const from = provinceOf(o.target.loc);
      const to = provinceOf(o.to);
      a.cvFrom = from;
      a.cvTo = to;
      const mover = byProv.get(from);
      if (
        a.unit.type !== 'F' ||
        !isSea(map, a.prov) ||
        !mover ||
        mover.unit.type !== 'A' ||
        !isCoastal(map, from) ||
        !isCoastal(map, to) ||
        !hasConvoyRouteThrough(map, seaFleets, from, to, a.prov)
      ) {
        a.voided = true;
      } else if (!mover.mv || mover.destProv !== to) {
        a.voided = true;
      }
    }
  }

  // ---- convoy routes & intent ----
  for (const a of adjs) {
    if (!a.mv || a.unit.type !== 'A') continue;
    const direct = canMoveDirect(map, 'A', a.unit.loc, a.destProv);
    const convoyers = adjs.filter(
      (c) => c.kind === 'convoy' && !c.voided && c.cvFrom === a.prov && c.cvTo === a.destProv,
    );
    const fleetSet = new Set(convoyers.map((c) => c.prov));
    let routes = convoyRoutes(map, fleetSet, a.prov, a.destProv);
    let uses: boolean;
    if (routes.length === 0) {
      uses = !direct;
    } else if (a.via || !direct) {
      uses = true;
    } else {
      uses = convoyers.some(
        (c) =>
          c.unit.power === a.unit.power &&
          hasConvoyRouteThrough(map, seaFleets, a.prov, a.destProv, c.prov),
      );
    }
    if (!uses) routes = [];
    a.usesConvoy = uses;
    a.routes = routes;
    const used = new Set<ProvinceId>();
    for (const r of routes) for (const s of r) used.add(s);
    for (const c of convoyers) if (used.has(c.prov)) c.onRoute = true;
  }

  const adj = new Adjudicator(map, adjs);

  // ---- results ----
  const dislodgedIdx: number[] = [];
  for (const a of adjs) {
    if (adj.isDislodged(a.idx)) dislodgedIdx.push(a.idx);
  }

  for (const a of adjs) {
    const dislodged = adj.isDislodged(a.idx);
    const out: OrderResult[] = [];
    if (a.order === null) {
      if (dislodged) out.push('dislodged');
      // implicit holds produce no order entry
      for (const r of out) results.push({ order: { kind: 'hold', unit: a.unit }, result: r });
      a.results = out;
      continue;
    }
    if (a.voided) {
      out.push('void');
    } else if (a.kind === 'move') {
      if (a.usesConvoy && !adj.hasPath(a.idx)) out.push('no-convoy');
      else if (adj.moves(a.idx)) out.push('ok');
      else out.push('bounce');
    } else if (a.kind === 'hold') {
      out.push('ok');
    } else if (a.kind === 'support') {
      const tgt = byProv.get(a.supProv);
      if (tgt && a.supDest !== null && tgt.mv && tgt.usesConvoy && !adj.hasPath(tgt.idx)) {
        // Supporting a convoyed move that never got a path: the python engine
        // records this both ways depending on the case, so record both.
        out.push('void');
        out.push('no-convoy');
      } else if (
        tgt &&
        a.supDest !== null &&
        adj.stayingOccupant(a.supDest)?.unit.power === a.unit.power &&
        (adj.moves(tgt.idx) || adj.selfDislodgeBounce(tgt.idx))
      ) {
        // A power may neither dislodge nor help dislodge its own unit; the
        // python engine records such supports as void (DATC 6.D.10-14, 6.E.*).
        out.push('void');
      } else if (!adj.supported(a.idx)) {
        out.push('cut');
      } else {
        out.push('ok');
      }
    } else {
      // convoy
      const mover = byProv.get(a.cvFrom);
      if (!a.onRoute) {
        out.push('no-convoy');
      } else if (mover && !adj.hasPath(mover.idx)) {
        // A route broken by a dislodged convoyer reads as "no convoy" for the
        // surviving fleets; a Szykman-disrupted (but intact) chain reads as
        // "disrupted".
        const anyDislodged = mover.routes.some((r) =>
          r.some((sea) => {
            const f = byProv.get(sea);
            return f !== undefined && adj.isDislodged(f.idx);
          }),
        );
        out.push(anyDislodged ? 'no-convoy' : 'disrupted');
      } else {
        out.push('ok');
      }
    }
    if (dislodged) {
      const idx = out.indexOf('disrupted');
      if (idx >= 0) out.splice(idx, 1);
      if (a.kind === 'support' && !out.includes('cut') && !out.includes('void') && !out.includes('no-convoy')) {
        const okIdx = out.indexOf('ok');
        if (okIdx >= 0) out.splice(okIdx, 1);
        out.push('cut');
      }
      const okIdx = out.indexOf('ok');
      if (okIdx >= 0 && a.kind !== 'move') out.splice(okIdx, 1);
      out.push('dislodged');
    }
    a.results = out;
    for (const r of out) results.push({ order: a.order, result: r });
  }

  // ---- next board ----
  const finalUnits: Unit[] = [];
  const dislodgedSet = new Set(dislodgedIdx);
  for (const a of adjs) {
    if (dislodgedSet.has(a.idx)) continue;
    if (a.kind === 'move' && !a.voided && adj.moves(a.idx)) {
      finalUnits.push({ power: a.unit.power, type: a.unit.type, loc: a.dest });
    } else {
      finalUnits.push(unitCopy(a.unit));
    }
  }
  const occupied = new Set(finalUnits.map((u) => provinceOf(u.loc)));

  // Provinces left empty by a stand-off cannot be retreated into.
  const standoff = new Set<ProvinceId>();
  const bounceCount = new Map<ProvinceId, number>();
  let succeeded = new Set<ProvinceId>();
  for (const a of adjs) {
    if (a.kind !== 'move' || a.voided) continue;
    if (adj.moves(a.idx)) succeeded.add(a.destProv);
    else if (adj.hasPath(a.idx)) bounceCount.set(a.destProv, (bounceCount.get(a.destProv) ?? 0) + 1);
  }
  for (const [p, c] of bounceCount) {
    if (c >= 2 && !succeeded.has(p) && !occupied.has(p)) standoff.add(p);
  }

  const dislodged: Dislodgement[] = [];
  for (const i of dislodgedIdx) {
    const a = adjs[i]!;
    const by = adj.dislodgerOf(i);
    const attacker = by >= 0 ? adjs[by]! : null;
    const attackerFrom = attacker ? attacker.prov : '';
    const forbidOrigin = attacker !== null && !attacker.usesConvoy;
    const retreatOptions = moveTargets(map, a.unit.type, a.unit.loc).filter((t) => {
      const p = provinceOf(t);
      if (occupied.has(p)) return false;
      if (forbidOrigin && p === attackerFrom) return false;
      if (standoff.has(p)) return false;
      return true;
    });
    dislodged.push({ unit: unitCopy(a.unit), attackerFrom, retreatOptions });
  }

  const next: GameState = {
    ...state,
    units: finalUnits,
    centers: cloneCenters(state.centers),
  };
  delete next.dislodged;
  delete next.pendingBirths;

  if (dislodged.length > 0) {
    next.phase = 'RETREAT';
    next.dislodged = dislodged;
  } else {
    if (state.season === 'FALL') {
      applyCaptures(next, map);
      next.season = 'WINTER';
      next.phase = 'ADJUSTMENT';
    } else {
      next.season = 'FALL';
      next.phase = 'MOVEMENT';
    }
  }
  return { results, dislodged, next };
}

// =============================================================== retreat phase

export function resolveRetreats(
  state: GameState,
  orders: readonly Order[],
  map: MapData,
): PhaseOutcome {
  const results: ResultEntry[] = [];
  const pending = state.dislodged ?? [];
  const byProv = new Map<ProvinceId, Dislodgement>();
  for (const d of pending) byProv.set(provinceOf(d.unit.loc), d);

  const chosen = new Map<ProvinceId, { order: RetreatOrder; to: Loc | null }>();
  for (const o of orders) {
    if (o.kind !== 'retreat' && o.kind !== 'disband') {
      results.push({ order: o, result: 'void' });
      continue;
    }
    const p = provinceOf(o.unit.loc);
    const d = byProv.get(p);
    if (!d || d.unit.power !== o.unit.power) {
      results.push({ order: o, result: 'void' });
      continue;
    }
    if (chosen.has(p)) {
      results.push({ order: chosen.get(p)!.order, result: 'void' });
    }
    if (o.kind === 'disband') {
      chosen.set(p, { order: o, to: null });
    } else {
      let to: Loc = o.to;
      const dp = provinceOf(to);
      const dprov = map.provinces[dp];
      if (dprov && dprov.coasts.length > 0 && coastOf(to) === '') {
        const opts = reachableLocsIn(map, d.unit.type, d.unit.loc, dp).filter((l) =>
          d.retreatOptions.includes(l),
        );
        if (opts.length === 1) to = opts[0]!;
      }
      if (!d.retreatOptions.includes(to)) {
        results.push({ order: o, result: 'void' });
        chosen.set(p, { order: o, to: null });
      } else {
        chosen.set(p, { order: o, to });
      }
    }
  }

  // Two retreats to the same province: both disband.
  const destCount = new Map<ProvinceId, number>();
  for (const c of chosen.values()) {
    if (c.to) destCount.set(provinceOf(c.to), (destCount.get(provinceOf(c.to)) ?? 0) + 1);
  }

  const survivors: Unit[] = state.units.map(unitCopy);
  for (const d of pending) {
    const p = provinceOf(d.unit.loc);
    const c = chosen.get(p);
    if (!c || c.to === null) {
      results.push({
        order: c ? c.order : { kind: 'disband', unit: unitCopy(d.unit) },
        result: 'disband',
      });
      continue;
    }
    if ((destCount.get(provinceOf(c.to)) ?? 0) > 1) {
      results.push({ order: c.order, result: 'bounce' });
      results.push({ order: c.order, result: 'disband' });
      continue;
    }
    survivors.push({ power: d.unit.power, type: d.unit.type, loc: c.to });
    results.push({ order: c.order, result: 'ok' });
  }

  const next: GameState = { ...state, units: survivors, centers: cloneCenters(state.centers) };
  delete next.dislodged;
  if (state.season === 'FALL') {
    applyCaptures(next, map);
    next.season = 'WINTER';
    next.phase = 'ADJUSTMENT';
  } else {
    next.season = 'FALL';
    next.phase = 'MOVEMENT';
  }
  return { results, next };
}

// ============================================================ adjustment phase

export function resolveAdjustments(
  state: GameState,
  orders: readonly Order[],
  map: MapData,
): PhaseOutcome {
  const results: ResultEntry[] = [];
  const units: Unit[] = state.units.map(unitCopy);

  const byPower = new Map<Power, BuildOrder[]>();
  for (const o of orders) {
    if (o.kind !== 'build' && o.kind !== 'remove' && o.kind !== 'waive') {
      results.push({ order: o, result: 'void' });
      continue;
    }
    const power = o.kind === 'waive' ? o.power : o.unit.power;
    if (power === 'NEUTRAL') {
      results.push({ order: o, result: 'void' });
      continue;
    }
    const list = byPower.get(power);
    if (list) list.push(o);
    else byPower.set(power, [o]);
  }

  for (const power of GREAT_POWERS) {
    if (power === 'NEUTRAL') continue;
    const centers = state.centers[power] ?? [];
    const own = () => units.filter((u) => u.power === power);
    let diff = own().length - centers.length; // >0 must remove, <0 may build
    const list = byPower.get(power) ?? [];

    // Validation pass.
    const usable: BuildOrder[] = [];
    const sitesUsed = new Set<ProvinceId>();
    const removeOrdered = new Set<ProvinceId>();
    for (const o of list) {
      if (o.kind === 'waive') {
        usable.push(o);
        continue;
      }
      const p = provinceOf(o.unit.loc);
      const prov = map.provinces[p];
      if (o.kind === 'build') {
        const occupiedNow = units.some((u) => provinceOf(u.loc) === p);
        const ok =
          prov !== undefined &&
          prov.home === power &&
          centers.includes(p) &&
          !occupiedNow &&
          !sitesUsed.has(p) &&
          validBuildUnit(map, o.unit);
        if (!ok) {
          results.push({ order: o, result: 'void' });
          continue;
        }
        sitesUsed.add(p);
        usable.push(o);
      } else {
        const board = units.find((u) => provinceOf(u.loc) === p && u.power === power);
        if (!board || removeOrdered.has(p)) {
          results.push({ order: o, result: 'void' });
          continue;
        }
        removeOrdered.add(p);
        usable.push(o);
      }
    }

    // Application pass, one order at a time.
    const applied: BuildOrder[] = [];
    for (const o of usable) {
      if (diff === 0) {
        results.push({ order: o, result: 'void' });
      } else if (diff < 0) {
        if (o.kind === 'remove') {
          results.push({ order: o, result: 'void' });
        } else {
          diff++;
          applied.push(o);
        }
      } else {
        if (o.kind === 'remove') {
          diff--;
          applied.push(o);
        } else {
          results.push({ order: o, result: 'void' });
        }
      }
    }

    for (const o of applied) {
      if (o.kind === 'build') {
        units.push(unitCopy(o.unit));
        results.push({ order: o, result: 'ok' });
      } else if (o.kind === 'remove') {
        const p = provinceOf(o.unit.loc);
        const i = units.findIndex((u) => provinceOf(u.loc) === p && u.power === power);
        if (i >= 0) units.splice(i, 1);
        results.push({ order: o, result: 'ok' });
      } else {
        results.push({ order: o, result: 'ok' });
      }
    }

    // Civil disorder: auto-remove the units furthest from home.
    if (diff > 0) {
      const homes = Object.values(map.provinces)
        .filter((p) => p.home === power)
        .map((p) => p.id);
      const ranked = own()
        .map((u) => ({ u, d: distanceToHome(map, u.type, u.loc, homes) }))
        .sort((x, y) => {
          if (x.d !== y.d) return y.d - x.d;
          if (x.u.type !== y.u.type) return x.u.type === 'F' ? -1 : 1;
          return x.u.loc < y.u.loc ? -1 : 1;
        });
      for (let k = 0; k < diff && k < ranked.length; k++) {
        const goner = ranked[k]!.u;
        const i = units.indexOf(goner);
        if (i >= 0) units.splice(i, 1);
        results.push({ order: { kind: 'remove', unit: unitCopy(goner) }, result: 'disband' });
      }
    }
  }

  const next: GameState = {
    ...state,
    units,
    centers: cloneCenters(state.centers),
    year: state.year + 1,
    season: 'SPRING',
    phase: 'MOVEMENT',
  };
  delete next.dislodged;
  return { results, next };
}

// ==================================================================== helpers

function validBuildUnit(map: MapData, unit: Unit): boolean {
  const prov = map.provinces[provinceOf(unit.loc)];
  if (!prov) return false;
  if (unit.type === 'A') return prov.type !== 'sea' && coastOf(unit.loc) === '';
  if (prov.type !== 'coastal') return false;
  if (prov.coasts.length > 0) return prov.coasts.includes(coastOf(unit.loc));
  return coastOf(unit.loc) === '';
}

function cloneCenters(c: GameState['centers']): GameState['centers'] {
  const out: GameState['centers'] = {};
  for (const [k, v] of Object.entries(c)) out[k as Power] = [...(v ?? [])];
  return out;
}

/** Fall capture: every occupied supply centre changes hands. */
function applyCaptures(state: GameState, map: MapData): void {
  for (const u of state.units) {
    if (u.power === 'NEUTRAL') continue;
    const p = map.provinces[provinceOf(u.loc)];
    if (!p || !p.sc) continue;
    for (const power of Object.keys(state.centers) as Power[]) {
      const list = state.centers[power];
      if (!list) continue;
      const i = list.indexOf(p.id);
      if (i >= 0 && power !== u.power) list.splice(i, 1);
    }
    const own = state.centers[u.power] ?? (state.centers[u.power] = []);
    if (!own.includes(p.id)) own.push(p.id);
  }
  for (const power of Object.keys(state.centers) as Power[]) state.centers[power]?.sort();
}
