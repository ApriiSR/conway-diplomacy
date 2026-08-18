import { describe, it, expect } from 'vitest';
import { STANDARD_MAP } from '../../src/data/standard-map.js';
import { parseOrders } from '../../src/engine/parse.js';
import {
  resolveAdjustments,
  resolveMovement,
  resolveRetreats,
} from '../../src/engine/resolve.js';
import type { GameState, Order, OrderResult, PhaseKind, Power, Season } from '../../src/engine/types.js';

const map = STANDARD_MAP;

type UnitSpec = [Power, 'A' | 'F', string];

function board(
  units: UnitSpec[],
  opts: { season?: Season; phase?: PhaseKind; centers?: GameState['centers'] } = {},
): GameState {
  return {
    version: 1,
    year: 1901,
    season: opts.season ?? 'SPRING',
    phase: opts.phase ?? 'MOVEMENT',
    units: units.map(([power, type, loc]) => ({ power, type, loc })),
    centers: opts.centers ?? {},
  };
}

function orders(state: GameState, byPower: Partial<Record<Power, string[]>>): Order[] {
  const out: Order[] = [];
  for (const [power, lines] of Object.entries(byPower)) {
    const r = parseOrders((lines ?? []).join('\n'), state, map, power as Power);
    // 'coast' errors are warnings on orders the parser still hands over — several
    // cases here feed exactly those in, to check the adjudicator voids them.
    const hard = r.errors.filter((e) => e.kind !== 'coast');
    expect(hard, JSON.stringify(hard)).toEqual([]);
    out.push(...r.orders);
  }
  return out;
}

function resultsFor(
  results: { order: Order; result: OrderResult }[],
  loc: string,
): OrderResult[] {
  return results
    .filter((r) => r.order.kind !== 'waive' && r.order.unit.loc.split('/')[0] === loc)
    .map((r) => r.result);
}

function occupant(state: GameState, loc: string): Power | undefined {
  return state.units.find((u) => u.loc.split('/')[0] === loc)?.power;
}

describe('resolveMovement — neutral units', () => {
  it('treats neutral units as holding and lets others support-hold them', () => {
    const st = board([
      ['NEUTRAL', 'A', 'bur'],
      ['FRANCE', 'A', 'par'],
      ['GERMANY', 'A', 'mun'],
      ['GERMANY', 'A', 'ruh'],
    ]);
    const os = orders(st, {
      FRANCE: ['A Par S A Bur'],
      GERMANY: ['A Mun - Bur', 'A Ruh S A Mun - Bur'],
    });
    const r = resolveMovement(st, os, map);
    // 2 attackers vs 1 + 1 support-hold: bounce, neutral survives.
    expect(resultsFor(r.results, 'mun')).toEqual(['bounce']);
    expect(r.dislodged).toEqual([]);
    expect(occupant(r.next, 'bur')).toBe('NEUTRAL');
  });

  it('dislodges a neutral like anyone else, and it disbands for want of an order', () => {
    const st = board([
      ['NEUTRAL', 'A', 'bur'],
      ['GERMANY', 'A', 'mun'],
      ['GERMANY', 'A', 'ruh'],
    ]);
    const os = orders(st, { GERMANY: ['A Mun - Bur', 'A Ruh S A Mun - Bur'] });
    const r = resolveMovement(st, os, map);
    expect(r.dislodged).toHaveLength(1);
    expect(r.dislodged[0]?.unit).toMatchObject({ power: 'NEUTRAL', loc: 'bur' });
    // A retreat phase happens even though only a neutral was dislodged.
    expect(r.next.phase).toBe('RETREAT');
    expect(occupant(r.next, 'bur')).toBe('GERMANY');

    // Nobody can order it, so the retreat phase disbands it.
    const after = resolveRetreats(r.next, [], map);
    expect(after.next.units.some((u) => u.power === 'NEUTRAL')).toBe(false);
    expect(after.results.some((x) => x.result === 'disband')).toBe(true);
  });

  it('rejects orders written for a neutral unit', () => {
    const st = board([['NEUTRAL', 'A', 'bur']]);
    const p = parseOrders('A Bur - Mun', st, map, 'NEUTRAL');
    expect(p.orders).toEqual([]);
    expect(p.errors[0]?.message).toContain('neutral');
  });
});

