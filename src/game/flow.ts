// Phase machine for the Conway's Game of Diplomacy variant.
// SPRING/MOVEMENT -> (RETREAT) -> Summer Life -> [SUMMER/SPAWN_CHOICE] -> FALL/MOVEMENT
//   -> (RETREAT) -> WINTER/ADJUSTMENT -> Winter Life -> [WINTER/SPAWN_CHOICE]
//   -> next year SPRING/MOVEMENT
//
// The engine resolvers also set a `next.phase`, but this file ignores it: they are
// authoritative only for `units`/`centers`/`labels`, and every season/year/phase
// transition is computed here, so the whole state machine lives in one place.

import type {
  BuildOrder,
  GameState,
  LifeEvent,
  LifeResult,
  MapData,
  MovementOrder,
  Order,
  PhaseKind,
  PhaseRecord,
  ProvinceId,
  RetreatOrder,
  Unit,
  Variant,
} from '../engine/types';
import { resolveAdjustments, resolveMovement, resolveRetreats } from '../engine/resolve';
import { lifeStep } from './life';
import { provinceOf } from '../engine/map-utils';

export function initialState(map: MapData, variant?: Variant): GameState {
  const state: GameState = {
    version: 1,
    year: 1901,
    season: 'SPRING',
    phase: 'MOVEMENT',
    units: map.startingUnits.map((u) => ({ ...u })),
    centers: Object.fromEntries(
      Object.entries(map.startingCenters).map(([power, provinces]) => [power, [...(provinces ?? [])]]),
    ) as GameState['centers'],
  };
  if (variant) state.variant = variant;
  return state;
}

type Patch = {
  season: GameState['season'];
  year: number;
  phase: PhaseKind;
  units?: Unit[];
  dislodged?: GameState['dislodged'];
  pendingBirths?: GameState['pendingBirths'];
};

function mkState(base: GameState, patch: Patch): GameState {
  const state: GameState = {
    version: 1,
    year: patch.year,
    season: patch.season,
    phase: patch.phase,
    units: patch.units ?? base.units,
    centers: base.centers,
  };
  if (base.variant) state.variant = base.variant;
  if (base.labels) state.labels = base.labels;
  if (patch.dislodged) state.dislodged = patch.dislodged;
  if (patch.pendingBirths) state.pendingBirths = patch.pendingBirths;
  return state;
}

function runLife(
  state: GameState,
  resolved: GameState,
  map: MapData,
): { life: LifeResult; preLifeUnits: Unit[]; after: GameState } {
  const life = lifeStep(resolved.units, map);
  // The board the step ran on, kept on the record: history draws the Life marks on it
  // rather than on the board they produced, so a unit that died is still there under its ✕.
  const preLifeUnits = resolved.units;
  if (life.pending.length > 0) {
    return {
      life,
      preLifeUnits,
      after: mkState(resolved, {
        // The post-Spring Life step happens in Summer, so the state the GM waits in is a
        // Summer one; the Winter step stays inside Winter.
        season: state.season === 'SPRING' ? 'SUMMER' : state.season,
        year: state.year,
        phase: 'SPAWN_CHOICE',
        units: life.units,
        pendingBirths: life.pending,
      }),
    };
  }
  if (state.season === 'SPRING') {
    return {
      life,
      preLifeUnits,
      after: mkState(resolved, { season: 'FALL', year: state.year, phase: 'MOVEMENT', units: life.units }),
    };
  }
  // WINTER life step with nothing pending: roll into next year's Spring.
  return {
    life,
    preLifeUnits,
    after: mkState(resolved, { season: 'SPRING', year: state.year + 1, phase: 'MOVEMENT', units: life.units }),
  };
}

/** Handles the state after a MOVEMENT or RETREAT resolution with nothing left dislodged. */
function afterMovementOrRetreat(
  before: GameState,
  orders: Order[],
  results: PhaseRecord['results'],
  resolved: GameState,
  map: MapData,
): PhaseRecord {
  if (before.season === 'FALL') {
    // No Life step after Fall; SC ownership already updated by the retreat/movement resolver.
    const after = mkState(resolved, { season: 'WINTER', year: before.year, phase: 'ADJUSTMENT' });
    return { before, orders, results, after };
  }
  if (before.variant === 'standard') {
    // Plain Diplomacy: no Life step, ever, so no SPAWN_CHOICE either.
    const after = mkState(resolved, { season: 'FALL', year: before.year, phase: 'MOVEMENT' });
    return { before, orders, results, after };
  }
  const { life, preLifeUnits, after } = runLife(before, resolved, map);
  return { before, orders, results, life, preLifeUnits, after };
}

export function advance(state: GameState, orders: Order[], map: MapData): PhaseRecord {
  switch (state.phase) {
    case 'MOVEMENT': {
      const { results, dislodged, next } = resolveMovement(state, orders as MovementOrder[], map);
      if (dislodged.length > 0) {
        const after = mkState(next, { season: state.season, year: state.year, phase: 'RETREAT', dislodged });
        return { before: state, orders, results, after };
      }
      return afterMovementOrRetreat(state, orders, results, next, map);
    }
    case 'RETREAT': {
      const { results, next } = resolveRetreats(state, orders as RetreatOrder[], map);
      return afterMovementOrRetreat(state, orders, results, next, map);
    }
    case 'ADJUSTMENT': {
      const { results, next } = resolveAdjustments(state, orders as BuildOrder[], map);
      if (state.variant === 'standard') {
        const after = mkState(next, { season: 'SPRING', year: state.year + 1, phase: 'MOVEMENT' });
        return { before: state, orders, results, after };
      }
      const { life, preLifeUnits, after } = runLife(state, next, map);
      return { before: state, orders, results, life, preLifeUnits, after };
    }
    case 'SPAWN_CHOICE':
      throw new Error('advance(): state is in SPAWN_CHOICE; call resolveSpawnChoices() instead');
  }
}

