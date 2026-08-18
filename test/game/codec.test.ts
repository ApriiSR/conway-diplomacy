import { describe, expect, it } from 'vitest';
import { decodeState, encodeState, exportGame, importGame } from '../../src/game/codec';
import type { GameState, LifeEvent, Power, PhaseRecord, Unit } from '../../src/engine/types';

function sampleState(): GameState {
  return {
    version: 1,
    year: 1902,
    season: 'FALL',
    phase: 'RETREAT',
    units: [
      { power: 'FRANCE', type: 'A', loc: 'par' },
      { power: 'RUSSIA', type: 'F', loc: 'stp/sc' },
      { power: 'NEUTRAL', type: 'A', loc: 'ser' },
    ],
    centers: {
      FRANCE: ['par', 'bre', 'mar'],
      RUSSIA: ['stp', 'mos', 'war', 'sev'],
    },
    dislodged: [{ unit: { power: 'FRANCE', type: 'A', loc: 'par' }, attackerFrom: 'bur', retreatOptions: ['pic'] }],
    labels: { FRANCE: 'ada', RUSSIA: 'CPU' },
  };
}

describe('encodeState / decodeState', () => {
  it('round-trips a full game state losslessly', async () => {
    const state = sampleState();
    const encoded = await encodeState(state);
    expect(typeof encoded).toBe('string');
    // base64url: no '+', '/', or '=' padding.
    expect(encoded).not.toMatch(/[+/=]/);
    const decoded = await decodeState(encoded);
    expect(decoded).toEqual(state);
  });

  it('round-trips minimal state (no dislodged/pendingBirths/labels)', async () => {
    const state: GameState = {
      version: 1,
      year: 1901,
      season: 'SPRING',
      phase: 'MOVEMENT',
      units: [],
      centers: {},
    };
    const decoded = await decodeState(await encodeState(state));
    expect(decoded).toEqual(state);
    expect(decoded.dislodged).toBeUndefined();
    expect(decoded.labels).toBeUndefined();
  });

  it('round-trips pendingBirths / SPAWN_CHOICE state', async () => {
    const state: GameState = {
      version: 1,
      year: 1901,
      season: 'SUMMER',
      phase: 'SPAWN_CHOICE',
      units: [{ power: 'GERMANY', type: 'A', loc: 'ber' }],
      centers: { GERMANY: ['ber'] },
      pendingBirths: [
        {
          kind: 'birth',
          province: 'hol',
          unit: null,
          power: 'GERMANY',
          neighbours: 3,
          parents: [
            { power: 'GERMANY', type: 'A', loc: 'ber' },
            { power: 'GERMANY', type: 'A', loc: 'kie' },
            { power: 'FRANCE', type: 'A', loc: 'bel' },
          ],
          pending: true,
        },
      ],
    };
    const decoded = await decodeState(await encodeState(state));
    expect(decoded).toEqual(state);
  });

  it('round-trips the standard-variant flag', async () => {
    const conwayState = sampleState(); // no `variant` field -> implicit 'conway'
    expect((await decodeState(await encodeState(conwayState))).variant).toBeUndefined();

    const standardState: GameState = { ...sampleState(), variant: 'standard' };
    const decoded = await decodeState(await encodeState(standardState));
    expect(decoded.variant).toBe('standard');
    expect(decoded).toEqual(standardState);
  });

  it('round-trips an explicit variant: "conway" as-is, distinct from omission', async () => {
    const explicitConway: GameState = { ...sampleState(), variant: 'conway' };
    const decoded = await decodeState(await encodeState(explicitConway));
    expect(decoded.variant).toBe('conway');
    expect(decoded).toEqual(explicitConway);
  });
});

