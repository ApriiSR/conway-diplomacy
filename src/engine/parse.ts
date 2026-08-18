import type {
  BuildOrder,
  GameState,
  Loc,
  MapData,
  Order,
  Power,
  ProvinceId,
  Unit,
  UnitType,
} from './types.js';
import { GREAT_POWERS } from './types.js';
import { coastOf, provinceOf, reachableLocsIn } from './map-utils.js';
import ALIASES from './aliases.json' with { type: 'json' };

export interface ParseError {
  line: string;
  message: string;
  /**
   * 'duplicate' = the line parsed fine, but its unit already had an order.
   * 'coast' = the line parsed, and the order is kept, but its coast is wrong or
   * missing where one is needed — the adjudicator will void it, so the GM is told
   * now rather than after the fact.
   */
  kind?: 'duplicate' | 'coast';
}

/** A unit that was given more than one order; only the last of them is kept. */
export interface DuplicateOrder {
  loc: Loc;
  type: UnitType;
  count: number;
}

export interface ParseResult {
  orders: Order[];
  errors: ParseError[];
  /** Non-empty when some unit was ordered twice — reported, and resolved last-wins. */
  duplicates: DuplicateOrder[];
}

// ---------------------------------------------------------------- tokenising

const SEPARATORS = /[\s,;.:]+/;

/** Split a line into words, with '-', '/', '(', ')' as their own tokens. */
function tokenize(text: string): string[] {
  const spaced = text
    .toLowerCase()
    .replace(/->|—|–|→|=>/g, '-')
    .replace(/([-/()])/g, ' $1 ');
  return spaced.split(SEPARATORS).filter((t) => t.length > 0);
}

// Longest-first list of [tokens, loc] built from the map alias table.
interface AliasEntry {
  tokens: string[];
  loc: Loc;
}
let ALIAS_INDEX: AliasEntry[] | null = null;

