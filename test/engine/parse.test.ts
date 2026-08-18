import { describe, it, expect } from 'vitest';
import { STANDARD_MAP } from '../../src/data/standard-map.js';
import { parseOrders } from '../../src/engine/parse.js';
import type { GameState, PhaseKind, Power, Season, Unit } from '../../src/engine/types.js';

const map = STANDARD_MAP;

function board(
  units: [Power, 'A' | 'F', string][],
  opts: { season?: Season; phase?: PhaseKind; dislodged?: Unit[]; centers?: GameState['centers'] } = {},
): GameState {
  return {
    version: 1,
    year: 1901,
    season: opts.season ?? 'SPRING',
    phase: opts.phase ?? 'MOVEMENT',
    units: units.map(([power, type, loc]) => ({ power, type, loc })),
    centers: opts.centers ?? {},
    ...(opts.dislodged
      ? { dislodged: opts.dislodged.map((unit) => ({ unit, attackerFrom: '', retreatOptions: [] })) }
      : {}),
  };
}

const FRANCE_START = board([
  ['FRANCE', 'A', 'par'],
  ['FRANCE', 'F', 'bre'],
  ['FRANCE', 'A', 'mar'],
]);

function one(text: string, state = FRANCE_START, power?: Power) {
  const r = parseOrders(text, state, map, power);
  expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  expect(r.orders).toHaveLength(1);
  return r.orders[0]!;
}

