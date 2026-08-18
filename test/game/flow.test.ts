import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameState, MapData, Order, Province, ProvinceType } from '../../src/engine/types';

// Stub the engine resolvers: flow.ts owns the phase/season/year transitions itself
// (see the note at the top of src/game/flow.ts), so these stubs just need to hand
// back units/centers unchanged and report no dislodgements unless a test overrides them.
const resolveMovement = vi.fn();
const resolveRetreats = vi.fn();
const resolveAdjustments = vi.fn();

vi.mock('../../src/engine/resolve', () => ({
  resolveMovement: (...args: unknown[]) => resolveMovement(...args),
  resolveRetreats: (...args: unknown[]) => resolveRetreats(...args),
  resolveAdjustments: (...args: unknown[]) => resolveAdjustments(...args),
}));

const { advance, initialState, lifeStepLabel, nextPhaseLabel, resolveSpawnChoices } =
  await import('../../src/game/flow');

function mkProvince(id: string, type: ProvinceType, coasts: string[] = []): Province {
  return { id, name: id, type, sc: false, home: null, coasts, armyAdj: [], fleetAdj: {} };
}

// K4 graph: a, b, c occupied (2 FRANCE, 1 GERMANY); x is empty & coastal, adjacent to
// all three -> exactly 3 occupied neighbours -> pending FRANCE birth (majority parent).
// a, b, c each see exactly 2 occupied neighbours (the other two) -> all survive.
function mkMap(): MapData {
  const provinces = [mkProvince('x', 'coastal'), mkProvince('a', 'inland'), mkProvince('b', 'inland'), mkProvince('c', 'inland')];
  const provinceMap: Record<string, Province> = {};
  for (const p of provinces) provinceMap[p.id] = p;
  return {
    provinces: provinceMap,
    lifeAdjacency: { x: ['a', 'b', 'c'], a: ['b', 'c', 'x'], b: ['a', 'c', 'x'], c: ['a', 'b', 'x'] },
    startingUnits: [
      { power: 'FRANCE', type: 'A', loc: 'a' },
      { power: 'FRANCE', type: 'A', loc: 'b' },
      { power: 'GERMANY', type: 'A', loc: 'c' },
    ],
    startingCenters: { FRANCE: ['a', 'b'], GERMANY: ['c'] },
  };
}

function passThrough(state: GameState) {
  return { results: [], dislodged: [], next: { ...state } };
}

beforeEach(() => {
  resolveMovement.mockReset();
  resolveRetreats.mockReset();
  resolveAdjustments.mockReset();
});

describe('initialState', () => {
  it('starts at Spring 1901 Movement with the map startingUnits/Centers', () => {
    const map = mkMap();
    const state = initialState(map);
    expect(state).toEqual({
      version: 1,
      year: 1901,
      season: 'SPRING',
      phase: 'MOVEMENT',
      units: map.startingUnits,
      centers: map.startingCenters,
    });
    expect(state.variant).toBeUndefined();
  });

  it('accepts an explicit variant', () => {
    const map = mkMap();
    expect(initialState(map, 'standard').variant).toBe('standard');
    expect(initialState(map, 'conway').variant).toBe('conway');
  });
});