describe('resolveMovement — bookkeeping', () => {
  it('records a legal but unsupported bounce and leaves both units in place', () => {
    const st = board([
      ['FRANCE', 'A', 'par'],
      ['GERMANY', 'A', 'mun'],
    ]);
    const r = resolveMovement(st, orders(st, { FRANCE: ['A Par - Bur'], GERMANY: ['A Mun - Bur'] }), map);
    expect(resultsFor(r.results, 'par')).toEqual(['bounce']);
    expect(resultsFor(r.results, 'mun')).toEqual(['bounce']);
    expect(occupant(r.next, 'bur')).toBeUndefined();
  });

  it('voids an order for a unit that is not on the board', () => {
    const st = board([['FRANCE', 'A', 'par']]);
    const stray: Order = {
      kind: 'move',
      unit: { power: 'FRANCE', type: 'A', loc: 'gas' },
      to: 'bur',
    };
    const r = resolveMovement(st, [stray], map);
    expect(resultsFor(r.results, 'gas')).toEqual(['void']);
  });

  it('offers legal retreat options and excludes the attacker’s origin and stand-offs', () => {
    const st = board([
      ['GERMANY', 'A', 'mun'],
      ['GERMANY', 'A', 'ruh'],
      ['FRANCE', 'A', 'bur'],
      ['FRANCE', 'A', 'gas'],
      ['ITALY', 'A', 'pic'],
    ]);
    // Munich (supported by Ruhr) takes Burgundy; Gascony and Picardy stand each
    // other off in Paris, so Burgundy may not retreat there either.
    const os = orders(st, {
      GERMANY: ['A Mun - Bur', 'A Ruh S A Mun - Bur'],
      FRANCE: ['A Bur H', 'A Gas - Par'],
      ITALY: ['A Pic - Par'],
    });
    const r = resolveMovement(st, os, map);
    const d = r.dislodged.find((x) => x.unit.loc === 'bur');
    expect(d?.attackerFrom).toBe('mun');
    expect(d?.retreatOptions).not.toContain('mun'); // attacker's origin
    expect(d?.retreatOptions).not.toContain('ruh'); // occupied
    expect(d?.retreatOptions).not.toContain('gas'); // occupied (Gascony bounced)
    expect(d?.retreatOptions).not.toContain('par'); // stand-off
    expect(d?.retreatOptions).toEqual(['bel', 'mar']); // pic is still occupied
    expect(r.next.phase).toBe('RETREAT');
  });

  it('captures supply centres after a Fall movement with no retreats', () => {
    const st = board([['GERMANY', 'A', 'ruh']], {
      season: 'FALL',
      centers: { FRANCE: ['bel', 'par'], GERMANY: ['mun'] },
    });
    const r = resolveMovement(st, orders(st, { GERMANY: ['A Ruh - Bel'] }), map);
    expect(r.next.centers['GERMANY']).toContain('bel');
    expect(r.next.centers['FRANCE']).toEqual(['par']);
    expect(r.next.season).toBe('WINTER');
    expect(r.next.phase).toBe('ADJUSTMENT');
  });

  it('does not hand supply centres to NEUTRAL', () => {
    const st = board([['NEUTRAL', 'A', 'bel']], { season: 'FALL', centers: { FRANCE: ['bel'] } });
    const r = resolveMovement(st, [], map);
    expect(r.next.centers['FRANCE']).toEqual(['bel']);
    expect(r.next.centers['NEUTRAL']).toBeUndefined();
  });

  it('leaves Spring movement pointing at Fall when nothing was dislodged', () => {
    const st = board([['FRANCE', 'A', 'par']]);
    const r = resolveMovement(st, orders(st, { FRANCE: ['A Par - Bur'] }), map);
    expect(r.next.season).toBe('FALL');
    expect(r.next.phase).toBe('MOVEMENT');
  });
});

