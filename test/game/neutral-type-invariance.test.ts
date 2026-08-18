// A neutral unit's type is a rendering convention, not a rule.
//
// A neutral never moves and is never ordered, so nothing it could do depends on whether it
// is drawn as an army or as a fleet — and, on a split-coast province, nothing depends on
// which coast the fleet is drawn on. This file is the proof: every board below is resolved
// once per rendering (A, F/nc, F/sc, …) and the outcomes are compared.
//
// The comparison is "modulo the neutral's own type and coast": the neutral's `type` is
// blanked and its `loc` collapsed to the bare province, and the `retreatOptions` on the
// neutral's *own* dislodgement are blanked too (they differ by unit type, but nobody can
// give a neutral a retreat order, so the list is unreachable). Everything else — every
// other power's units, centres, the whole dislodged roster, every order's result, and the
// entire Life step — is compared exactly. If any of it ever differs, the neutral's type is
// a rule and this file will say so.

import { describe, expect, it } from 'vitest';
import { STANDARD_MAP as map } from '../../src/data/standard-map';
import { parseOrders } from '../../src/engine/parse';
import { advance } from '../../src/game/flow';
import { lifeStep } from '../../src/game/life';
import { provinceOf } from '../../src/engine/map-utils';
import type { GameState, ProvinceId, Unit, Variant } from '../../src/engine/types';

const U = (s: string): Unit => {
  const [type, power, loc] = s.split(' ');
  return { type: type as Unit['type'], power: power as Unit['power'], loc: loc! };
};

interface Rendering {
  label: string;
  unit: Unit;
}

/** Every way the tool could legitimately draw a neutral born on `prov`. */
function renderings(prov: ProvinceId): Rendering[] {
  const province = map.provinces[prov]!;
  const out: Rendering[] = [{ label: `A ${prov}`, unit: { power: 'NEUTRAL', type: 'A', loc: prov } }];
  if (province.coasts.length) {
    for (const c of province.coasts) {
      out.push({ label: `F ${prov}/${c}`, unit: { power: 'NEUTRAL', type: 'F', loc: `${prov}/${c}` } });
    }
  } else {
    out.push({ label: `F ${prov}`, unit: { power: 'NEUTRAL', type: 'F', loc: prov } });
  }
  return out;
}

const BLANK = '·';

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.power === 'NEUTRAL' && typeof o.loc === 'string' && typeof o.type === 'string') {
      return { power: 'NEUTRAL', type: BLANK, loc: provinceOf(o.loc) };
    }
    // A dislodged neutral's retreat options depend on its type, and are unreachable:
    // no retreat order for a neutral can exist, so it disbands either way.
    const unit = o.unit as Record<string, unknown> | undefined;
    if (Array.isArray(o.retreatOptions) && unit?.power === 'NEUTRAL') {
      return { ...(normalise({ ...o, retreatOptions: undefined }) as object), retreatOptions: BLANK };
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (o[k] === undefined) continue;
      out[k] = normalise(o[k]);
    }
    return out;
  }
  return value;
}

function board(neutral: Unit, others: Unit[], opts: Partial<GameState> = {}): GameState {
  return {
    version: 1,
    year: 1901,
    season: 'SPRING',
    phase: 'MOVEMENT',
    variant: 'standard' as Variant,
    units: [neutral, ...others],
    centers: {},
    ...opts,
  };
}

/**
 * Play `turns` (one order text per phase) from `base` and return everything observable:
 * the parse errors, every order's result, any Life step, and the resulting board.
 */
function trace(base: GameState, turns: string[]): unknown {
  const steps: unknown[] = [];
  let s = base;
  for (const text of turns) {
    const parsed = parseOrders(text, s, map);
    const record = advance(s, parsed.orders, map);
    steps.push({
      parseErrors: parsed.errors.map((e) => e.message),
      results: record.results,
      life: record.life?.events,
      after: record.after,
    });
    s = record.after;
    if (s.phase === 'SPAWN_CHOICE') break;
  }
  return normalise(steps);
}

interface Scenario {
  name: string;
  neutral: ProvinceId;
  others: string[];
  turns: string[];
  state?: Partial<GameState>;
}