function aliasIndex(map: MapData): AliasEntry[] {
  if (ALIAS_INDEX) return ALIAS_INDEX;
  const table = ALIASES as Record<string, string[]>;
  const seen = new Set<string>();
  const entries: AliasEntry[] = [];
  const add = (spelling: string, loc: Loc): void => {
    const tokens = tokenize(spelling);
    if (tokens.length === 0) return;
    const key = `${tokens.join(' ')}=>${loc}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ tokens, loc });
  };
  for (const [loc, spellings] of Object.entries(table)) {
    for (const s of spellings) add(s, loc);
  }
  for (const p of Object.values(map.provinces)) {
    add(p.id, p.id);
    add(p.name, p.id);
    for (const c of p.coasts) {
      add(`${p.id}/${c}`, `${p.id}/${c}`);
      add(`${p.name} ${c}`, `${p.id}/${c}`);
    }
  }
  entries.sort((a, b) => b.tokens.length - a.tokens.length);
  ALIAS_INDEX = entries;
  return entries;
}

const COAST_WORDS: Record<string, string> = {
  nc: 'nc',
  sc: 'sc',
  ec: 'ec',
  wc: 'wc',
  north: 'nc',
  south: 'sc',
  east: 'ec',
  west: 'wc',
};

/** Greedy longest match of a location starting at `i`. Returns null if none. */
function matchLoc(
  map: MapData,
  tokens: string[],
  i: number,
): { loc: Loc; next: number } | null {
  for (const entry of aliasIndex(map)) {
    const n = entry.tokens.length;
    if (i + n > tokens.length) continue;
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (tokens[i + k] !== entry.tokens[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let loc = entry.loc;
    let next = i + n;
    // Trailing coast qualifier not already part of the alias, e.g. 'spa / sc',
    // 'spa ( sc )', 'spa sc', 'spa ( south coast )'.
    if (coastOf(loc) === '') {
      const prov = map.provinces[provinceOf(loc)];
      if (prov && prov.coasts.length > 0) {
        let j = next;
        let paren = false;
        if (tokens[j] === '/') j++;
        else if (tokens[j] === '(') {
          paren = true;
          j++;
        }
        const word = tokens[j];
        const coast = word ? COAST_WORDS[word] : undefined;
        // 'north'/'south'/... only count as a coast when followed by 'coast'.
        const spelled = word !== undefined && word.length > 2;
        if (coast && prov.coasts.includes(coast) && (!spelled || tokens[j + 1] === 'coast')) {
          j++;
          if (tokens[j] === 'coast') j++;
          if (paren && tokens[j] === ')') j++;
          loc = `${prov.id}/${coast}`;
          next = j;
        } else if (paren) {
          // '(' that isn't a coast: leave it alone
        }
      }
    }
    return { loc, next };
  }
  return null;
}

// ------------------------------------------------------------------- helpers

const POWER_WORDS: Record<string, Power> = {
  austria: 'AUSTRIA',
  austrian: 'AUSTRIA',
  'austria-hungary': 'AUSTRIA',
  england: 'ENGLAND',
  english: 'ENGLAND',
  britain: 'ENGLAND',
  france: 'FRANCE',
  french: 'FRANCE',
  germany: 'GERMANY',
  german: 'GERMANY',
  italy: 'ITALY',
  italian: 'ITALY',
  russia: 'RUSSIA',
  russian: 'RUSSIA',
  turkey: 'TURKEY',
  turkish: 'TURKEY',
  neutral: 'NEUTRAL',
};

const UNIT_WORDS: Record<string, UnitType> = { a: 'A', army: 'A', f: 'F', fleet: 'F' };

const HOLD_WORDS = new Set(['h', 'hold', 'holds', 'holding', 'stand', 'stands']);
const SUPPORT_WORDS = new Set(['s', 'sup', 'supp', 'support', 'supports', 'supporting']);
const CONVOY_WORDS = new Set(['c', 'convoy', 'convoys', 'convoying']);
const RETREAT_WORDS = new Set(['r', 'retreat', 'retreats', 'retreating']);
const DISBAND_WORDS = new Set(['d', 'disband', 'disbands', 'disbanded']);
const BUILD_WORDS = new Set(['b', 'build', 'builds']);
const REMOVE_WORDS = new Set(['remove', 'removes']);
const WAIVE_WORDS = new Set(['waive', 'waives', 'waived']);

function unitAt(state: GameState, loc: Loc): Unit | undefined {
  const p = provinceOf(loc);
  return state.units.find((u) => provinceOf(u.loc) === p);
}

function dislodgementAt(state: GameState, loc: Loc) {
  const p = provinceOf(loc);
  return state.dislodged?.find((d) => provinceOf(d.unit.loc) === p);
}

function dislodgedAt(state: GameState, loc: Loc): Unit | undefined {
  return dislodgementAt(state, loc)?.unit;
}

type ParsePhase = 'MOVEMENT' | 'RETREAT' | 'ADJUSTMENT' | 'SPAWN_CHOICE';

function phaseKindOf(state: GameState): ParsePhase {
  if (state.phase === 'RETREAT') return 'RETREAT';
  if (state.phase === 'ADJUSTMENT') return 'ADJUSTMENT';
  if (state.phase === 'SPAWN_CHOICE') return 'SPAWN_CHOICE';
  return 'MOVEMENT';
}

// -------------------------------------------------------------------- parser

/**
 * Tolerant order parser. Accepts the usual notations; unparseable or
 * illegal-for-the-phase lines are reported in `errors` and skipped.
 */
export function parseOrders(
  text: string,
  state: GameState,
  map: MapData,
  defaultPower?: Power,
): ParseResult {
  const orders: Order[] = [];
  const errors: ParseError[] = [];
  const phase = phaseKindOf(state);
  let headerPower: Power | undefined = defaultPower;

  // One unit, one order. A second order for the same unit is the GM re-entering a line
  // (a typo fix, or the same player's orders pasted twice), so the LAST one wins — but it
  // is flagged, because silently dropping one of two contradictory orders is exactly the
  // kind of thing a GM needs to see before adjudicating.
  interface Seen {
    index: number;
    lineNo: number;
    line: string;
    count: number;
  }
  const seen = new Map<ProvinceId, Seen>();
  const dropped = new Set<number>();

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
    try {
      const parsed = parseLine(line, state, map, phase, headerPower, defaultPower);
      if (parsed === 'header') continue;
      if (parsed.headerPower) {
        headerPower = parsed.headerPower;
        if (!parsed.order) continue;
      }
      if (!parsed.order) continue;
      if (parsed.warning) errors.push({ line, kind: 'coast', message: parsed.warning });
      const order = parsed.order;
      const index = orders.length;
      orders.push(order);
      // Adjustment orders are keyed by province rather than by a unit on the board, and
      // duplicates there are already reported as build/remove warnings.
      if (phase === 'ADJUSTMENT' || !('unit' in order)) continue;
      const key = provinceOf(order.unit.loc);
      const prev = seen.get(key);
      if (prev) {
        dropped.add(prev.index);
        errors.push({
          line,
          kind: 'duplicate',
          message:
            `${order.unit.type} ${key.toUpperCase()} already has an order ` +
            `(line ${prev.lineNo}: “${prev.line}”) — the last order for a unit wins.`,
        });
      }
      seen.set(key, { index, lineNo: n + 1, line, count: (prev?.count ?? 0) + 1 });
    } catch (e) {
      errors.push({ line, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const duplicates: DuplicateOrder[] = [];
  if (dropped.size) {
    for (const [key, s] of seen) {
      if (s.count < 2) continue;
      const kept = orders[s.index];
      const type = kept && 'unit' in kept ? kept.unit.type : 'A';
      duplicates.push({ loc: key, type, count: s.count });
    }
  }
  return {
    orders: dropped.size ? orders.filter((_, i) => !dropped.has(i)) : orders,
    errors,
    duplicates,
  };
}

interface LineResult {
  order?: Order;
  headerPower?: Power;
  /** A kept-but-doomed order: bad or missing coast, reported as a 'coast' error. */
  warning?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

/** 'spa/sc' -> 'SPA/SC'. */
function locName(loc: Loc): string {
  const i = loc.indexOf('/');
  return i < 0 ? loc.toUpperCase() : `${loc.slice(0, i).toUpperCase()}/${loc.slice(i + 1).toUpperCase()}`;
}

function orList(locs: readonly Loc[]): string {
  const names = locs.map(locName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Coast trouble in a fleet's destination, for a move or a retreat: either the
 * province has coasts and the order named none where more than one is available,
 * or it named one the fleet cannot actually go to. `options` is the set of exact
 * locations in the destination province this fleet may reach. Returns undefined
 * when the order is fine — including the coastless-but-unambiguous case, which
 * the resolver fills in.
 */
function coastWarning(
  map: MapData,
  from: Loc,
  to: Loc,
  options: readonly Loc[],
  verb: 'move' | 'retreat',
): string | undefined {
  const prov = map.provinces[provinceOf(to)];
  if (!prov || prov.coasts.length === 0) return undefined;
  if (coastOf(to) === '') {
    if (options.length < 2) return undefined;
    return `which coast? write ${orList(options)}`;
  }
  if (options.length === 0 || options.includes(to)) return undefined;
  return verb === 'move'
    ? `${provinceOf(from).toUpperCase()} does not border ${locName(to)} — only ${orList(options)}`
    : `${locName(to)} is not a legal retreat — only ${orList(options)}`;
}

function parseLine(
  line: string,
  state: GameState,
  map: MapData,
  phase: ParsePhase,
  headerPower: Power | undefined,
  defaultPower: Power | undefined,
): LineResult | 'header' {
  let tokens = tokenize(line);
  let power: Power | undefined = headerPower ?? defaultPower;

  // Leading power name, possibly the whole line ("France:").
  const first = tokens[0];
  if (first !== undefined && POWER_WORDS[first] !== undefined) {
    // Don't swallow a power word that is actually a province ('turkey' isn't one,
    // so this is safe on the standard map).
    power = POWER_WORDS[first];
    tokens = tokens.slice(1);
    if (tokens.length === 0) return { headerPower: power };
  }
  if (tokens.length === 0) return 'header';

  // Adjustment-phase prefix forms.
  const head = tokens[0]!;
  if (WAIVE_WORDS.has(head)) {
    if (phase !== 'ADJUSTMENT') fail('waive is only legal in an adjustment phase');
    if (!power) fail('cannot tell whose waive this is — prefix the line with a power');
    return { order: { kind: 'waive', power } satisfies BuildOrder };
  }
  let prefixKind: 'build' | 'remove' | null = null;
  if (BUILD_WORDS.has(head) && tokens.length > 1) {
    prefixKind = 'build';
    tokens = tokens.slice(1);
  } else if (REMOVE_WORDS.has(head) || (DISBAND_WORDS.has(head) && tokens.length > 1)) {
    prefixKind = 'remove';
    tokens = tokens.slice(1);
  }

  // [A|F] <loc>
  let i = 0;
  let type: UnitType | undefined;
  const t0 = tokens[i];
  if (t0 !== undefined && UNIT_WORDS[t0] !== undefined) {
    type = UNIT_WORDS[t0];
    i++;
  }
  const locMatch = matchLoc(map, tokens, i);
  if (!locMatch) fail(`unknown province in "${line}"`);
  const loc = locMatch.loc;
  i = locMatch.next;

  if (prefixKind === 'build') {
    if (phase === 'SPAWN_CHOICE') return { order: spawnOrder(map, state, loc, type, power) };
    return buildResult(map, state, loc, type, power, phase);
  }
  if (prefixKind === 'remove') {
    return { order: removeOrder(state, loc, type, power, phase) };
  }

  const rest = tokens.slice(i);
  const verb = rest[0];

  // A spawn decision is a build: the only thing the GM records this phase is which unit
  // type each pending coastal birth becomes. 'Build F Edi', 'F Edi' and 'F Edi B' all mean it.
  if (phase === 'SPAWN_CHOICE') {
    if (verb === undefined || BUILD_WORDS.has(verb)) {
      return { order: spawnOrder(map, state, loc, type, power) };
    }
    fail(`"${line}" is not a spawn decision — write e.g. "Build F ${provinceOf(loc).toUpperCase()}"`);
  }

  // Adjustment-phase suffix forms: 'A Par B', 'A Par D' (in ADJUSTMENT).
  if (phase === 'ADJUSTMENT') {
    if (verb !== undefined && BUILD_WORDS.has(verb)) {
      return buildResult(map, state, loc, type, power, phase);
    }
    if (verb !== undefined && (DISBAND_WORDS.has(verb) || REMOVE_WORDS.has(verb))) {
      return { order: removeOrder(state, loc, type, power, phase) };
    }
    fail(`"${line}" is not a build/remove/waive order`);
  }

  // Everything else needs a unit on the board.
  const board = phase === 'RETREAT' ? dislodgedAt(state, loc) : unitAt(state, loc);
  if (!board) {
    fail(
      phase === 'RETREAT'
        ? `no dislodged unit in ${provinceOf(loc).toUpperCase()}`
        : `no unit in ${provinceOf(loc).toUpperCase()}`,
    );
  }
  if (type && board.type !== type) {
    fail(`the unit in ${provinceOf(loc).toUpperCase()} is a${board.type === 'A' ? 'n army' : ' fleet'}`);
  }
  if (board.power === 'NEUTRAL') {
    fail(`the unit in ${provinceOf(loc).toUpperCase()} is neutral and takes no orders`);
  }
  if (power && board.power !== power) {
    fail(
      `the unit in ${provinceOf(loc).toUpperCase()} belongs to ${board.power}, not ${power}`,
    );
  }
  const unit: Unit = { power: board.power, type: board.type, loc: board.loc };

  if (phase === 'RETREAT') {
    if (verb === undefined || DISBAND_WORDS.has(verb)) {
      return { order: { kind: 'disband', unit } };
    }
    let j = 0;
    if (RETREAT_WORDS.has(verb) || verb === '-') j = 1;
    if (rest[j] === 'to') j++;
    if (rest[j] === '-') j++;
    const dest = matchLoc(map, rest, j);
    // Anything else (a support, a convoy, ...) is not a retreat order at all;
    // hand it to the resolver as a stray so it gets recorded as void.
    if (!dest) return { order: { kind: 'hold', unit } };
    const to: Loc = unit.type === 'A' ? provinceOf(dest.loc) : dest.loc;
    const options =
      unit.type === 'F'
        ? (dislodgementAt(state, loc)?.retreatOptions ?? []).filter((l) => provinceOf(l) === provinceOf(to))
        : [];
    const warning = coastWarning(map, unit.loc, to, options, 'retreat');
    const order: Order = { kind: 'retreat', unit, to };
    return warning ? { order, warning } : { order };
  }

  // Movement phase.
  if (verb === undefined || HOLD_WORDS.has(verb)) {
    return { order: { kind: 'hold', unit } };
  }
  if (verb === '-') {
    const dest = matchLoc(map, rest, 1);
    if (!dest) fail(`unknown destination in "${line}"`);
    const tail = rest.slice(dest.next);
    const viaConvoy = tail.some((t) => t === 'via' || t === 'convoy' || t === 'convoys');
    // An army's coast is noise: 'A Mar - Spa/sc' is a move to Spain (DATC 6.B.12).
    const to: Loc = unit.type === 'A' ? provinceOf(dest.loc) : dest.loc;
    const warning =
      unit.type === 'F'
        ? coastWarning(map, unit.loc, to, reachableLocsIn(map, 'F', unit.loc, provinceOf(to)), 'move')
        : undefined;
    const order: Order = viaConvoy
      ? { kind: 'move', unit, to, viaConvoy: true }
      : { kind: 'move', unit, to };
    return warning ? { order, warning } : { order };
  }
  if (SUPPORT_WORDS.has(verb) || CONVOY_WORDS.has(verb)) {
    const isConvoy = CONVOY_WORDS.has(verb);
    let j = 1;
    let targetType: UnitType | undefined;
    const tw = rest[j];
    if (tw !== undefined && UNIT_WORDS[tw] !== undefined) {
      targetType = UNIT_WORDS[tw];
      j++;
    }
    const tgt = matchLoc(map, rest, j);
    if (!tgt) fail(`unknown supported/convoyed province in "${line}"`);
    j = tgt.next;
    const target = unitAt(state, tgt.loc);
    if (!target) fail(`no unit in ${provinceOf(tgt.loc).toUpperCase()} to ${isConvoy ? 'convoy' : 'support'}`);
    if (targetType && target.type !== targetType) {
      fail(`the unit in ${provinceOf(tgt.loc).toUpperCase()} is a${target.type === 'A' ? 'n army' : ' fleet'}`);
    }
    const targetUnit: Unit = { power: target.power, type: target.type, loc: target.loc };
    let k = j;
    if (rest[k] !== undefined && HOLD_WORDS.has(rest[k]!)) k++;
    if (rest[k] === 'to') k++;
    if (rest[k] === '-') {
      const dest = matchLoc(map, rest, k + 1);
      if (!dest) fail(`unknown destination in "${line}"`);
      if (isConvoy) return { order: { kind: 'convoy', unit, target: targetUnit, to: dest.loc } };
      return { order: { kind: 'support', unit, target: targetUnit, to: dest.loc } };
    }
    if (isConvoy) fail('a convoy order needs a destination');
    return { order: { kind: 'support', unit, target: targetUnit } };
  }
  fail(`could not understand "${line}"`);
}

/**
 * A pending coastal birth's army-or-fleet decision, written as a build order. Validated
 * against `pendingBirths`: the province must actually be waiting on a choice, the power
 * (if the line names one) must be the one the birth belongs to, and the type/coast must
 * be legal for the province.
 */
function spawnOrder(
  map: MapData,
  state: GameState,
  loc: Loc,
  type: UnitType | undefined,
  power: Power | undefined,
): BuildOrder {
  const id = provinceOf(loc);
  const name = id.toUpperCase();
  const event = state.pendingBirths?.find((e) => e.province === id);
  if (!event) fail(`no birth is waiting on a choice in ${name}`);
  if (power && power !== event.power) {
    fail(`the birth in ${name} belongs to ${event.power}, not ${power}`);
  }
  if (!type) fail(`say which: "Build A ${name}" or "Build F ${name}"`);
  const prov = map.provinces[id];
  if (!prov) fail(`unknown province ${id}`);
  const coast = coastOf(loc);
  if (type === 'A' && coast) fail(`an army in ${name} has no coast`);
  if (type === 'F' && prov.coasts.length > 0 && !coast) {
    fail(`a fleet in ${name} needs a coast: ${prov.coasts.map((c) => `${name}/${c.toUpperCase()}`).join(' or ')}`);
  }
  return { kind: 'build', unit: { power: event.power, type, loc: type === 'A' ? id : loc } };
}

/** The coast half of a build order, which the adjudicator voids if it is wrong. */
function buildCoastWarning(map: MapData, loc: Loc, type: UnitType): string | undefined {
  const prov = map.provinces[provinceOf(loc)];
  if (!prov || prov.coasts.length === 0) return undefined;
  const name = provinceOf(loc).toUpperCase();
  if (type === 'A' && coastOf(loc) !== '') return `an army in ${name} has no coast`;
  if (type === 'F' && coastOf(loc) === '') {
    return `a fleet in ${name} needs a coast: ${orList(prov.coasts.map((c) => `${prov.id}/${c}`))}`;
  }
  return undefined;
}

function buildResult(
  map: MapData,
  state: GameState,
  loc: Loc,
  type: UnitType | undefined,
  power: Power | undefined,
  phase: string,
): LineResult {
  const order = buildOrder(map, state, loc, type, power, phase);
  const warning =
    order.kind === 'build' ? buildCoastWarning(map, order.unit.loc, order.unit.type) : undefined;
  return warning ? { order, warning } : { order };
}

function buildOrder(
  map: MapData,
  state: GameState,
  loc: Loc,
  type: UnitType | undefined,
  power: Power | undefined,
  phase: string,
): BuildOrder {
  if (phase !== 'ADJUSTMENT') fail('builds are only legal in an adjustment phase');
  const prov = map.provinces[provinceOf(loc)];
  if (!prov) fail(`unknown province ${loc}`);
  let owner = power;
  if (!owner) {
    for (const p of GREAT_POWERS) {
      if (state.centers[p]?.includes(prov.id)) owner = p;
    }
  }
  if (!owner) fail(`cannot tell who is building in ${prov.id.toUpperCase()}`);
  if (owner === 'NEUTRAL') fail('NEUTRAL has no adjustments');
  const t: UnitType = type ?? (prov.type === 'sea' ? 'F' : 'A');
  return { kind: 'build', unit: { power: owner, type: t, loc } };
}

function removeOrder(
  state: GameState,
  loc: Loc,
  type: UnitType | undefined,
  power: Power | undefined,
  phase: string,
): BuildOrder {
  if (phase !== 'ADJUSTMENT') fail('removals are only legal in an adjustment phase');
  const board = unitAt(state, loc);
  if (!board) {
    // Removing a unit that isn't there is a legal thing to *write*; the
    // adjudicator voids it (DATC 6.J.1), so the order still needs to exist.
    if (!power) fail(`no unit in ${provinceOf(loc).toUpperCase()}`);
    return { kind: 'remove', unit: { power, type: type ?? 'A', loc } };
  }
  if (type && board.type !== type) {
    fail(`the unit in ${provinceOf(loc).toUpperCase()} is a${board.type === 'A' ? 'n army' : ' fleet'}`);
  }
  if (board.power === 'NEUTRAL') fail('NEUTRAL has no adjustments');
  if (power && board.power !== power) {
    fail(`the unit in ${provinceOf(loc).toUpperCase()} belongs to ${board.power}, not ${power}`);
  }
  return { kind: 'remove', unit: { power: board.power, type: board.type, loc: board.loc } };
}