describe('parseOrders — movement', () => {
  it('accepts the several dash spellings', () => {
    for (const text of ['A Par - Bur', 'A Par-Bur', 'A Par -> Bur', 'a par — bur', 'PAR - BUR']) {
      expect(one(text, FRANCE_START, 'FRANCE')).toMatchObject({ kind: 'move', to: 'bur' });
    }
  });

  it('accepts full province names, including hyphenated and multi-word ones', () => {
    const st = board([['FRANCE', 'F', 'mao']]);
    expect(one('Fleet Mid-Atlantic Ocean - North Africa', st, 'FRANCE')).toMatchObject({
      kind: 'move',
      to: 'naf',
    });
    const st2 = board([['RUSSIA', 'F', 'stp/sc']]);
    expect(one('F St Petersburg (south coast) - Gulf of Bothnia', st2, 'RUSSIA')).toMatchObject({
      to: 'bot',
    });
  });

  it('parses coasts in every notation', () => {
    const st = board([['FRANCE', 'F', 'mao']]);
    for (const text of ['F MAO - Spa/sc', 'F MAO - Spa(sc)', 'F MAO - Spa sc', 'F MAO - Spain (south coast)']) {
      expect(one(text, st, 'FRANCE'), text).toMatchObject({ kind: 'move', to: 'spa/sc' });
    }
  });

  it('infers unit type from the board', () => {
    expect(one('Par - Bur', FRANCE_START, 'FRANCE')).toMatchObject({
      kind: 'move',
      unit: { type: 'A', loc: 'par' },
    });
  });

  it('parses holds, supports, convoys and via-convoy moves', () => {
    const st = board([
      ['FRANCE', 'A', 'par'],
      ['FRANCE', 'F', 'mao'],
      ['ENGLAND', 'F', 'nth'],
      ['ENGLAND', 'A', 'lon'],
    ]);
    expect(one('A Par H', st, 'FRANCE')).toMatchObject({ kind: 'hold' });
    expect(one('A Par holds', st, 'FRANCE')).toMatchObject({ kind: 'hold' });
    expect(one('F MAO S A Par - Bur', st, 'FRANCE')).toMatchObject({
      kind: 'support',
      target: { loc: 'par' },
      to: 'bur',
    });
    expect(one('F MAO S Par - Bur', st, 'FRANCE')).toMatchObject({ kind: 'support', to: 'bur' });
    expect(one('F MAO Supports A Par', st, 'FRANCE')).toEqual({
      kind: 'support',
      unit: { power: 'FRANCE', type: 'F', loc: 'mao' },
      target: { power: 'FRANCE', type: 'A', loc: 'par' },
    });
    expect(one('F NTH C A Lon - Nwy', st, 'ENGLAND')).toMatchObject({
      kind: 'convoy',
      target: { loc: 'lon' },
      to: 'nwy',
    });
    expect(one('A Lon - Nwy VIA', st, 'ENGLAND')).toMatchObject({ kind: 'move', viaConvoy: true });
    expect(one('A Lon - Nwy via convoy', st, 'ENGLAND')).toMatchObject({ viaConvoy: true });
    expect(one('A Lon - Nwy', st, 'ENGLAND')).toEqual({
      kind: 'move',
      unit: { power: 'ENGLAND', type: 'A', loc: 'lon' },
      to: 'nwy',
    });
  });

  it('takes the power from a line prefix, a header line, or the board', () => {
    const st = board([
      ['FRANCE', 'A', 'par'],
      ['GERMANY', 'A', 'mun'],
    ]);
    expect(one('France: A Par - Bur', st)).toMatchObject({ unit: { power: 'FRANCE' } });

    const r = parseOrders('Germany:\nA Mun - Ruh', st, map);
    expect(r.orders[0]).toMatchObject({ unit: { power: 'GERMANY' }, to: 'ruh' });

    // No default and no prefix: infer from whoever is standing there.
    expect(one('A Mun - Ruh', st)).toMatchObject({ unit: { power: 'GERMANY' } });
  });

  it('reports clear errors instead of guessing', () => {
    const st = board([
      ['FRANCE', 'A', 'par'],
      ['NEUTRAL', 'A', 'bur'],
    ]);
    const r = parseOrders(
      ['A Atlantis - Bur', 'A Gas - Bur', 'A Bur - Mun', 'France: A Par S A Ruh - Mun'].join('\n'),
      st,
      map,
      'FRANCE',
    );
    expect(r.orders).toHaveLength(0);
    expect(r.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('unknown province'),
      expect.stringContaining('no unit in GAS'),
      expect.stringContaining('neutral'),
      expect.stringContaining('no unit in RUH'),
    ]);
  });

  it('rejects ordering another power’s unit', () => {
    const st = board([['GERMANY', 'A', 'mun']]);
    const r = parseOrders('A Mun - Ruh', st, map, 'FRANCE');
    expect(r.orders).toHaveLength(0);
    expect(r.errors[0]?.message).toContain('belongs to GERMANY');
  });

  it('skips blank lines and comments', () => {
    const r = parseOrders('\n# nothing\n// nor this\nA Par - Bur\n', FRANCE_START, map, 'FRANCE');
    expect(r.orders).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  it('rejects orders that belong to another phase', () => {
    const r = parseOrders('Build A Par\nWaive', FRANCE_START, map, 'FRANCE');
    expect(r.orders).toHaveLength(0);
    expect(r.errors).toHaveLength(2);
  });
});

describe('parseOrders — one unit, one order', () => {
  const ENGLAND = board([
    ['ENGLAND', 'F', 'lon'],
    ['ENGLAND', 'A', 'lvp'],
  ]);

  it('keeps the last order for a unit and flags the earlier ones', () => {
    const r = parseOrders('F Lon - NTH\nA Lvp - Yor\nF Lon H', ENGLAND, map, 'ENGLAND');
    expect(r.orders).toHaveLength(2);
    expect(r.orders.map((o) => o.kind).sort()).toEqual(['hold', 'move']);
    expect(r.orders.find((o) => 'unit' in o && o.unit.loc === 'lon')).toMatchObject({ kind: 'hold' });

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.kind).toBe('duplicate');
    expect(r.errors[0]?.line).toBe('F Lon H');
    expect(r.errors[0]?.message).toContain('F LON already has an order');
    expect(r.errors[0]?.message).toContain('line 1');
    expect(r.errors[0]?.message).toContain('F Lon - NTH');

    expect(r.duplicates).toEqual([{ loc: 'lon', type: 'F', count: 2 }]);
  });

  it('counts three orders for one unit as one duplicate, last kept', () => {
    const r = parseOrders('F Lon - NTH\nF Lon - ENG\nF Lon H', ENGLAND, map, 'ENGLAND');
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ kind: 'hold' });
    expect(r.errors).toHaveLength(2);
    expect(r.duplicates).toEqual([{ loc: 'lon', type: 'F', count: 3 }]);
  });

  it('treats a coastal spelling as the same unit', () => {
    const st = board([['FRANCE', 'F', 'spa/sc']]);
    const r = parseOrders('F Spa/sc - Mar\nF Spa H', st, map, 'FRANCE');
    expect(r.orders).toHaveLength(1);
    expect(r.duplicates).toEqual([{ loc: 'spa', type: 'F', count: 2 }]);
  });

  it('leaves distinct units alone', () => {
    const r = parseOrders('F Lon - NTH\nA Lvp - Yor', ENGLAND, map, 'ENGLAND');
    expect(r.errors).toEqual([]);
    expect(r.duplicates).toEqual([]);
    expect(r.orders).toHaveLength(2);
  });

  it('flags a doubled retreat order too', () => {
    const st = board([['FRANCE', 'A', 'par']], {
      phase: 'RETREAT',
      dislodged: [{ power: 'FRANCE', type: 'A', loc: 'bur' }],
    });
    const r = parseOrders('A Bur - Gas\nA Bur D', st, map, 'FRANCE');
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ kind: 'disband' });
    expect(r.duplicates).toEqual([{ loc: 'bur', type: 'A', count: 2 }]);
  });

  it('does not dedupe adjustment orders (builds are per province, warned elsewhere)', () => {
    const st = board([], { phase: 'ADJUSTMENT', centers: { FRANCE: ['par', 'mar'] } });
    const r = parseOrders('Build A Par\nBuild A Par', st, map, 'FRANCE');
    expect(r.orders).toHaveLength(2);
    expect(r.duplicates).toEqual([]);
  });
});