describe('resolveRetreats', () => {
  function dislodgeBurgundy(): GameState {
    const st = board([
      ['GERMANY', 'A', 'mun'],
      ['GERMANY', 'A', 'ruh'],
      ['FRANCE', 'A', 'bur'],
    ]);
    return resolveMovement(
      st,
      orders(st, { GERMANY: ['A Mun - Bur', 'A Ruh S A Mun - Bur'], FRANCE: ['A Bur H'] }),
      map,
    ).next;
  }

  it('moves a unit that retreats legally', () => {
    const st = dislodgeBurgundy();
    const r = resolveRetreats(st, orders(st, { FRANCE: ['A Bur R Par'] }), map);
    expect(occupant(r.next, 'par')).toBe('FRANCE');
    expect(r.next.dislodged).toBeUndefined();
  });

  it('disbands on an illegal retreat and on no order at all', () => {
    const st = dislodgeBurgundy();
    const bad = resolveRetreats(st, orders(st, { FRANCE: ['A Bur R Mun'] }), map);
    expect(resultsFor(bad.results, 'bur')).toEqual(['void', 'disband']);
    expect(bad.next.units.some((u) => u.power === 'FRANCE')).toBe(false);

    const none = resolveRetreats(st, [], map);
    expect(resultsFor(none.results, 'bur')).toEqual(['disband']);
  });
});

describe('resolveAdjustments', () => {
  const centers = { FRANCE: ['par', 'bre', 'mar', 'bel', 'spa'] };

  it('builds in empty owned home centres only', () => {
    const st = board([['FRANCE', 'A', 'mar']], { season: 'WINTER', phase: 'ADJUSTMENT', centers });
    const os = orders(st, { FRANCE: ['A Par B', 'F Bre B', 'A Mar B', 'A Bel B'] });
    const r = resolveAdjustments(st, os, map);
    expect(resultsFor(r.results, 'par')).toEqual(['ok']);
    expect(resultsFor(r.results, 'bre')).toEqual(['ok']);
    expect(resultsFor(r.results, 'mar')).toEqual(['void']); // occupied
    expect(resultsFor(r.results, 'bel')).toEqual(['void']); // not a French home centre
    expect(r.next.units).toHaveLength(3);
    expect(r.next.year).toBe(1902);
    expect(r.next.season).toBe('SPRING');
  });

  it('voids builds beyond the number of spare centres', () => {
    const st = board([['FRANCE', 'A', 'mar'], ['FRANCE', 'A', 'bel'], ['FRANCE', 'A', 'spa'], ['FRANCE', 'F', 'bre']], {
      season: 'WINTER',
      phase: 'ADJUSTMENT',
      centers,
    });
    const os = orders(st, { FRANCE: ['A Par B'] });
    const r = resolveAdjustments(st, os, map);
    expect(resultsFor(r.results, 'par')).toEqual(['ok']);

    const os2 = orders(st, { FRANCE: ['A Par B'] });
    const tooMany = resolveAdjustments(
      { ...st, units: [...st.units, { power: 'FRANCE', type: 'A', loc: 'gas' }] },
      os2,
      map,
    );
    expect(resultsFor(tooMany.results, 'par')).toEqual(['void']);
  });

  it('refuses a fleet on an inland centre and requires a coast where it matters', () => {
    const st = board([], {
      season: 'WINTER',
      phase: 'ADJUSTMENT',
      centers: { RUSSIA: ['mos', 'war', 'sev', 'stp'] },
    });
    const os = orders(st, { RUSSIA: ['F Mos B', 'F StP B', 'F StP/nc B'] });
    const r = resolveAdjustments(st, os, map);
    expect(resultsFor(r.results, 'mos')).toEqual(['void']);
    expect(resultsFor(r.results, 'stp')).toEqual(['void', 'ok']);
  });

  it('auto-removes the unit furthest from home when too few disbands are ordered', () => {
    const st = board([
      ['RUSSIA', 'A', 'lvn'],
      ['RUSSIA', 'A', 'swe'],
    ], { season: 'WINTER', phase: 'ADJUSTMENT', centers: { RUSSIA: ['swe'] } });
    const r = resolveAdjustments(st, [], map);
    expect(r.next.units.map((u) => u.loc)).toEqual(['lvn']);
    expect(resultsFor(r.results, 'swe')).toEqual(['disband']);
  });
});
