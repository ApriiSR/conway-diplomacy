import { describe, expect, it } from 'vitest';
import { reportText, resultGroups } from '../../src/ui/report';
import type { PhaseRecord, Unit } from '../../src/engine/types';

const U = (s: string): Unit => {
  const [type, power, loc] = s.split(' ');
  return { type: type as Unit['type'], power: power as Unit['power'], loc: loc! };
};

function spawnRecord(): PhaseRecord {
  const before = {
    version: 1 as const,
    year: 1901,
    season: 'SUMMER' as const,
    phase: 'SPAWN_CHOICE' as const,
    units: [],
    centers: {},
  };
  const chosen = { kind: 'build' as const, unit: U('F ENGLAND edi') };
  const defaulted = { kind: 'build' as const, unit: U('A RUSSIA stp') };
  return {
    before,
    orders: [chosen, defaulted],
    results: [
      { order: chosen, result: 'ok' },
      { order: defaulted, result: 'ok', note: 'defaulted, no order given' },
    ],
    after: { ...before, season: 'FALL' as const, phase: 'MOVEMENT' as const },
  };
}

describe('spawn-choice reporting', () => {
  it('reads like a build report, with the defaulted spawn called out', () => {
    const text = reportText('Summer 1901 Spawn Choice', spawnRecord());
    expect(text).toContain('England:\n  Build F EDI — ok');
    expect(text).toContain('Russia:\n  Build A STP — ok (defaulted, no order given)');
    expect(text).not.toContain('(no orders)');
  });

  it('carries the note through resultGroups, and only on the row it belongs to', () => {
    const groups = resultGroups(spawnRecord());
    expect(groups.find((g) => g.power === 'ENGLAND')!.rows[0]!.notes).toEqual([]);
    expect(groups.find((g) => g.power === 'RUSSIA')!.rows[0]!.notes).toEqual([
      'defaulted, no order given',
    ]);
  });

  it('names the Life step for the season it ran in', () => {
    const summer = spawnRecord();
    summer.life = { units: [], events: [], pending: [] };
    expect(reportText('x', summer)).toContain('Summer 1901 Life:');

    const winter: PhaseRecord = {
      ...summer,
      before: { ...summer.before, season: 'WINTER', phase: 'ADJUSTMENT' },
    };
    expect(reportText('x', winter)).toContain('Winter 1901 Life:');
  });
});