describe('parseOrders — retreats and adjustments', () => {
  const retreatState = board([['FRANCE', 'A', 'par']], {
    phase: 'RETREAT',
    dislodged: [{ power: 'FRANCE', type: 'A', loc: 'bur' }],
  });

  it('parses retreats and disbands', () => {
    expect(one('A Bur R Mun', retreatState, 'FRANCE')).toMatchObject({ kind: 'retreat', to: 'mun' });
    expect(one('A Bur retreats to Mun', retreatState, 'FRANCE')).toMatchObject({ to: 'mun' });
    expect(one('A Bur - Mun', retreatState, 'FRANCE')).toMatchObject({ kind: 'retreat', to: 'mun' });
    expect(one('A Bur D', retreatState, 'FRANCE')).toMatchObject({ kind: 'disband' });
    expect(one('A Bur disband', retreatState, 'FRANCE')).toMatchObject({ kind: 'disband' });
  });

  it('rejects retreat orders for units that were not dislodged', () => {
    const r = parseOrders('A Par R Bur', retreatState, map, 'FRANCE');
    expect(r.errors[0]?.message).toContain('no dislodged unit in PAR');
  });

  const buildState = board([['FRANCE', 'A', 'mar']], {
    season: 'WINTER',
    phase: 'ADJUSTMENT',
    centers: { FRANCE: ['par', 'bre', 'mar'] },
  });

  it('parses builds, removals and waives', () => {
    expect(one('Build A Par', buildState, 'FRANCE')).toMatchObject({
      kind: 'build',
      unit: { type: 'A', loc: 'par', power: 'FRANCE' },
    });
    expect(one('A Par B', buildState, 'FRANCE')).toMatchObject({ kind: 'build' });
    expect(one('F Bre B', buildState, 'FRANCE')).toMatchObject({ kind: 'build', unit: { type: 'F' } });
    expect(one('F StP/nc B', buildState, 'RUSSIA')).toMatchObject({
      kind: 'build',
      unit: { type: 'F', loc: 'stp/nc' },
    });
    expect(one('Remove A Mar', buildState, 'FRANCE')).toMatchObject({ kind: 'remove' });
    expect(one('Disband A Mar', buildState, 'FRANCE')).toMatchObject({ kind: 'remove' });
    expect(one('A Mar D', buildState, 'FRANCE')).toMatchObject({ kind: 'remove' });
    expect(one('Waive', buildState, 'FRANCE')).toEqual({ kind: 'waive', power: 'FRANCE' });
  });

  it('infers the building power from centre ownership', () => {
    const r = parseOrders('Build A Par', buildState, map);
    expect(r.orders[0]).toMatchObject({ unit: { power: 'FRANCE' } });
  });
});