function checkInvariant(sc: Scenario): void {
  const others = sc.others.map(U);
  const runs = renderings(sc.neutral).map((r) => ({
    label: r.label,
    out: trace(board(r.unit, others, sc.state), sc.turns),
  }));
  const [first, ...rest] = runs;
  for (const run of rest) {
    expect(run.out, `${sc.name}: ${run.label} differs from ${first!.label}`).toEqual(first!.out);
  }
}

// --------------------------------------------------------------- movement & retreats

const SCENARIOS: Scenario[] = [
  {
    name: 'plain coastal neutral (PIC), unsupported army attack bounces',
    neutral: 'pic',
    others: ['A FRANCE par', 'A FRANCE bur', 'F ENGLAND eng'],
    turns: ['France: A Par - Pic'],
  },
  {
    name: 'plain coastal neutral (PIC), supported army attack dislodges, then it disbands',
    neutral: 'pic',
    others: ['A FRANCE par', 'A FRANCE bur', 'F ENGLAND eng'],
    turns: ['France: A Par - Pic\nA Bur S A Par - Pic', ''],
  },
  {
    name: 'plain coastal neutral (PIC), fleet attack from a sea',
    neutral: 'pic',
    others: ['A FRANCE par', 'A FRANCE bur', 'F ENGLAND eng'],
    turns: ['England: F Eng - Pic'],
  },
  {
    name: 'plain coastal neutral (PIC), supported fleet attack dislodges',
    neutral: 'pic',
    others: ['A FRANCE par', 'A FRANCE bur', 'F ENGLAND eng', 'A FRANCE bel'],
    turns: ['England: F Eng - Pic\nFrance: A Bel S F Eng - Pic', ''],
  },
  {
    name: 'plain coastal neutral (HOL) support-held by another power against a supported attack',
    neutral: 'hol',
    others: ['A GERMANY kie', 'A GERMANY ruh', 'F ENGLAND nth', 'A FRANCE bel'],
    turns: ['Germany: A Ruh - Hol\nA Kie S A Ruh - Hol\nEngland: F Nth S Hol'],
  },
  {
    name: 'split coast (SPA): army attack from Gascony bounces',
    neutral: 'spa',
    others: ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao', 'F FRANCE lyo', 'A FRANCE por'],
    turns: ['France: A Gas - Spa'],
  },
  {
    name: 'split coast (SPA): supported army attack dislodges, then it disbands',
    neutral: 'spa',
    others: ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao', 'F FRANCE lyo', 'A FRANCE por'],
    turns: ['France: A Gas - Spa\nA Mar S A Gas - Spa', ''],
  },
  {
    name: 'split coast (SPA): fleet attack onto the north coast',
    neutral: 'spa',
    others: ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao', 'F FRANCE lyo', 'A FRANCE por'],
    turns: ['England: F Mao - Spa/nc'],
  },
  {
    name: 'split coast (SPA): fleet attack onto the south coast',
    neutral: 'spa',
    others: ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao', 'F FRANCE lyo', 'A FRANCE por'],
    turns: ['England: F Mao - Spa/sc'],
  },
  {
    name: 'split coast (SPA): supported fleet attack onto the south coast dislodges',
    neutral: 'spa',
    others: ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao', 'F FRANCE lyo', 'A FRANCE por'],
    turns: ['France: F Lyo - Spa/sc\nA Mar S F Lyo - Spa', ''],
  },
  {
    name: 'split coast (SPA): support-held against a supported fleet attack',
    neutral: 'spa',
    others: ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao', 'F FRANCE lyo', 'A FRANCE por'],
    turns: ['England: F Mao - Spa/nc\nFrance: A Gas S F Mao - Spa\nA Mar S Spa'],
  },
  {
    name: 'split coast (SPA) is a supply centre: a Fall turn never gives it to the neutral',
    neutral: 'spa',
    others: ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao', 'F FRANCE lyo', 'A FRANCE por'],
    state: { season: 'FALL', centers: { FRANCE: ['par', 'mar', 'bre'] } },
    turns: ['France: A Gas - Spa'],
  },
  {
    name: 'split coast (BUL): army, fleet-from-Black-Sea and supported attacks',
    neutral: 'bul',
    others: ['A TURKEY con', 'A AUSTRIA ser', 'F RUSSIA bla', 'A AUSTRIA gre'],
    turns: ['Turkey: A Con - Bul'],
  },
  {
    name: 'split coast (BUL): fleet attack onto the east coast',
    neutral: 'bul',
    others: ['A TURKEY con', 'A AUSTRIA ser', 'F RUSSIA bla', 'A AUSTRIA gre'],
    turns: ['Russia: F Bla - Bul/ec'],
  },
  {
    name: 'split coast (BUL): supported army attack dislodges, then it disbands',
    neutral: 'bul',
    others: ['A TURKEY con', 'A AUSTRIA ser', 'F RUSSIA bla', 'A AUSTRIA gre'],
    turns: ['Austria: A Ser - Bul\nA Gre S A Ser - Bul', ''],
  },
  {
    name: 'split coast (BUL): support-held by Turkey against Austria',
    neutral: 'bul',
    others: ['A TURKEY con', 'A AUSTRIA ser', 'F RUSSIA bla', 'A AUSTRIA gre'],
    turns: ['Austria: A Ser - Bul\nA Gre S A Ser - Bul\nTurkey: A Con S Bul'],
  },
  {
    name: 'split coast (STP): army attack from Moscow bounces',
    neutral: 'stp',
    others: ['A RUSSIA mos', 'A RUSSIA lvn', 'F ENGLAND bar', 'F RUSSIA bot', 'A RUSSIA fin'],
    turns: ['Russia: A Mos - Stp'],
  },
  {
    name: 'split coast (STP): fleet attack onto the north coast',
    neutral: 'stp',
    others: ['A RUSSIA mos', 'A RUSSIA lvn', 'F ENGLAND bar', 'F RUSSIA bot', 'A RUSSIA fin'],
    turns: ['England: F Bar - Stp/nc'],
  },
  {
    name: 'split coast (STP): supported fleet attack onto the south coast dislodges',
    neutral: 'stp',
    others: ['A RUSSIA mos', 'A RUSSIA lvn', 'F ENGLAND bar', 'F RUSSIA bot', 'A RUSSIA fin'],
    turns: ['Russia: F Bot - Stp/sc\nA Fin S F Bot - Stp', ''],
  },
  {
    name: 'convoyed attack bounces off the neutral (HOL)',
    neutral: 'hol',
    others: ['A ENGLAND lon', 'F ENGLAND nth', 'F ENGLAND hel', 'A GERMANY kie'],
    turns: ['England: A Lon - Hol via convoy\nF Nth C A Lon - Hol'],
  },
  {
    name: 'supported convoyed attack dislodges the neutral (HOL), then it disbands',
    neutral: 'hol',
    others: ['A ENGLAND lon', 'F ENGLAND nth', 'F ENGLAND hel', 'A GERMANY kie'],
    turns: ['England: A Lon - Hol via convoy\nF Nth C A Lon - Hol\nF Hel S A Lon - Hol', ''],
  },
  {
    name: 'neutral dislodged with nowhere to go at all (TUS)',
    neutral: 'tus',
    others: ['A ITALY ven', 'A ITALY rom', 'A ITALY pie', 'F ITALY lyo'],
    turns: ['Italy: A Ven - Tus\nA Rom S A Ven - Tus', ''],
  },
];

