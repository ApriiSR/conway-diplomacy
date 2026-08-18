// The GM's cross-check view of an adjudicated phase: every order with its
// result(s), grouped by power, plus the Life step — as data (for the panel) and
// as plain text (for pasting into chat).

import type { LifeEvent, LifeResult, OrderResult, PhaseRecord, Power } from '../engine/types.js';
import { GREAT_POWERS } from '../engine/types.js';
import { lifeStepLabel } from '../game/flow.js';
import { POWER_ADJECTIVE, powerTitle } from './colors.js';
import { provinceOf } from '../engine/map-utils.js';
import { formatOrder, orderPower } from './orders-text.js';

export interface ResultRow {
  text: string;
  results: OrderResult[];
  /** Explanations attached to the result, e.g. a spawn that defaulted to an army. */
  notes: string[];
}

export interface ResultGroup {
  power: Power;
  rows: ResultRow[];
}

/** One line per order; repeated results for the same order collapse into a list. */
export function resultGroups(record: PhaseRecord): ResultGroup[] {
  const byPower = new Map<Power, Map<string, ResultRow>>();
  for (const { order, result, note } of record.results) {
    const power = orderPower(order);
    let rows = byPower.get(power);
    if (!rows) byPower.set(power, (rows = new Map()));
    const text = formatOrder(order);
    let row = rows.get(text);
    if (row) {
      if (!row.results.includes(result)) row.results.push(result);
    } else {
      rows.set(text, (row = { text, results: [result], notes: [] }));
    }
    if (note && !row.notes.includes(note)) row.notes.push(note);
  }
  const order: Power[] = [...GREAT_POWERS, 'NEUTRAL'];
  return order
    .filter((p) => byPower.has(p))
    .map((p) => ({ power: p, rows: [...byPower.get(p)!.values()] }));
}

export function lifeLineText(ev: LifeEvent): string {
  const name = provinceOf(ev.province).toUpperCase();
  if (ev.kind === 'death') {
    const why = ev.neighbours <= 1 ? 'dies of loneliness' : 'dies of overcrowding';
    return `${name}: ${why} (${ev.neighbours} neighbour${ev.neighbours === 1 ? '' : 's'})`;
  }
  const parents = (ev.parents ?? []).map((p) => provinceOf(p.loc).toUpperCase()).join(', ');
  const who = POWER_ADJECTIVE[ev.power];
  const article = ev.power === 'NEUTRAL' ? 'a' : /^[AEIOU]/i.test(who) ? 'an' : 'a';
  const what = ev.pending
    ? `spawns ${article} ${who} unit — army or fleet undecided`
    : `spawns ${article} ${who} ${ev.unit?.type === 'F' ? 'fleet' : 'army'}`;
  return `${name}: ${what} (parents ${parents})`;
}

/** Just the Life step, for the history entry that is only the Life step. */
export function lifeReportText(label: string, life: LifeResult): string {
  const lines: string[] = [label, ''];
  if (!life.events.length) lines.push('No births or deaths.');
  for (const ev of life.events) lines.push(lifeLineText(ev));
  return lines.join('\n') + '\n';
}

/**
 * Plain text for the clipboard: phase label, results by power, then the Life step —
 * unless `life` is `null`, which drops the Life section: the history lists a phase and
 * its Life step as two entries, and each entry copies only its own half.
 */
export function reportText(label: string, record: PhaseRecord, life?: LifeResult | null): string {
  const lines: string[] = [label, ''];
  const groups = resultGroups(record);
  if (!groups.length) lines.push('(no orders)');
  for (const g of groups) {
    lines.push(`${powerTitle(g.power)}:`);
    for (const r of g.rows) {
      const note = r.notes.length ? ` (${r.notes.join('; ')})` : '';
      lines.push(`  ${r.text} — ${r.results.join(', ')}${note}`);
    }
    lines.push('');
  }
  const l = life === null ? undefined : (life ?? record.life);
  if (l) {
    lines.push(`${lifeStepLabel(record.before)}:`);
    if (!l.events.length) lines.push('  No births or deaths.');
    for (const ev of l.events) lines.push(`  ${lifeLineText(ev)}`);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