describe('decodeState / importGame validation', () => {
  it('rejects a unit in an unknown province', async () => {
    const state: GameState = { ...sampleState(), units: [{ power: 'FRANCE', type: 'A', loc: 'zzz' }] };
    await expect(decodeState(await encodeState(state))).rejects.toThrow(/unknown province/);
  });

  it('rejects a unit with an unknown coast', async () => {
    const state: GameState = { ...sampleState(), units: [{ power: 'RUSSIA', type: 'F', loc: 'stp/ec' }] };
    await expect(decodeState(await encodeState(state))).rejects.toThrow(/unknown coast/);
  });

  it('rejects two units occupying the same province', async () => {
    const state: GameState = {
      ...sampleState(),
      units: [
        { power: 'FRANCE', type: 'A', loc: 'par' },
        { power: 'GERMANY', type: 'A', loc: 'par' },
      ],
    };
    await expect(decodeState(await encodeState(state))).rejects.toThrow(/two units occupy/);
  });

  it('rejects an implausible year', async () => {
    const state: GameState = { ...sampleState(), year: 0 };
    await expect(decodeState(await encodeState(state))).rejects.toThrow(/implausible year/);
  });

  it('rejects a center that is not a real supply center', async () => {
    const state: GameState = { ...sampleState(), centers: { FRANCE: ['par', 'pic'] } };
    await expect(decodeState(await encodeState(state))).rejects.toThrow(/not a supply center/);
  });

  it('rejects a supply center owned by two powers', async () => {
    const state: GameState = { ...sampleState(), centers: { FRANCE: ['par'], GERMANY: ['par'] } };
    await expect(decodeState(await encodeState(state))).rejects.toThrow(/owned by both/);
  });

  it('importGame runs the same validation as decodeState', () => {
    const state: GameState = { ...sampleState(), units: [{ power: 'FRANCE', type: 'A', loc: 'zzz' }] };
    const json = exportGame({ state, history: [] });
    expect(() => importGame(json)).toThrow(/unknown province/);
  });
});

describe('exportGame / importGame', () => {
  it('round-trips state + history as plain JSON', () => {
    const state = sampleState();
    const history: PhaseRecord[] = [
      {
        before: { ...state, phase: 'MOVEMENT', dislodged: undefined },
        orders: [],
        results: [],
        after: state,
      },
    ];
    const json = exportGame({ state, history });
    expect(() => JSON.parse(json)).not.toThrow();
    const imported = importGame(json);
    expect(imported.state).toEqual(state);
    expect(imported.history).toEqual(history);
  });

  it('rejects an export with an unsupported version', () => {
    const json = JSON.stringify({ version: 999, state: sampleState(), history: [] });
    expect(() => importGame(json)).toThrow(/unsupported export version/);
  });

  it('validates the boards inside history, not just the live one', () => {
    const state = sampleState();
    const record: PhaseRecord = { before: state, orders: [], results: [], after: state };
    const broken = {
      ...record,
      after: { ...state, units: [{ power: 'FRANCE', type: 'A', loc: 'zzz' }] },
    };
    const json = JSON.stringify({ version: 1, state, history: [record, broken] });
    expect(() => importGame(json)).toThrow(/history phase 2.*'after'.*unknown province/);
  });

  it('rejects a history record with no orders or results list', () => {
    const state = sampleState();
    const json = JSON.stringify({
      version: 1,
      state,
      history: [{ before: state, after: state, results: [] }],
    });
    expect(() => importGame(json)).toThrow(/history phase 1 has no orders list/);
  });

  it('round-trips the pre-Life board, and accepts a history written without one', () => {
    const state = sampleState();
    const preLifeUnits = [...state.units, { power: 'FRANCE' as const, type: 'A' as const, loc: 'bur' }];
    const record: PhaseRecord = { before: state, orders: [], results: [], preLifeUnits, after: state };
    expect(importGame(exportGame({ state, history: [record] })).history[0]!.preLifeUnits).toEqual(
      preLifeUnits,
    );
    const old = JSON.stringify({
      version: 1,
      state,
      history: [{ before: state, orders: [], results: [], after: state }],
    });
    expect(importGame(old).history[0]!.preLifeUnits).toBeUndefined();
  });

  it('rejects a history record whose pre-Life board is not a list', () => {
    const state = sampleState();
    const json = JSON.stringify({
      version: 1,
      state,
      history: [{ before: state, orders: [], results: [], preLifeUnits: 'nope', after: state }],
    });
    expect(() => importGame(json)).toThrow(/invalid pre-Life unit list/);
  });

  it('rejects a history that is not a list', () => {
    const json = JSON.stringify({ version: 1, state: sampleState(), history: { nope: true } });
    expect(() => importGame(json)).toThrow(/history is not a list/);
  });
});

