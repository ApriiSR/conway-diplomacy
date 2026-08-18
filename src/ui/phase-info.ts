// Per-phase bookkeeping the GM needs on screen: adjustment allowances and the
// warnings that go with them, plus the retreat roster. Pure functions over state
// + parsed orders, so main.ts just renders what comes back.

import type { Dislodgement, GameState, MapData, Order, Power, ProvinceId } from '../engine/types.js';
import { GREAT_POWERS } from '../engine/types.js';
import { provinceOf } from '../engine/map-utils.js';
import { locText } from './orders-text.js';
import { POWER_ADJECTIVE, powerTitle } from './colors.js';

export interface PowerCount {
  power: Power;
  centers: number;
  units: number;
  /** centres − units: >0 may build that many, <0 must remove that many. */
  delta: number;
}

export function powerCounts(state: GameState): PowerCount[] {
  return GREAT_POWERS.filter((p) => p !== 'NEUTRAL').map((power) => {
    const centers = state.centers[power]?.length ?? 0;
    const units = state.units.filter((u) => u.power === power).length;
    return { power, centers, units, delta: centers - units };
  });
}

/** "5/5", "builds +1", "must remove 2" — the short form used on tabs. */
export function countChip(c: PowerCount): string {
  return `${c.centers}/${c.units}`;
}

export function deltaText(c: PowerCount): string {
  if (c.delta > 0) return `builds +${c.delta}`;
  if (c.delta < 0) return `must remove ${-c.delta}`;
  return 'even';
}

export interface Warning {
  power: Power;
  message: string;
}

/**
 * Parse-time checks the engine would only report as `void` after adjudication:
 * over-building, illegal build sites, removals that can't apply, and owed
 * removals nobody ordered.
 */
export function adjustmentWarnings(
  state: GameState,
  map: MapData,
  ordersByPower: Map<Power, Order[]>,
): Warning[] {
  const out: Warning[] = [];
  for (const c of powerCounts(state)) {
    const orders = ordersByPower.get(c.power) ?? [];
    const builds = orders.filter((o) => o.kind === 'build');
    const removes = orders.filter((o) => o.kind === 'remove');
    const waives = orders.filter((o) => o.kind === 'waive');
    const name = powerTitle(c.power);
    const adj = POWER_ADJECTIVE[c.power];
    const centers = state.centers[c.power] ?? [];
    const seen = new Set<ProvinceId>();

    for (const o of builds) {
      if (o.kind !== 'build') continue;
      const p = provinceOf(o.unit.loc);
      const prov = map.provinces[p];
      const where = locText(o.unit.loc);
      if (!prov) {
        out.push({ power: c.power, message: `${name}: build in ${where} — unknown province (void).` });
        continue;
      }
      if (prov.home !== c.power) {
        out.push({ power: c.power, message: `${name}: build in ${where} — not a ${adj} home centre (void).` });
      } else if (!centers.includes(p)) {
        out.push({ power: c.power, message: `${name}: build in ${where} — ${name} does not own that centre (void).` });
      } else if (state.units.some((u) => provinceOf(u.loc) === p)) {
        out.push({ power: c.power, message: `${name}: build in ${where} — the centre is occupied (void).` });
      } else if (seen.has(p)) {
        out.push({ power: c.power, message: `${name}: two builds ordered in ${where} (the second is void).` });
      }
      seen.add(p);
    }

    if (c.delta <= 0 && builds.length) {
      out.push({
        power: c.power,
        message: `${name}: ${builds.length} build${builds.length === 1 ? '' : 's'} ordered but ${name} has no builds due (void).`,
      });
    } else if (c.delta > 0 && builds.length + waives.length > c.delta) {
      out.push({
        power: c.power,
        message: `${name}: ${builds.length + waives.length} builds/waives ordered, allowance is ${c.delta} — the extras are void.`,
      });
    }

    if (c.delta >= 0 && removes.length) {
      out.push({
        power: c.power,
        message: `${name}: ${removes.length} removal${removes.length === 1 ? '' : 's'} ordered but none are owed (void).`,
      });
    }
    if (c.delta < 0) {
      const owed = -c.delta;
      const valid = removes.filter(
        (o) => o.kind === 'remove' && state.units.some((u) => provinceOf(u.loc) === provinceOf(o.unit.loc) && u.power === c.power),
      );
      for (const o of removes) {
        if (o.kind !== 'remove') continue;
        if (!valid.includes(o)) {
          out.push({ power: c.power, message: `${name}: remove ${locText(o.unit.loc)} — no ${adj} unit there (void).` });
        }
      }
      if (valid.length < owed) {
        out.push({
          power: c.power,
          message: `${name} must remove ${owed}${valid.length ? ` (${valid.length} ordered)` : ''} — the engine will auto-remove by distance from home.`,
        });
      }
    }
  }
  return out;
}

export interface RetreatRow {
  power: Power;
  text: string;
  ordered: boolean;
}

export function retreatRows(state: GameState, ordersByPower: Map<Power, Order[]>): RetreatRow[] {
  const ordered = new Set<string>();
  for (const list of ordersByPower.values()) {
    for (const o of list) {
      if (o.kind === 'retreat' || o.kind === 'disband') ordered.add(provinceOf(o.unit.loc));
    }
  }
  return (state.dislodged ?? []).map((d: Dislodgement) => {
    const has = ordered.has(provinceOf(d.unit.loc));
    // A neutral takes no orders at all, so there is nothing for the GM to chase: it is
    // dislodged like anyone else and then disbands for want of a retreat order.
    if (d.unit.power === 'NEUTRAL') {
      return {
        power: d.unit.power,
        ordered: true,
        text: `Neutral ${d.unit.type} ${locText(d.unit.loc)} — no orders, will disband`,
      };
    }
    const opts = d.retreatOptions.length
      ? d.retreatOptions.map(locText).join(', ')
      : 'nowhere to go — must disband';
    return {
      power: d.unit.power,
      ordered: has,
      text: `${powerTitle(d.unit.power)} ${d.unit.type} ${locText(d.unit.loc)} → ${opts}${has ? '' : ' — unordered, will disband'}`,
    };
  });
}