describe('advance()', () => {
  it('goes to RETREAT (no life step yet) when movement dislodges a unit', () => {
    const map = mkMap();
    const state = initialState(map);
    const dislodged = [{ unit: state.units[0]!, attackerFrom: 'z', retreatOptions: [] }];
    resolveMovement.mockReturnValue({ results: [], dislodged, next: { ...state } });

    const record = advance(state, [] as Order[], map);
    expect(record.after.phase).toBe('RETREAT');
    expect(record.after.season).toBe('SPRING');
    expect(record.after.dislodged).toEqual(dislodged);
    expect(record.life).toBeUndefined();
  });

  it('runs Life after Spring movement with nothing dislodged, and enters SPAWN_CHOICE on a pending birth', () => {
    const map = mkMap();
    const state = initialState(map);
    resolveMovement.mockReturnValue(passThrough(state));

    const record = advance(state, [] as Order[], map);
    expect(record.life).toBeDefined();
    expect(record.after.phase).toBe('SPAWN_CHOICE');
    // The post-Spring Life step happens in Summer, and so does the wait for spawn choices.
    expect(record.after.season).toBe('SUMMER');
    expect(record.after.year).toBe(1901);
    expect(record.after.pendingBirths).toHaveLength(1);
    expect(record.after.pendingBirths?.[0]?.province).toBe('x');
    expect(record.after.pendingBirths?.[0]?.power).toBe('FRANCE');
    // a, b, c all survive; the pending birth at x is excluded from `units` until resolved.
    expect(record.after.units.map((u) => u.loc).sort()).toEqual(['a', 'b', 'c']);
  });

  // The history draws a Life step on the board it acted on, so the record has to keep
  // that board: `after` no longer has the units that died on it.
  it('records the pre-Life board alongside the Life result', () => {
    const map = mkMap();
    const lonely: GameState = { ...initialState(map), units: [{ power: 'FRANCE', type: 'A', loc: 'a' }] };
    resolveMovement.mockReturnValue(passThrough(lonely));

    const record = advance(lonely, [] as Order[], map);
    expect(record.preLifeUnits?.map((u) => u.loc)).toEqual(['a']);
    expect(record.after.units).toEqual([]);
  });

  it('records the pre-Life board for the Winter step too', () => {
    const map = mkMap();
    const state: GameState = {
      ...initialState(map),
      season: 'WINTER',
      phase: 'ADJUSTMENT',
      units: [{ power: 'FRANCE', type: 'A', loc: 'a' }],
    };
    resolveAdjustments.mockReturnValue({ results: [], next: { ...state } });

    const record = advance(state, [] as Order[], map);
    expect(record.preLifeUnits?.map((u) => u.loc)).toEqual(['a']);
  });

  it('skips RETREAT and does not run Life after Fall movement with nothing dislodged', () => {
    const map = mkMap();
    const state: GameState = { ...initialState(map), season: 'FALL' };
    resolveMovement.mockReturnValue(passThrough(state));

    const record = advance(state, [] as Order[], map);
    expect(record.life).toBeUndefined();
    expect(record.after.phase).toBe('ADJUSTMENT');
    expect(record.after.season).toBe('WINTER');
    expect(record.after.year).toBe(1901);
  });

  it('runs Life after RETREAT resolves in Spring', () => {
    const map = mkMap();
    const state: GameState = {
      ...initialState(map),
      phase: 'RETREAT',
      dislodged: [{ unit: map.startingUnits[0]!, attackerFrom: 'z', retreatOptions: ['a'] }],
    };
    resolveRetreats.mockReturnValue({ results: [], next: { ...state, dislodged: undefined } });

    const record = advance(state, [] as Order[], map);
    expect(record.life).toBeDefined();
    expect(record.after.phase).toBe('SPAWN_CHOICE');
    expect(record.after.season).toBe('SUMMER');
    expect(record.after.dislodged).toBeUndefined();
  });

  it('runs Life after Winter ADJUSTMENT and rolls to next year Spring when nothing pending', () => {
    const map = mkMap();
    // Give x a resident unit so the birth already resolved; no pending births this time.
    const state: GameState = {
      version: 1,
      year: 1901,
      season: 'WINTER',
      phase: 'ADJUSTMENT',
      units: [...map.startingUnits, { power: 'FRANCE', type: 'A', loc: 'x' }],
      centers: map.startingCenters,
    };
    resolveAdjustments.mockReturnValue(passThrough(state));

    const record = advance(state, [] as Order[], map);
    expect(record.life).toBeDefined();
    expect(record.after.phase).toBe('MOVEMENT');
    expect(record.after.season).toBe('SPRING');
    expect(record.after.year).toBe(1902);
    expect(record.after.units.map((u) => u.loc).sort()).toEqual(['a', 'b', 'c', 'x']);
  });

  it('keeps the Winter Life step in Winter when it leaves a birth pending', () => {
    const map = mkMap();
    const state: GameState = { ...initialState(map), season: 'WINTER', phase: 'ADJUSTMENT' };
    resolveAdjustments.mockReturnValue(passThrough(state));

    const record = advance(state, [] as Order[], map);
    expect(record.after.phase).toBe('SPAWN_CHOICE');
    expect(record.after.season).toBe('WINTER');
    expect(record.after.year).toBe(1901);
  });

  it('throws if called during SPAWN_CHOICE', () => {
    const map = mkMap();
    const state: GameState = { ...initialState(map), phase: 'SPAWN_CHOICE', pendingBirths: [] };
    expect(() => advance(state, [] as Order[], map)).toThrow(/SPAWN_CHOICE/);
  });
});