describe('a neutral unit\'s type is a rendering convention, not a rule', () => {
  // Negative control. Everything else here asserts that things are *equal*, which is only
  // worth anything if the comparison can tell boards apart at all — a normaliser that
  // flattened too much would make the whole file pass vacuously.
  it('the comparison notices a board that really is different', () => {
    const others = ['A FRANCE gas', 'A FRANCE mar', 'F ENGLAND mao'].map(U);
    const turns = ['France: A Gas - Spa\nA Mar S A Gas - Spa'];
    const atSpa = trace(board({ power: 'NEUTRAL', type: 'A', loc: 'spa' }, others), turns);
    const atPor = trace(board({ power: 'NEUTRAL', type: 'A', loc: 'por' }, others), turns);
    expect(atSpa).not.toEqual(atPor);
    // …and it notices a difference in a *non*-neutral unit's type, which is a real rule.
    const italianArmy = trace(board(U('A ITALY spa'), others), turns);
    const italianFleet = trace(board(U('F ITALY spa/nc'), others), turns);
    expect(italianArmy).not.toEqual(italianFleet);
  });

  for (const sc of SCENARIOS) {
    it(sc.name, () => checkInvariant(sc));
  }

  it('blocks a build the same way however it is drawn (neutral on the Russian home centre STP)', () => {
    const runs = renderings('stp').map((r) => ({
      label: r.label,
      out: trace(
        board(r.unit, [U('A RUSSIA ukr')], {
          season: 'WINTER',
          phase: 'ADJUSTMENT',
          centers: { RUSSIA: ['mos', 'war', 'sev', 'stp'] },
        }),
        ['Russia: Build A Stp\nBuild F Stp/nc\nBuild A Mos'],
      ),
    }));
    for (const run of runs.slice(1)) {
      expect(run.out, `build blocking: ${run.label} differs`).toEqual(runs[0]!.out);
    }
    // And the build really was blocked: only Moscow's went in.
    const after = (runs[0]!.out as { after: GameState }[])[0]!.after;
    expect(after.units.map((u) => u.loc).sort()).toEqual(['mos', 'stp', 'ukr']);
  });

  it('plays a whole Conway turn (movement -> Life) identically however it is drawn', () => {
    const others = ['A GERMANY kie', 'A GERMANY ruh', 'A FRANCE bel', 'A FRANCE bur'].map(U);
    const runs = renderings('hol').map((r) => ({
      label: r.label,
      out: trace(board(r.unit, others, { variant: undefined }), ['Germany: A Ruh - Mun']),
    }));
    for (const run of runs.slice(1)) {
      expect(run.out, `Conway turn: ${run.label} differs`).toEqual(runs[0]!.out);
    }
  });
});