describe('share link size (Discord 2000-char message budget)', () => {
  const POWERS: Power[] = ['AUSTRIA', 'ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'];
  // All 34 real standard-map SCs.
  const SCS = [
    'ank', 'bel', 'ber', 'bre', 'bud', 'bul', 'con', 'den', 'edi', 'gre', 'hol', 'kie', 'lon', 'lvp',
    'mar', 'mos', 'mun', 'nap', 'nwy', 'par', 'por', 'rom', 'rum', 'ser', 'sev', 'smy', 'spa', 'stp',
    'swe', 'tri', 'tun', 'ven', 'vie', 'war',
  ];

  // A plausible mid-game (~1907) board: all 34 SCs owned (roughly evenly split across the
  // 7 great powers), ~30 units (one per SC minus a few eliminated/empty, plus 2 NEUTRAL life
  // births sitting on non-SC provinces), Fall Retreat with 2 dislodgements.
  function midGameState(): GameState {
    const centers: Partial<Record<Power, string[]>> = {};
    SCS.forEach((sc, i) => {
      const power = POWERS[i % POWERS.length]!;
      (centers[power] ??= []).push(sc);
    });

    const unitTypeFor = (sc: string): Unit['type'] =>
      ['bre', 'kie', 'mar', 'nap', 'stp', 'swe', 'tri', 'tun', 'edi', 'lon', 'lvp', 'ank', 'con', 'smy', 'den', 'gre', 'nwy', 'por', 'rom', 'sev'].includes(sc)
        ? 'F'
        : 'A';
    const locFor = (sc: string): string =>
      sc === 'stp' ? 'stp/nc' : sc === 'spa' ? 'spa/sc' : sc === 'bul' ? 'bul/ec' : sc;

    const units: Unit[] = SCS.slice(0, 28).map((sc, i) => ({
      power: POWERS[i % POWERS.length]!,
      type: unitTypeFor(sc),
      loc: locFor(sc),
    }));
    units.push({ power: 'NEUTRAL', type: 'A', loc: 'boh' });
    units.push({ power: 'NEUTRAL', type: 'A', loc: 'ukr' });

    return {
      version: 1,
      year: 1907,
      season: 'FALL',
      phase: 'RETREAT',
      units,
      centers,
      dislodged: [
        { unit: { power: 'GERMANY', type: 'A', loc: 'mun' }, attackerFrom: 'ruh', retreatOptions: ['boh', 'sil'] },
        { unit: { power: 'ITALY', type: 'A', loc: 'ven' }, attackerFrom: 'tyr', retreatOptions: ['apu', 'rom'] },
      ],
    };
  }

  function spawnChoiceState(): GameState {
    const parentsFor = (a: Unit, b: Unit, c: Unit): Unit[] => [a, b, c];
    const pendingBirths: LifeEvent[] = [
      {
        kind: 'birth', province: 'hol', unit: null, power: 'GERMANY', neighbours: 3,
        parents: parentsFor(
          { power: 'GERMANY', type: 'A', loc: 'ruh' },
          { power: 'GERMANY', type: 'A', loc: 'kie' },
          { power: 'FRANCE', type: 'A', loc: 'bel' },
        ),
        pending: true,
      },
      {
        kind: 'birth', province: 'tus', unit: null, power: 'ITALY', neighbours: 3,
        parents: parentsFor(
          { power: 'ITALY', type: 'A', loc: 'pie' },
          { power: 'ITALY', type: 'A', loc: 'rom' },
          { power: 'FRANCE', type: 'F', loc: 'lyo' },
        ),
        pending: true,
      },
      {
        kind: 'birth', province: 'bul', unit: null, power: 'NEUTRAL', neighbours: 3,
        parents: parentsFor(
          { power: 'TURKEY', type: 'A', loc: 'con' },
          { power: 'AUSTRIA', type: 'A', loc: 'ser' },
          { power: 'RUSSIA', type: 'F', loc: 'rum' },
        ),
        pending: true,
      },
    ];

    return {
      ...midGameState(),
      season: 'SUMMER',
      phase: 'SPAWN_CHOICE',
      dislodged: undefined,
      pendingBirths,
      labels: {
        AUSTRIA: 'Herbert', ENGLAND: 'Winston', FRANCE: 'Charles', GERMANY: 'Otto',
        ITALY: 'Giuseppe', RUSSIA: 'Nikolai', TURKEY: 'Mehmed',
      },
    };
  }

  it('keeps a mid-game RETREAT share link well under Discord\'s 2000-char limit', async () => {
    const state = midGameState();
    const encoded = await encodeState(state);
    expect(await decodeState(encoded)).toEqual(state);
    expect(encoded.length).toBeLessThan(1200);
  });

  it('keeps a SPAWN_CHOICE share link (3 pending births + 7 labels) well under the limit', async () => {
    const state = spawnChoiceState();
    const encoded = await encodeState(state);
    expect(await decodeState(encoded)).toEqual(state);
    expect(encoded.length).toBeLessThan(1200);
  });
});