describe('parseOrders — spawn decisions', () => {
  // A spawn decision is a build order: the power is fixed by the birth, so the only thing
  // being recorded is which unit type (and, on a split coast, which coast) it becomes.
  function spawnState(births: [Power, string][]): GameState {
    const s = board([['ENGLAND', 'F', 'nth']], { season: 'SUMMER', phase: 'SPAWN_CHOICE' });
    s.pendingBirths = births.map(([power, province]) => ({
      kind: 'birth' as const,
      province,
      unit: null,
      power,
      neighbours: 3,
      pending: true,
    }));
    return s;
  }

  const edi = spawnState([['ENGLAND', 'edi']]);
  const stp = spawnState([['RUSSIA', 'stp']]);

  it('parses a decision as a build order for the birth\'s power', () => {
    expect(one('England: Build F Edi', edi)).toEqual({
      kind: 'build',
      unit: { power: 'ENGLAND', type: 'F', loc: 'edi' },
    });
    expect(one('Build A Edi', edi)).toEqual({
      kind: 'build',
      unit: { power: 'ENGLAND', type: 'A', loc: 'edi' },
    });
    // Bare and suffix forms mean the same thing.
    expect(one('F Edi', edi)).toMatchObject({ kind: 'build', unit: { type: 'F' } });
    expect(one('A Edi B', edi)).toMatchObject({ kind: 'build', unit: { type: 'A' } });
  });

  it('takes a coast on a split-coast birth, and requires one for a fleet', () => {
    expect(one('Build F Stp/nc', stp)).toEqual({
      kind: 'build',
      unit: { power: 'RUSSIA', type: 'F', loc: 'stp/nc' },
    });
    expect(one('Build A Stp', stp)).toEqual({
      kind: 'build',
      unit: { power: 'RUSSIA', type: 'A', loc: 'stp' },
    });
    expect(parseOrders('Build F Stp', stp, map).errors[0]?.message).toContain('needs a coast');
    expect(parseOrders('Build A Stp/nc', stp, map).errors[0]?.message).toContain('no coast');
  });

  it('rejects provinces with no pending birth, and the wrong power', () => {
    expect(parseOrders('Build A Lon', edi, map).errors[0]?.message).toContain('no birth is waiting');
    expect(parseOrders('France: Build A Edi', edi, map).errors[0]?.message).toContain('belongs to ENGLAND');
  });

  it('insists on a unit type, and rejects orders that are not decisions', () => {
    expect(parseOrders('Build Edi', edi, map).errors[0]?.message).toContain('say which');
    expect(parseOrders('F Nth - Edi', edi, map).errors[0]?.message).toContain('not a spawn decision');
    expect(parseOrders('Waive', edi, map, 'ENGLAND').errors[0]?.message).toContain('adjustment phase');
  });

  it('flags a province decided twice and keeps the last', () => {
    const r = parseOrders('Build A Edi\nBuild F Edi', edi, map);
    expect(r.orders).toEqual([{ kind: 'build', unit: { power: 'ENGLAND', type: 'F', loc: 'edi' } }]);
    expect(r.duplicates).toEqual([{ loc: 'edi', type: 'F', count: 2 }]);
  });
});