describe('the Life step cannot see a neutral\'s type either', () => {
  const boards: { name: string; neutral: ProvinceId; others: string[] }[] = [
    { name: 'lonely neutral dies', neutral: 'spa', others: ['A FRANCE mar'] },
    { name: 'neutral with two neighbours survives', neutral: 'spa', others: ['A FRANCE mar', 'A FRANCE gas'] },
    {
      name: 'crowded neutral dies of overcrowding',
      neutral: 'spa',
      others: ['A FRANCE mar', 'A FRANCE gas', 'A FRANCE por', 'F FRANCE mao'],
    },
    {
      name: 'neutral counts as a parent, and its power decides the birth',
      neutral: 'bul',
      others: ['A TURKEY con', 'A AUSTRIA ser', 'A AUSTRIA gre', 'A RUSSIA rum'],
    },
    {
      name: 'two neutral parents plus one power still birth a neutral',
      neutral: 'stp',
      others: ['A NEUTRAL lvn', 'A RUSSIA mos', 'A RUSSIA war', 'A RUSSIA ukr'],
    },
  ];

  for (const b of boards) {
    it(b.name, () => {
      const others = b.others.map(U);
      const runs = renderings(b.neutral).map((r) => ({
        label: r.label,
        out: normalise(lifeStep([r.unit, ...others], map)),
      }));
      for (const run of runs.slice(1)) {
        expect(run.out, `${b.name}: ${run.label} differs`).toEqual(runs[0]!.out);
      }
    });
  }
});

describe('where the rendering does show through: notation, not adjudication', () => {
  // The one place a GM can tell: a support order that *names* the supported unit's type has
  // to name the type that is drawn. That is a spelling rule for the order line, not a rule
  // of play — dropping the letter makes the same order type-agnostic, and once parsed the
  // adjudication is identical, which is what every scenario above asserts.
  const others = [U('A FRANCE gas'), U('A FRANCE mar')];

  it('a type-less support reference parses against any rendering', () => {
    for (const r of renderings('spa')) {
      const state = board(r.unit, others);
      const parsed = parseOrders('France: A Mar S Spa', state, map);
      expect(parsed.errors, `${r.label}: ${JSON.stringify(parsed.errors)}`).toEqual([]);
      expect(parsed.orders).toHaveLength(1);
    }
  });

  it('a typed support reference has to match what is drawn', () => {
    const asArmy = board(renderings('spa')[0]!.unit, others);
    expect(parseOrders('France: A Mar S A Spa', asArmy, map).errors).toEqual([]);
    expect(parseOrders('France: A Mar S F Spa', asArmy, map).errors[0]?.message).toContain('is an army');
  });

  it('a neutral takes no orders whatever it is drawn as', () => {
    for (const r of renderings('spa')) {
      const state = board(r.unit, others);
      for (const line of ['Spa - Mar', 'A Spa H', 'F Spa - Mao']) {
        const parsed = parseOrders(line, state, map);
        expect(parsed.orders).toEqual([]);
        expect(parsed.errors).not.toEqual([]);
      }
    }
  });
});
