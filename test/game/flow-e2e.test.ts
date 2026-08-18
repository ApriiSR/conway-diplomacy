// End-to-end test of advance()/resolveSpawnChoices() on the real STANDARD_MAP, driving the
// real engine resolvers (no mocks) through a full game year: Spring moves -> Life ->
// SPAWN_CHOICE -> Fall supported attack -> dislodge -> RETREAT -> SC capture -> Winter builds
// -> Life -> SPAWN_CHOICE -> next Spring. Kept in its own file because flow.test.ts mocks
// '../../src/engine/resolve' at module scope for its unit tests.
import { describe, expect, it } from 'vitest';
import { STANDARD_MAP as map } from '../../src/data/standard-map';
import { parseOrders } from '../../src/engine/parse';
import { advance, resolveSpawnChoices } from '../../src/game/flow';
import type { GameState, Unit } from '../../src/engine/types';

const U = (s: string): Unit => {
  const [type, power, loc] = s.split(' ');
  return { type: type as Unit['type'], power: power as Unit['power'], loc: loc! };
};

describe('advance() end-to-end on STANDARD_MAP with real resolvers', () => {
  it('Spring moves -> Life/SPAWN_CHOICE -> Fall dislodge -> RETREAT/capture -> Winter builds -> Life/SPAWN_CHOICE -> next Spring', () => {
    let s: GameState = {
      version: 1,
      year: 1901,
      season: 'SPRING',
      phase: 'MOVEMENT',
      units: [
        U('F GERMANY hel'),
        U('A GERMANY kie'),
        U('A GERMANY mun'),
        U('A FRANCE mar'),
        U('A FRANCE tyr'),
        U('A FRANCE bel'),
        U('A ITALY ven'),
      ],
      centers: { GERMANY: ['kie', 'ber', 'mun'], FRANCE: ['par', 'mar', 'bre'] },
    };

    // --- Spring 1901 movement: a few real moves, rest hold. ---
    let parsed = parseOrders('FRANCE: A mar - bur\nITALY: A ven - pie', s, map);
    expect(parsed.errors).toEqual([]);
    let r = advance(s, parsed.orders, map);
    s = r.after;

    // No dislodgement this turn, so Life ran straight away (no RETREAT phase).
    // hel (lonely), bel (lonely), pie (lonely) die; hol is a coastal birth (GERMANY
    // majority parent: kie + hel vs bel) and sits pending.
    expect(s.season).toBe('SUMMER');
    expect(s.phase).toBe('SPAWN_CHOICE');
    expect(s.units.map((u) => `${u.power[0]}${u.type}:${u.loc}`).sort()).toEqual(
      ['FA:bur', 'GA:kie', 'GA:mun', 'FA:tyr'].sort(),
    );
    expect(s.pendingBirths).toHaveLength(1);
    expect(s.pendingBirths![0]).toMatchObject({ province: 'hol', power: 'GERMANY', pending: true });

    // --- Resolve the coastal birth: the GM enters Germany's decision as a build order. ---
    parsed = parseOrders('GERMANY: Build A hol', s, map);
    expect(parsed.errors).toEqual([]);
    expect(parsed.orders).toEqual([{ kind: 'build', unit: U('A GERMANY hol') }]);

    const spawnRecord = resolveSpawnChoices(s, [{ province: 'hol', type: 'A' }], map);
    expect(spawnRecord.before).toEqual(s);
    expect(spawnRecord.orders).toEqual(parsed.orders);
    expect(spawnRecord.results).toEqual([{ order: { kind: 'build', unit: U('A GERMANY hol') }, result: 'ok' }]);
    expect(spawnRecord.life?.pending).toEqual([]);
    expect(spawnRecord.life?.events).toEqual([
      expect.objectContaining({ province: 'hol', power: 'GERMANY', pending: false, unit: U('A GERMANY hol') }),
    ]);
    s = spawnRecord.after;
    expect(s.season).toBe('FALL');
    expect(s.phase).toBe('MOVEMENT');
    expect(s.units.map((u) => `${u.power[0]}${u.type}:${u.loc}`).sort()).toEqual(
      ['FA:bur', 'GA:hol', 'GA:kie', 'GA:mun', 'FA:tyr'].sort(),
    );

    // --- Fall 1901: France attacks Munich from Burgundy with support from Tyrolia. ---
    parsed = parseOrders('FRANCE: A bur - mun\nA tyr S A bur - mun', s, map);
    expect(parsed.errors).toEqual([]);
    r = advance(s, parsed.orders, map);
    s = r.after;

    expect(s.phase).toBe('RETREAT');
    expect(s.dislodged).toHaveLength(1);
    expect(s.dislodged![0]).toMatchObject({ unit: U('A GERMANY mun'), attackerFrom: 'bur' });
    // SC ownership doesn't transfer until the retreat resolves, so mun is still GERMANY's here.
    expect(s.centers).toEqual({ GERMANY: ['kie', 'ber', 'mun'], FRANCE: ['par', 'mar', 'bre'] });
    expect(s.units.map((u) => `${u.power[0]}${u.type}:${u.loc}`).sort()).toEqual(
      ['FA:mun', 'GA:hol', 'GA:kie', 'FA:tyr'].sort(),
    );

    // --- Retreat: the dislodged German army falls back to Silesia. ---
    parsed = parseOrders('GERMANY: A mun - sil', s, map);
    expect(parsed.errors).toEqual([]);
    r = advance(s, parsed.orders, map);
    s = r.after;

    expect(s.season).toBe('WINTER');
    expect(s.phase).toBe('ADJUSTMENT');
    expect(s.dislodged).toBeUndefined();
    expect(s.centers).toEqual({ GERMANY: ['ber', 'hol', 'kie'], FRANCE: ['bre', 'mar', 'mun', 'par'] });
    expect(s.units.map((u) => `${u.power[0]}${u.type}:${u.loc}`).sort()).toEqual(
      ['FA:mun', 'GA:hol', 'GA:kie', 'FA:tyr', 'GA:sil'].sort(),
    );

    // --- Winter 1901: France has 4 centres to 2 units and builds one of the two it is
    // owed (the other is waived by saying nothing). Germany has 3 centres to 3 units, so
    // it owes nothing and its removal is void — kept here on purpose, because an
    // unrequested removal must not take a unit off the board. ---
    parsed = parseOrders('FRANCE: build A par\nGERMANY: remove A sil', s, map);
    expect(parsed.errors).toEqual([]);
    r = advance(s, parsed.orders, map);
    expect(r.results).toEqual([
      { order: { kind: 'build', unit: U('A FRANCE par') }, result: 'ok' },
      { order: { kind: 'remove', unit: U('A GERMANY sil') }, result: 'void' },
    ]);
    s = r.after;

    // Winter Life ran: hol/sil/tyr/par all die (loneliness), boh and ruh are births (majority
    // FRANCE / GERMANY resp.), and ber is a second coastal birth left pending.
    expect(s.season).toBe('WINTER');
    expect(s.phase).toBe('SPAWN_CHOICE');
    expect(s.units.map((u) => `${u.power[0]}${u.type}:${u.loc}`).sort()).toEqual(
      ['FA:boh', 'GA:kie', 'FA:mun', 'GA:ruh'].sort(),
    );
    expect(s.pendingBirths).toHaveLength(1);
    expect(s.pendingBirths![0]).toMatchObject({ province: 'ber', power: 'GERMANY', pending: true });
    expect(s.centers).toEqual({ GERMANY: ['ber', 'hol', 'kie'], FRANCE: ['bre', 'mar', 'mun', 'par'] });

    // --- Resolve the last coastal birth and roll into Spring 1902. ---
    const winterSpawnRecord = resolveSpawnChoices(s, [{ province: 'ber', type: 'A' }], map);
    s = winterSpawnRecord.after;

    expect(s.year).toBe(1902);
    expect(s.season).toBe('SPRING');
    expect(s.phase).toBe('MOVEMENT');
    expect(s.units.map((u) => `${u.power[0]}${u.type}:${u.loc}`).sort()).toEqual(
      ['GA:ber', 'FA:boh', 'GA:kie', 'FA:mun', 'GA:ruh'].sort(),
    );
  });
});