// Split coasts (Spa, Bul, StP), one case per order kind. The rule of the road is
// that only a *fleet's own destination* is coast-sensitive: supports name the
// destination province, armies never name a coast at all, and a coast the writer
// left off is inferred when only one is reachable. Where the coast really is
// missing or wrong, the line still parses — the order is kept so the adjudicator
// can void it in the report — but it comes back with a 'coast' error attached.
describe('parseOrders — split coasts', () => {
  const spain = board([
    ['FRANCE', 'F', 'mao'],
    ['FRANCE', 'F', 'lyo'],
    ['FRANCE', 'F', 'gas'],
    ['FRANCE', 'A', 'mar'],
    ['FRANCE', 'F', 'spa/sc'],
  ]);

  function coastErrors(text: string, st = spain, power: Power = 'FRANCE') {
    const r = parseOrders(text, st, map, power);
    expect(r.errors.filter((e) => e.kind !== 'coast')).toEqual([]);
    return r.errors.filter((e) => e.kind === 'coast').map((e) => e.message);
  }

  it('takes a fleet move that names a reachable coast', () => {
    expect(one('F MAO - Spa/nc', spain, 'FRANCE')).toMatchObject({ kind: 'move', to: 'spa/nc' });
    expect(one('F MAO - Spa/sc', spain, 'FRANCE')).toMatchObject({ kind: 'move', to: 'spa/sc' });
  });

  it('asks which coast when a fleet move leaves off an ambiguous one', () => {
    const r = parseOrders('F MAO - Spa', spain, map, 'FRANCE');
    expect(r.orders).toEqual([
      { kind: 'move', unit: { power: 'FRANCE', type: 'F', loc: 'mao' }, to: 'spa' },
    ]);
    expect(r.errors).toEqual([
      { line: 'F MAO - Spa', kind: 'coast', message: 'which coast? write SPA/NC or SPA/SC' },
    ]);
  });

  it('lets a fleet leave the coast off when only one is reachable', () => {
    expect(coastErrors('F LYO - Spa')).toEqual([]);
    expect(one('F LYO - Spa', spain, 'FRANCE')).toMatchObject({ kind: 'move', to: 'spa' });
    const russia = board([['RUSSIA', 'F', 'bar']]);
    expect(coastErrors('F Bar - StP', russia, 'RUSSIA')).toEqual([]);
  });

  it('says so when a fleet names a coast it does not border', () => {
    expect(coastErrors('F LYO - Spa/nc')).toEqual(['LYO does not border SPA/NC — only SPA/SC']);
  });

  it('drops the coast from an army move, named or not', () => {
    expect(one('A Mar - Spa', spain, 'FRANCE')).toMatchObject({ kind: 'move', to: 'spa' });
    expect(one('A Mar - Spa/sc', spain, 'FRANCE')).toMatchObject({ kind: 'move', to: 'spa' });
    expect(coastErrors('A Mar - Spa/sc')).toEqual([]);
    expect(coastErrors('A Mar - Spa/nc')).toEqual([]);
  });

  it('supports a move to a split coast with or without the coast', () => {
    expect(one('F MAO S F Gas - Spa', spain, 'FRANCE')).toMatchObject({
      kind: 'support',
      target: { loc: 'gas' },
      to: 'spa',
    });
    expect(one('F MAO S F Gas - Spa/nc', spain, 'FRANCE')).toMatchObject({ to: 'spa/nc' });
    expect(coastErrors('F MAO S F Gas - Spa')).toEqual([]);
    expect(coastErrors('F MAO S F Gas - Spa/nc')).toEqual([]);
  });

  it('supports a fleet sitting on a coast, coast written or not', () => {
    for (const text of ['F MAO S F Spa', 'F MAO S F Spa/sc', 'F MAO S Spa']) {
      expect(one(text, spain, 'FRANCE'), text).toEqual({
        kind: 'support',
        unit: { power: 'FRANCE', type: 'F', loc: 'mao' },
        target: { power: 'FRANCE', type: 'F', loc: 'spa/sc' },
      });
    }
  });

  it('handles Bulgaria the same way, including a convoy that names no coast', () => {
    const east = board([
      ['TURKEY', 'F', 'bla'],
      ['TURKEY', 'F', 'aeg'],
      ['TURKEY', 'A', 'con'],
      ['TURKEY', 'F', 'bul/sc'],
    ]);
    expect(coastErrors('F Bla - Bul', east, 'TURKEY')).toEqual([]); // only /ec from Bla
    expect(one('F Bla - Bul', east, 'TURKEY')).toMatchObject({ to: 'bul' });
    expect(coastErrors('F Aeg - Bul/ec', east, 'TURKEY')).toEqual([
      'AEG does not border BUL/EC — only BUL/SC',
    ]);
    expect(one('A Con - Bul', east, 'TURKEY')).toMatchObject({ kind: 'move', to: 'bul' });
    expect(one('F Aeg S A Con - Bul', east, 'TURKEY')).toMatchObject({ kind: 'support', to: 'bul' });
    expect(one('F Bla C A Con - Bul', east, 'TURKEY')).toMatchObject({ kind: 'convoy', to: 'bul' });
  });

  it('asks which coast a dislodged fleet retreats to', () => {
    const st: GameState = {
      version: 1,
      year: 1901,
      season: 'SPRING',
      phase: 'RETREAT',
      units: [],
      centers: {},
      dislodged: [
        {
          unit: { power: 'FRANCE', type: 'F', loc: 'mao' },
          attackerFrom: 'iri',
          retreatOptions: ['spa/nc', 'spa/sc', 'por'],
        },
      ],
    };
    expect(coastErrors('F MAO - Spa', st)).toEqual(['which coast? write SPA/NC or SPA/SC']);
    expect(one('F MAO - Spa/nc', st, 'FRANCE')).toMatchObject({ kind: 'retreat', to: 'spa/nc' });
    expect(coastErrors('F MAO R Spa/sc', st)).toEqual([]);
    expect(coastErrors('F MAO R Por', st)).toEqual([]);

    const one_way: GameState = {
      ...st,
      dislodged: [
        {
          unit: { power: 'FRANCE', type: 'F', loc: 'mao' },
          attackerFrom: 'iri',
          retreatOptions: ['spa/nc', 'por'],
        },
      ],
    };
    expect(coastErrors('F MAO R Spa', one_way)).toEqual([]);
    expect(coastErrors('F MAO R Spa/sc', one_way)).toEqual([
      'SPA/SC is not a legal retreat — only SPA/NC',
    ]);
  });

  it('wants a coast on a fleet build, and none on an army build', () => {
    const st = board([], {
      season: 'WINTER',
      phase: 'ADJUSTMENT',
      centers: { RUSSIA: ['stp', 'mos'], FRANCE: ['spa', 'mar'] },
    });
    expect(one('Build F StP/nc', st, 'RUSSIA')).toMatchObject({
      kind: 'build',
      unit: { type: 'F', loc: 'stp/nc' },
    });
    expect(coastErrors('Build F StP/nc', st, 'RUSSIA')).toEqual([]);
    expect(coastErrors('Build F StP', st, 'RUSSIA')).toEqual([
      'a fleet in STP needs a coast: STP/NC or STP/SC',
    ]);
    expect(coastErrors('F StP B', st, 'RUSSIA')).toEqual([
      'a fleet in STP needs a coast: STP/NC or STP/SC',
    ]);
    expect(coastErrors('Build A StP', st, 'RUSSIA')).toEqual([]);
    expect(coastErrors('Build A StP/nc', st, 'RUSSIA')).toEqual(['an army in STP has no coast']);
    expect(coastErrors('Build F Spa/sc', st, 'FRANCE')).toEqual([]);
    expect(coastErrors('Build F Mar', st, 'FRANCE')).toEqual([]); // Marseilles has one coast
  });
});