export interface SpawnChoice {
  province: ProvinceId;
  type: 'A' | 'F';
  coast?: string;
}

/** Result note on a birth nobody chose a type for. */
export const DEFAULTED = 'defaulted, no order given';

/**
 * Resolves the coastal-birth choices for a SPAWN_CHOICE state. Returns a PhaseRecord
 * (before = the SPAWN_CHOICE state, after = the resolved state, life = the now-resolved
 * births) so undo/history can see the spawn resolution as its own step.
 *
 * Each choice is recorded as a `build` order with an `ok` result, because that is what it is:
 * a power putting a named unit type into a named province. It also means the phase reports
 * itself the way every other phase does — "England: Build F Edi — ok" — instead of "no orders"
 * plus a Life list the GM has to read differently.
 *
 * A birth nobody chose for **defaults to an army**, noted as such in the results: the step
 * pauses for the GM, but a silent player can never block the game. An *invalid* choice still
 * throws before anything is placed — defaulting is for silence, not for mistakes.
 */
export function resolveSpawnChoices(state: GameState, choices: SpawnChoice[], map: MapData): PhaseRecord {
  if (state.phase !== 'SPAWN_CHOICE' || !state.pendingBirths) {
    throw new Error('resolveSpawnChoices(): state is not in SPAWN_CHOICE');
  }
  const pending = new Map(state.pendingBirths.map((e) => [e.province, e]));
  const chosen = new Map<ProvinceId, SpawnChoice>();
  for (const choice of choices) {
    if (!pending.has(choice.province)) {
      throw new Error(`resolveSpawnChoices(): ${choice.province} has no pending birth`);
    }
    chosen.set(choice.province, choice);
  }

  const occupied = new Set(state.units.map((u) => provinceOf(u.loc)));
  const newUnits: Unit[] = [];
  const resolvedEvents: LifeEvent[] = [];
  const orders: BuildOrder[] = [];
  const results: PhaseRecord['results'] = [];

  for (const event of state.pendingBirths) {
    const choice = chosen.get(event.province);
    const province = map.provinces[event.province];
    if (!province) {
      throw new Error(`resolveSpawnChoices(): unknown province ${event.province}`);
    }
    if (province.type !== 'coastal') {
      throw new Error(`resolveSpawnChoices(): ${event.province} is not a coastal province`);
    }
    if (occupied.has(event.province)) {
      throw new Error(`resolveSpawnChoices(): ${event.province} is already occupied`);
    }

    // Nobody answered for this birth, so it is an army — the step never blocks on a
    // silent player. The results say it was a default rather than a decision.
    const type: 'A' | 'F' = choice ? choice.type : 'A';
    let loc: string = event.province;
    if (choice) {
      if (type === 'F') {
        if (province.coasts.length > 0) {
          if (!choice.coast || !province.coasts.includes(choice.coast)) {
            throw new Error(`resolveSpawnChoices(): ${event.province} needs a valid coast for a fleet`);
          }
          loc = `${event.province}/${choice.coast}`;
        } else if (choice.coast) {
          throw new Error(`resolveSpawnChoices(): ${event.province} has no split coasts`);
        }
      } else if (type === 'A') {
        if (choice.coast) {
          throw new Error(`resolveSpawnChoices(): ${event.province} is an army; no coast expected`);
        }
      } else {
        throw new Error(`resolveSpawnChoices(): invalid unit type for ${event.province}`);
      }
    }

    const unit: Unit = { power: event.power, type, loc };
    newUnits.push(unit);
    resolvedEvents.push({ ...event, unit, pending: false });
    const order: BuildOrder = { kind: 'build', unit };
    orders.push(order);
    results.push(choice ? { order, result: 'ok' } : { order, result: 'ok', note: DEFAULTED });
    occupied.add(event.province);
  }

  const units = [...state.units, ...newUnits].sort((a, b) => provinceOf(a.loc).localeCompare(provinceOf(b.loc)));
  const after =
    state.season === 'WINTER'
      ? mkState(state, { season: 'SPRING', year: state.year + 1, phase: 'MOVEMENT', units })
      : mkState(state, { season: 'FALL', year: state.year, phase: 'MOVEMENT', units });

  const life: LifeResult = { units, events: resolvedEvents, pending: [] };
  return { before: state, orders, results, life, preLifeUnits: state.units, after };
}

const PHASE_LABEL: Record<PhaseKind, string> = {
  MOVEMENT: 'Movement',
  RETREAT: 'Retreat',
  ADJUSTMENT: 'Adjustment',
  SPAWN_CHOICE: 'Spawn Choice',
};

function seasonWord(season: GameState['season']): string {
  return season[0] + season.slice(1).toLowerCase();
}

export function nextPhaseLabel(state: GameState): string {
  return `${seasonWord(state.season)} ${state.year} ${PHASE_LABEL[state.phase]}`;
}

/**
 * What to call the Life step attached to a record whose `before` is `state`. The two Life
 * steps a year are Summer's (after Spring's movement/retreats) and Winter's (after the
 * adjustments); a spawn-choice record already carries the right season itself.
 */
export function lifeStepLabel(state: GameState): string {
  const summer = state.season === 'SPRING' || state.season === 'SUMMER';
  return `${summer ? 'Summer' : 'Winter'} ${state.year} Life`;
}
