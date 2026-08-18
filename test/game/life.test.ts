import { describe, expect, it } from 'vitest';
import { lifeStep } from '../../src/game/life';
import { STANDARD_MAP } from '../../src/data/standard-map';
import type { MapData, Power, Province, ProvinceType, Unit } from '../../src/engine/types';

function mkProvince(id: string, type: ProvinceType, coasts: string[] = []): Province {
  return { id, name: id, type, sc: false, home: null, coasts, armyAdj: [], fleetAdj: {} };
}

function mkMap(provinces: Province[], lifeAdjacency: Record<string, string[]>): MapData {
  const provinceMap: Record<string, Province> = {};
  for (const p of provinces) provinceMap[p.id] = p;
  return { provinces: provinceMap, lifeAdjacency, startingUnits: [], startingCenters: {} };
}

function unit(power: Power, type: 'A' | 'F', loc: string): Unit {
  return { power, type, loc };
}

describe('lifeStep', () => {
  it('kills a lone unit with 0 occupied neighbours', () => {
    const map = mkMap(
      [mkProvince('a', 'inland'), mkProvince('b', 'inland')],
      { a: ['b'], b: ['a'] },
    );
    const result = lifeStep([unit('FRANCE', 'A', 'a')], map);
    expect(result.units).toEqual([]);
    expect(result.events).toEqual([
      { kind: 'death', province: 'a', unit: unit('FRANCE', 'A', 'a'), power: 'FRANCE', neighbours: 0 },
    ]);
  });

  it('kills a unit with exactly 1 occupied neighbour (loneliness)', () => {
    const map = mkMap(
      [mkProvince('a', 'inland'), mkProvince('b', 'inland'), mkProvince('c', 'inland')],
      { a: ['b'], b: ['a', 'c'], c: ['b'] },
    );
    const result = lifeStep([unit('FRANCE', 'A', 'a'), unit('GERMANY', 'A', 'b')], map);
    const deaths = result.events.filter((e) => e.kind === 'death').map((e) => e.province);
    expect(deaths.sort()).toEqual(['a', 'b']);
  });

  it('kills an occupied province with >= 4 occupied neighbours (overcrowding)', () => {
    // star graph: center x adjacent to a,b,c,d, all occupied plus x occupied.
    const map = mkMap(
      ['x', 'a', 'b', 'c', 'd'].map((id) => mkProvince(id, 'inland')),
      { x: ['a', 'b', 'c', 'd'], a: ['x'], b: ['x'], c: ['x'], d: ['x'] },
    );
    const units = [
      unit('FRANCE', 'A', 'x'),
      unit('FRANCE', 'A', 'a'),
      unit('FRANCE', 'A', 'b'),
      unit('FRANCE', 'A', 'c'),
      unit('FRANCE', 'A', 'd'),
    ];
    const result = lifeStep(units, map);
    const xEvent = result.events.find((e) => e.province === 'x');
    expect(xEvent).toEqual({ kind: 'death', province: 'x', unit: unit('FRANCE', 'A', 'x'), power: 'FRANCE', neighbours: 4 });
    expect(result.units.some((u) => u.loc === 'x')).toBe(false);
  });

  it('survives with 2-3 occupied neighbours', () => {
    const map = mkMap(
      ['a', 'b', 'c'].map((id) => mkProvince(id, 'inland')),
      { a: ['b', 'c'], b: ['a', 'c'], c: ['a', 'b'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('FRANCE', 'A', 'b'), unit('GERMANY', 'A', 'c')];
    const result = lifeStep(units, map);
    expect(result.events).toEqual([]);
    expect(result.units.map((u) => u.loc).sort()).toEqual(['a', 'b', 'c']);
  });

  it('births a new unit owned by the majority power (2 of 3 parents)', () => {
    const map = mkMap(
      ['x', 'a', 'b', 'c'].map((id) => mkProvince(id, 'inland')),
      { x: ['a', 'b', 'c'], a: ['x'], b: ['x'], c: ['x'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('FRANCE', 'A', 'b'), unit('GERMANY', 'A', 'c')];
    const result = lifeStep(units, map);
    const birth = result.events.find((e) => e.province === 'x');
    expect(birth?.kind).toBe('birth');
    expect(birth?.power).toBe('FRANCE');
    expect(birth?.pending).toBeUndefined();
    expect(birth?.unit).toEqual(unit('FRANCE', 'A', 'x'));
    expect(result.units.some((u) => u.loc === 'x' && u.power === 'FRANCE')).toBe(true);
  });

  it('births a NEUTRAL unit when no power has a majority of parents', () => {
    const map = mkMap(
      ['x', 'a', 'b', 'c'].map((id) => mkProvince(id, 'inland')),
      { x: ['a', 'b', 'c'], a: ['x'], b: ['x'], c: ['x'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('GERMANY', 'A', 'b'), unit('ITALY', 'A', 'c')];
    const result = lifeStep(units, map);
    const birth = result.events.find((e) => e.province === 'x');
    expect(birth?.power).toBe('NEUTRAL');
    expect(birth?.unit?.power).toBe('NEUTRAL');
  });

  it('leaves a coastal birth pending (no unit type decided yet)', () => {
    const map = mkMap(
      [mkProvince('x', 'coastal'), mkProvince('a', 'inland'), mkProvince('b', 'inland'), mkProvince('c', 'inland')],
      { x: ['a', 'b', 'c'], a: ['x'], b: ['x'], c: ['x'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('FRANCE', 'A', 'b'), unit('GERMANY', 'A', 'c')];
    const result = lifeStep(units, map);
    const birth = result.events.find((e) => e.province === 'x')!;
    expect(birth.kind).toBe('birth');
    expect(birth.pending).toBe(true);
    expect(birth.unit).toBeNull();
    expect(result.pending).toEqual([birth]);
    // Pending births are excluded from `units`.
    expect(result.units.some((u) => u.loc === 'x')).toBe(false);
  });

  it('resolves a NEUTRAL coastal birth immediately as an army (no GM choice)', () => {
    // A neutral unit never moves and issues no orders, so army-vs-fleet is inert:
    // asking the GM would be a choice with no consequence.
    const map = mkMap(
      [mkProvince('x', 'coastal'), mkProvince('a', 'inland'), mkProvince('b', 'inland'), mkProvince('c', 'inland')],
      { x: ['a', 'b', 'c'], a: ['x'], b: ['x'], c: ['x'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('GERMANY', 'A', 'b'), unit('ITALY', 'A', 'c')];
    const result = lifeStep(units, map);
    const birth = result.events.find((e) => e.province === 'x')!;
    expect(birth.power).toBe('NEUTRAL');
    expect(birth.pending).toBeUndefined();
    expect(birth.unit).toEqual(unit('NEUTRAL', 'A', 'x'));
    expect(result.pending).toEqual([]);
    expect(result.units.some((u) => u.loc === 'x' && u.power === 'NEUTRAL')).toBe(true);
  });

  it('pends only the great-power coastal birth when a neutral coastal birth happens too', () => {
    // `flow.advance` enters SPAWN_CHOICE iff `pending.length > 0`, so a step whose only
    // coastal births are neutral must leave `pending` empty.
    const map = mkMap(
      [
        mkProvince('x', 'coastal'),
        mkProvince('y', 'coastal'),
        ...['a', 'b', 'c', 'd', 'e'].map((id) => mkProvince(id, 'inland')),
      ],
      {
        x: ['a', 'b', 'c'],
        y: ['c', 'd', 'e'],
        a: ['x'], b: ['x'], c: ['x', 'y'], d: ['y'], e: ['y'],
      },
    );
    const units = [
      unit('FRANCE', 'A', 'a'),
      unit('FRANCE', 'A', 'b'),
      unit('GERMANY', 'A', 'c'),
      unit('ITALY', 'A', 'd'),
      unit('RUSSIA', 'A', 'e'),
    ];
    const result = lifeStep(units, map);
    expect(result.pending.map((e) => e.province)).toEqual(['x']); // French, still a choice
    const neutral = result.events.find((e) => e.province === 'y')!;
    expect(neutral.power).toBe('NEUTRAL');
    expect(neutral.unit).toEqual(unit('NEUTRAL', 'A', 'y'));
  });

  it('resolves a sea birth to a fleet', () => {
    const map = mkMap(
      [mkProvince('x', 'sea'), mkProvince('a', 'inland'), mkProvince('b', 'inland'), mkProvince('c', 'inland')],
      { x: ['a', 'b', 'c'], a: ['x'], b: ['x'], c: ['x'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('FRANCE', 'A', 'b'), unit('GERMANY', 'A', 'c')];
    const result = lifeStep(units, map);
    const birth = result.events.find((e) => e.province === 'x')!;
    expect(birth.unit).toEqual(unit('FRANCE', 'F', 'x'));
    expect(birth.pending).toBeUndefined();
  });

  it('resolves an inland birth to an army', () => {
    const map = mkMap(
      [mkProvince('x', 'inland'), mkProvince('a', 'inland'), mkProvince('b', 'inland'), mkProvince('c', 'inland')],
      { x: ['a', 'b', 'c'], a: ['x'], b: ['x'], c: ['x'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('FRANCE', 'A', 'b'), unit('GERMANY', 'A', 'c')];
    const result = lifeStep(units, map);
    const birth = result.events.find((e) => e.province === 'x')!;
    expect(birth.unit).toEqual(unit('FRANCE', 'A', 'x'));
  });

  it('is simultaneous: a unit that itself dies this step still counts as a neighbour', () => {
    // z is adjacent to a and b (both occupied pre-step) -> 2 occupied neighbours -> survives.
    // a and b are each adjacent only to z -> 1 occupied neighbour each -> both die (loneliness).
    // Province ids are chosen so alphabetical iteration hits a, b (the dying units) before z:
    // a buggy implementation that mutated the occupant map as it went (instead of computing
    // every count off the pre-step board) would remove a and b first, then see z with 0
    // occupied neighbours and kill it too. The correct, simultaneous answer is that z survives.
    const map = mkMap(
      ['a', 'b', 'z'].map((id) => mkProvince(id, 'inland')),
      { a: ['z'], b: ['z'], z: ['a', 'b'] },
    );
    const units = [unit('FRANCE', 'A', 'a'), unit('FRANCE', 'A', 'b'), unit('FRANCE', 'A', 'z')];
    const result = lifeStep(units, map);
    expect(result.events).toContainEqual({ kind: 'death', province: 'a', unit: unit('FRANCE', 'A', 'a'), power: 'FRANCE', neighbours: 1 });
    expect(result.events).toContainEqual({ kind: 'death', province: 'b', unit: unit('FRANCE', 'A', 'b'), power: 'FRANCE', neighbours: 1 });
    expect(result.events.find((e) => e.province === 'z')).toBeUndefined();
    expect(result.units.some((u) => u.loc === 'z')).toBe(true);
  });

  it('deterministically orders events by province id', () => {
    const map = mkMap(
      ['z', 'y', 'x'].map((id) => mkProvince(id, 'inland')),
      { z: [], y: [], x: [] },
    );
    const units = [unit('FRANCE', 'A', 'z'), unit('FRANCE', 'A', 'y'), unit('FRANCE', 'A', 'x')];
    const result = lifeStep(units, map);
    expect(result.events.map((e) => e.province)).toEqual(['x', 'y', 'z']);
  });
});

describe('lifeStep invalid input', () => {
  it('throws on a unit whose province is not a lifeAdjacency key, instead of vanishing it', () => {
    const map = mkMap([mkProvince('a', 'inland'), mkProvince('b', 'inland')], { a: ['b'], b: ['a'] });
    expect(() => lifeStep([unit('FRANCE', 'A', 'zzz')], map)).toThrow(/unknown province/);
  });

  it('throws on two units occupying the same province, instead of one silently overwriting the other', () => {
    const map = mkMap([mkProvince('a', 'inland'), mkProvince('b', 'inland')], { a: ['b'], b: ['a'] });
    expect(() => lifeStep([unit('FRANCE', 'A', 'a'), unit('GERMANY', 'A', 'a')], map)).toThrow(/two units occupy 'a'/);
  });
});

describe('lifeStep on the standard 1901 opening board', () => {
  it('kills Russia\'s lonely home units (StP, War, Sev) after a no-move Spring', () => {
    const result = lifeStep(STANDARD_MAP.startingUnits, STANDARD_MAP);
    const deaths = new Set(result.events.filter((e) => e.kind === 'death').map((e) => e.province));
    expect(deaths.has('stp')).toBe(true);
    expect(deaths.has('war')).toBe(true);
    expect(deaths.has('sev')).toBe(true);
  });
});