describe('resolveSpawnChoices()', () => {
  function spawnState(): GameState {
    return {
      version: 1,
      year: 1901,
      season: 'SUMMER',
      phase: 'SPAWN_CHOICE',
      units: [
        { power: 'FRANCE', type: 'A', loc: 'a' },
        { power: 'FRANCE', type: 'A', loc: 'b' },
        { power: 'GERMANY', type: 'A', loc: 'c' },
      ],
      centers: { FRANCE: ['a', 'b'], GERMANY: ['c'] },
      pendingBirths: [
        {
          kind: 'birth',
          province: 'x',
          unit: null,
          power: 'FRANCE',
          neighbours: 3,
          parents: [
            { power: 'FRANCE', type: 'A', loc: 'a' },
            { power: 'FRANCE', type: 'A', loc: 'b' },
            { power: 'GERMANY', type: 'A', loc: 'c' },
          ],
          pending: true,
        },
      ],
    };
  }

  it('places the chosen unit and advances Summer -> Fall Movement', () => {
    const map = mkMap();
    const state = spawnState();
    const record = resolveSpawnChoices(state, [{ province: 'x', type: 'A' }], map);
    const next = record.after;
    expect(next.phase).toBe('MOVEMENT');
    expect(next.season).toBe('FALL');
    expect(next.year).toBe(1901);
    expect(next.units).toContainEqual({ power: 'FRANCE', type: 'A', loc: 'x' });
    expect(next.pendingBirths).toBeUndefined();
    expect(record.before).toEqual(state);
    expect(record.life?.pending).toEqual([]);
    expect(record.life?.events).toContainEqual(
      expect.objectContaining({ kind: 'birth', province: 'x', pending: false, unit: { power: 'FRANCE', type: 'A', loc: 'x' } }),
    );
  });

  it('records each choice as a build order with an ok result', () => {
    const map = mkMap();
    map.provinces['x'] = mkProvince('x', 'coastal', ['nc', 'sc']);
    const record = resolveSpawnChoices(spawnState(), [{ province: 'x', type: 'F', coast: 'sc' }], map);
    const unit = { power: 'FRANCE', type: 'F', loc: 'x/sc' };
    expect(record.orders).toEqual([{ kind: 'build', unit }]);
    expect(record.results).toEqual([{ order: { kind: 'build', unit }, result: 'ok' }]);
  });

  it('advances Winter -> next year Spring Movement', () => {
    const map = mkMap();
    const state: GameState = { ...spawnState(), season: 'WINTER' };
    const next = resolveSpawnChoices(state, [{ province: 'x', type: 'A' }], map).after;
    expect(next.season).toBe('SPRING');
    expect(next.year).toBe(1902);
  });

  it('requires a valid coast when choosing a fleet on a split-coast province', () => {
    const map = mkMap();
    map.provinces['x'] = mkProvince('x', 'coastal', ['nc', 'sc']);
    const state = spawnState();

    expect(() => resolveSpawnChoices(state, [{ province: 'x', type: 'F' }], map)).toThrow(/coast/);

    const next = resolveSpawnChoices(state, [{ province: 'x', type: 'F', coast: 'nc' }], map).after;
    expect(next.units).toContainEqual({ power: 'FRANCE', type: 'F', loc: 'x/nc' });
  });

  it('rejects a coast for an army', () => {
    const map = mkMap();
    const state = spawnState();
    expect(() => resolveSpawnChoices(state, [{ province: 'x', type: 'A', coast: 'nc' }], map)).toThrow();
  });

  it('defaults a birth nobody chose for to an army, and says so in the results', () => {
    const map = mkMap();
    const record = resolveSpawnChoices(spawnState(), [], map);
    const unit = { power: 'FRANCE', type: 'A', loc: 'x' };
    expect(record.after.units).toContainEqual(unit);
    expect(record.orders).toEqual([{ kind: 'build', unit }]);
    expect(record.results).toEqual([
      { order: { kind: 'build', unit }, result: 'ok', note: 'defaulted, no order given' },
    ]);
    expect(record.after.phase).toBe('MOVEMENT');
  });

  it('defaults a split-coast birth to an army too — no coast to guess', () => {
    const map = mkMap();
    map.provinces['x'] = mkProvince('x', 'coastal', ['nc', 'sc']);
    const next = resolveSpawnChoices(spawnState(), [], map).after;
    expect(next.units).toContainEqual({ power: 'FRANCE', type: 'A', loc: 'x' });
  });

  it('still rejects a choice for a province with no pending birth', () => {
    const map = mkMap();
    expect(() => resolveSpawnChoices(spawnState(), [{ province: 'a', type: 'A' }], map)).toThrow(
      /no pending birth/,
    );
  });

  it('marks only the defaulted births, not the chosen ones', () => {
    const map = mkMap();
    map.provinces['y'] = mkProvince('y', 'coastal');
    const state = spawnState();
    state.pendingBirths = [
      ...state.pendingBirths!,
      { kind: 'birth', province: 'y', unit: null, power: 'GERMANY', neighbours: 3, pending: true },
    ];
    const record = resolveSpawnChoices(state, [{ province: 'y', type: 'F' }], map);
    expect(record.results.map((r) => [r.order.kind === 'build' ? r.order.unit.loc : '', r.note])).toEqual([
      ['x', 'defaulted, no order given'],
      ['y', undefined],
    ]);
  });
});

