// Life step for the Conway's Game of Diplomacy variant. A pure function of the units and the
// map: it never calls a resolver and holds no state.
// The rule text this implements is in src/ui/rules-text.ts ("The Life step").

import type { LifeEvent, LifeResult, MapData, Power, ProvinceId, Unit } from '../engine/types';
import { provinceOf } from '../engine/map-utils';

export function lifeStep(units: Unit[], map: MapData): LifeResult {
  const occupant = new Map<ProvinceId, Unit>();
  for (const u of units) {
    const province = provinceOf(u.loc);
    if (!(province in map.lifeAdjacency)) {
      throw new Error(`lifeStep(): unit ${u.power} ${u.type} ${u.loc} is in unknown province '${province}' (not in lifeAdjacency)`);
    }
    if (occupant.has(province)) {
      const other = occupant.get(province)!;
      throw new Error(`lifeStep(): two units occupy '${province}': ${other.power} ${other.type} ${other.loc} and ${u.power} ${u.type} ${u.loc}`);
    }
    occupant.set(province, u);
  }

  const provinceIds = Object.keys(map.lifeAdjacency).sort();
  const events: LifeEvent[] = [];
  const survivors: Unit[] = [];

  // Deaths & survivals: all counts below are computed against the pre-step
  // occupant map, so a province that is itself dying this round still
  // counts as an occupied neighbour for everyone else (simultaneous update).
  for (const id of provinceIds) {
    const unit = occupant.get(id);
    if (!unit) continue;
    const neighbours = map.lifeAdjacency[id] ?? [];
    const occNeighbours = neighbours.filter((n) => occupant.has(n)).length;
    if (occNeighbours <= 1 || occNeighbours >= 4) {
      events.push({
        kind: 'death',
        province: id,
        unit,
        power: unit.power,
        neighbours: occNeighbours,
      });
    } else {
      survivors.push(unit);
    }
  }

  // Births: empty provinces (pre-step) with exactly 3 occupied neighbours.
  const pending: LifeEvent[] = [];
  for (const id of provinceIds) {
    if (occupant.has(id)) continue;
    const neighbours = map.lifeAdjacency[id] ?? [];
    const parents = neighbours.filter((n) => occupant.has(n)).map((n) => occupant.get(n)!);
    if (parents.length !== 3) continue;

    const counts = new Map<Power, number>();
    for (const p of parents) counts.set(p.power, (counts.get(p.power) ?? 0) + 1);
    let owner: Power = 'NEUTRAL';
    for (const [power, count] of counts) {
      if (count >= 2) {
        owner = power;
        break;
      }
    }

    const province = map.provinces[id];
    const type = province?.type;
    let event: LifeEvent;
    if (type === 'sea') {
      const unit: Unit = { power: owner, type: 'F', loc: id };
      event = { kind: 'birth', province: id, unit, power: owner, neighbours: 3, parents };
      survivors.push(unit);
    } else if (type === 'inland') {
      const unit: Unit = { power: owner, type: 'A', loc: id };
      event = { kind: 'birth', province: id, unit, power: owner, neighbours: 3, parents };
      survivors.push(unit);
    } else if (owner === 'NEUTRAL') {
      // A neutral unit never moves and issues no orders, so army-vs-fleet has no
      // gameplay consequence: resolve it as an army rather than asking the GM.
      const unit: Unit = { power: owner, type: 'A', loc: id };
      event = { kind: 'birth', province: id, unit, power: owner, neighbours: 3, parents };
      survivors.push(unit);
    } else {
      // coastal (or unknown, defensively treated as needing a GM choice)
      event = { kind: 'birth', province: id, unit: null, power: owner, neighbours: 3, parents, pending: true };
      pending.push(event);
    }
    events.push(event);
  }

  events.sort((a, b) => a.province.localeCompare(b.province));
  survivors.sort((a, b) => provinceOf(a.loc).localeCompare(provinceOf(b.loc)));

  return { units: survivors, events, pending };
}
