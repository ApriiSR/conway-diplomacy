import { describe, expect, it } from 'vitest';
import type { GameState, LifeEvent, PhaseRecord, Unit } from '../../src/engine/types';
import {
  historyViews,
  preLifeUnits,
  viewLife,
  viewResults,
  viewState,
} from '../../src/ui/history-views';

const U = (s: string): Unit => {
  const [type, power, loc] = s.split(' ');
  return { type: type as Unit['type'], power: power as Unit['power'], loc: loc! };
};

function board(patch: Partial<GameState>): GameState {
  return {
    version: 1,
    year: 1901,
    season: 'SPRING',
    phase: 'MOVEMENT',
    units: [],
    centers: {},
    ...patch,
  };
}

const death = (province: string, unit: Unit): LifeEvent => ({
  kind: 'death',
  province,
  unit,
  power: unit.power,
  neighbours: 1,
});

const birth = (province: string, unit: Unit): LifeEvent => ({
  kind: 'birth',
  province,
  unit,
  power: unit.power,
  neighbours: 3,
  parents: [],
});

/** Spring movement: Ven→Tyr succeeds, Tyr is then lonely and dies, Boh is born. */
function springRecord(): PhaseRecord {
  const moved = U('A ITALY tyr');
  const born = U('A AUSTRIA boh');
  const bystander = U('A AUSTRIA vie');
  const order = { kind: 'move' as const, unit: U('A ITALY ven'), to: 'tyr' };
  const preLife = [bystander, moved];
  const events = [death('tyr', moved), birth('boh', born)];
  return {
    before: board({ units: [U('A ITALY ven'), bystander] }),
    orders: [order],
    results: [{ order, result: 'ok' }],
    life: { units: [born, bystander], events, pending: [] },
    preLifeUnits: preLife,
    after: board({ season: 'FALL', units: [born, bystander] }),
  };
}

describe('history views', () => {
  it('lists a phase and its Life step as two entries, named for what each shows', () => {
    const views = historyViews([springRecord()]);
    expect(views.map((v) => v.label)).toEqual(['Spring 1901 Movement', 'Summer 1901 Life']);
    expect(views.map((v) => v.kind)).toEqual(['phase', 'life']);
    expect(views.every((v) => v.index === 0)).toBe(true);
  });

  it('draws a phase on the board its orders were given on', () => {
    const record = springRecord();
    const [phase] = historyViews([record]);
    expect(viewState(phase!)).toBe(record.before);
    expect(viewResults(phase!)).toBe(record.results);
    // The Life marks belong to the entry after it, not to this board.
    expect(viewLife(phase!)).toBeUndefined();
  });

  it('draws a Life step on the board it ran on, with the dying unit still there', () => {
    const record = springRecord();
    const life = historyViews([record])[1]!;
    const state = viewState(life);
    expect(state.units.map((u) => u.loc).sort()).toEqual(['tyr', 'vie']);
    expect(viewLife(life)).toBe(record.life);
    expect(viewResults(life)).toBeUndefined();
  });

  it('reconstructs the pre-Life board for exports written before it was recorded', () => {
    const record = springRecord();
    delete record.preLifeUnits;
    expect(preLifeUnits(record).map((u) => u.loc)).toEqual(['tyr', 'vie']);
  });

  it('gives a spawn-choice record one entry: the choices are its orders', () => {
    const unit = U('F ENGLAND edi');
    const order = { kind: 'build' as const, unit };
    const record: PhaseRecord = {
      before: board({ season: 'SUMMER', phase: 'SPAWN_CHOICE', pendingBirths: [birth('edi', unit)] }),
      orders: [order],
      results: [{ order, result: 'ok' }],
      life: { units: [unit], events: [birth('edi', unit)], pending: [] },
      after: board({ season: 'FALL', units: [unit] }),
    };
    expect(historyViews([record]).map((v) => v.label)).toEqual(['Summer 1901 Spawn Choice']);
  });

  it('skips a Life entry for a step that changed nothing', () => {
    const record = springRecord();
    record.life = { units: [], events: [], pending: [] };
    expect(historyViews([record]).map((v) => v.kind)).toEqual(['phase']);
  });

  it('names Winter’s Life step after the adjustments it follows', () => {
    const record = springRecord();
    record.before = board({ season: 'WINTER', phase: 'ADJUSTMENT' });
    expect(historyViews([record])[1]!.label).toBe('Winter 1901 Life');
  });

  it('leaves pending births to the Life layer rather than doubling them on the board', () => {
    const record = springRecord();
    const pending: LifeEvent = { kind: 'birth', province: 'boh', unit: null, power: 'AUSTRIA', neighbours: 3, pending: true };
    record.after = board({ season: 'SUMMER', phase: 'SPAWN_CHOICE', pendingBirths: [pending] });
    record.life = { units: [], events: [pending], pending: [pending] };
    expect(viewState(historyViews([record])[1]!).pendingBirths).toBeUndefined();
  });
});