describe('standard variant (variant: "standard")', () => {
  it('never runs Life / never enters SPAWN_CHOICE: Spring movement (no dislodge) goes straight to Fall movement', () => {
    const map = mkMap(); // same board that, under Conway rules, would birth a pending unit at x
    const state = initialState(map, 'standard');
    resolveMovement.mockReturnValue(passThrough(state));

    const record = advance(state, [] as Order[], map);
    expect(record.life).toBeUndefined();
    expect(record.after.phase).toBe('MOVEMENT');
    expect(record.after.season).toBe('FALL');
    expect(record.after.year).toBe(1901);
    expect(record.after.pendingBirths).toBeUndefined();
    // No Life step means x never births -> units are exactly what movement resolved to.
    expect(record.after.units.map((u) => u.loc).sort()).toEqual(['a', 'b', 'c']);
    expect(record.after.variant).toBe('standard');
  });

  it('never runs Life after Fall movement or after Winter adjustments either', () => {
    const map = mkMap();
    const fallState: GameState = { ...initialState(map, 'standard'), season: 'FALL' };
    resolveMovement.mockReturnValue(passThrough(fallState));
    const fallRecord = advance(fallState, [] as Order[], map);
    expect(fallRecord.life).toBeUndefined();
    expect(fallRecord.after.phase).toBe('ADJUSTMENT');
    expect(fallRecord.after.season).toBe('WINTER');

    const winterState: GameState = { ...initialState(map, 'standard'), season: 'WINTER', phase: 'ADJUSTMENT' };
    resolveAdjustments.mockReturnValue(passThrough(winterState));
    const winterRecord = advance(winterState, [] as Order[], map);
    expect(winterRecord.life).toBeUndefined();
    expect(winterRecord.after.phase).toBe('MOVEMENT');
    expect(winterRecord.after.season).toBe('SPRING');
    expect(winterRecord.after.year).toBe(1902);
    expect(winterRecord.after.pendingBirths).toBeUndefined();
  });

  it('still goes through RETREAT when movement dislodges a unit', () => {
    const map = mkMap();
    const state = initialState(map, 'standard');
    const dislodged = [{ unit: state.units[0]!, attackerFrom: 'z', retreatOptions: [] }];
    resolveMovement.mockReturnValue({ results: [], dislodged, next: { ...state } });

    const record = advance(state, [] as Order[], map);
    expect(record.after.phase).toBe('RETREAT');
    expect(record.after.variant).toBe('standard');
  });
});

describe('nextPhaseLabel', () => {
  it('formats season/year/phase', () => {
    const map = mkMap();
    expect(nextPhaseLabel(initialState(map))).toBe('Spring 1901 Movement');
    expect(nextPhaseLabel({ ...initialState(map), season: 'FALL', phase: 'RETREAT' })).toBe('Fall 1901 Retreat');
    expect(nextPhaseLabel({ ...initialState(map), season: 'WINTER', phase: 'ADJUSTMENT' })).toBe('Winter 1901 Adjustment');
    expect(nextPhaseLabel({ ...initialState(map), season: 'SUMMER', phase: 'SPAWN_CHOICE' })).toBe(
      'Summer 1901 Spawn Choice',
    );
    expect(nextPhaseLabel({ ...initialState(map), season: 'WINTER', phase: 'SPAWN_CHOICE' })).toBe(
      'Winter 1901 Spawn Choice',
    );
  });
});

describe('lifeStepLabel', () => {
  it('names the Life step after the season it happens in', () => {
    const map = mkMap();
    const base = initialState(map);
    // The Spring record's Life step, and the Summer spawn-choice that follows it.
    expect(lifeStepLabel(base)).toBe('Summer 1901 Life');
    expect(lifeStepLabel({ ...base, phase: 'RETREAT' })).toBe('Summer 1901 Life');
    expect(lifeStepLabel({ ...base, season: 'SUMMER', phase: 'SPAWN_CHOICE' })).toBe('Summer 1901 Life');
    // Winter's step runs inside Winter, after the adjustments.
    expect(lifeStepLabel({ ...base, season: 'WINTER', phase: 'ADJUSTMENT' })).toBe('Winter 1901 Life');
    expect(lifeStepLabel({ ...base, season: 'WINTER', phase: 'SPAWN_CHOICE' })).toBe('Winter 1901 Life');
  });
});
