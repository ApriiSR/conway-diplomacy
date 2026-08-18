// What the history dropdown lists, and what each entry puts on the board.
//
// One record can be two things to look at. A phase view is the board the orders were
// given on, with those orders' arrows and result marks drawn on it — the board the GM
// was staring at while adjudicating, annotated with what happened to it. A Life view is
// the board those orders produced, with the Life step's ✕s and births drawn on it. So a
// mark is always shown on the board it acted on, never on the board it produced.

import type { GameState, LifeResult, PhaseRecord, ResultEntry, Unit } from '../engine/types.js';
import { provinceOf } from '../engine/map-utils.js';
import { lifeStepLabel, nextPhaseLabel } from './api.js';

export interface HistoryView {
  kind: 'phase' | 'life';
  /** Which record in `history` this view belongs to; two views can share one. */
  index: number;
  record: PhaseRecord;
  label: string;
}

/**
 * A spawn-choice record's Life step *is* its orders — the births were chosen, and the
 * phase view already draws them — so it never gets a second entry. Nor does a step that
 * did nothing: an entry that draws no mark is a dropdown row with nothing to see.
 */
function hasLifeView(record: PhaseRecord): boolean {
  return record.before.phase !== 'SPAWN_CHOICE' && !!record.life?.events.length;
}

export function historyViews(history: PhaseRecord[]): HistoryView[] {
  const views: HistoryView[] = [];
  history.forEach((record, index) => {
    views.push({ kind: 'phase', index, record, label: nextPhaseLabel(record.before) });
    if (hasLifeView(record)) {
      views.push({ kind: 'life', index, record, label: lifeStepLabel(record.before) });
    }
  });
  return views;
}

/**
 * Stepping through the history bar's entries. The picker's positions are the views plus
 * one more on the end for "Current", so a step is arithmetic over `0…count` and only the
 * two ends are special. `null` means "Current" here exactly as it does for `viewIndex`,
 * so the translation happens once, at this boundary.
 */
export function viewPosition(viewIndex: number | null, count: number): number {
  if (viewIndex === null) return count;
  return Math.min(Math.max(viewIndex, 0), count);
}

export function viewAtPosition(position: number, count: number): number | null {
  return position >= count ? null : Math.max(position, 0);
}

export function canStepView(viewIndex: number | null, count: number, delta: number): boolean {
  const next = viewPosition(viewIndex, count) + delta;
  return next >= 0 && next <= count;
}

/** The neighbouring entry, or the one we're on when there is no neighbour that way. */
export function stepView(viewIndex: number | null, count: number, delta: number): number | null {
  if (!canStepView(viewIndex, count, delta)) return viewAtPosition(viewPosition(viewIndex, count), count);
  return viewAtPosition(viewPosition(viewIndex, count) + delta, count);
}

/**
 * The board the Life step ran on. Recorded by `flow.ts`; reconstructed here for games
 * exported before it was — put the dead back, take the newborns out, which is exactly
 * what the step did in reverse.
 */
export function preLifeUnits(record: PhaseRecord): Unit[] {
  if (record.preLifeUnits) return record.preLifeUnits;
  const life = record.life;
  if (!life) return record.after.units;
  const born = new Set(
    life.events.filter((e) => e.kind === 'birth' && e.unit).map((e) => provinceOf(e.unit!.loc)),
  );
  const units = record.after.units.filter((u) => !born.has(provinceOf(u.loc)));
  for (const e of life.events) if (e.kind === 'death' && e.unit) units.push(e.unit);
  return units.sort((a, b) => provinceOf(a.loc).localeCompare(provinceOf(b.loc)));
}

export function viewState(view: HistoryView): GameState {
  if (view.kind === 'phase') return view.record.before;
  const state: GameState = { ...view.record.after, units: preLifeUnits(view.record) };
  // Pending births are drawn from the Life result on this view, so the board's own
  // pending-birth markers would only double them up.
  delete state.pendingBirths;
  return state;
}

export function viewResults(view: HistoryView): ResultEntry[] | undefined {
  return view.kind === 'phase' ? view.record.results : undefined;
}

export function viewLife(view: HistoryView): LifeResult | undefined {
  return view.kind === 'life' ? view.record.life : undefined;
}
