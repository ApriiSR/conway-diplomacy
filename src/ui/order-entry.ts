import type { Power, Unit } from '../engine/types.js';
import { GREAT_POWERS } from '../engine/types.js';
import { provinceOf } from '../engine/map-utils.js';
import type { DuplicateOrder } from './api.js';
import { POWER_COLORS, POWER_INITIAL, powerTitle } from './colors.js';
import type { ClickMode } from './interaction.js';
import type { App } from './main.js';
import { showModal } from './modals.js';
import { locText, splitByPowerHeaders } from './orders-text.js';
import { adjustmentWarnings, countChip, deltaText, powerCounts, retreatRows } from './phase-info.js';
import { el } from './svg.js';

/** One order buffer per power, plus NEUTRAL — the model behind the tabs. */
export type OrderText = Record<Power, string>;

export const emptyText = (): OrderText =>
  Object.fromEntries([...GREAT_POWERS, 'NEUTRAL'].map((p) => [p, ''])) as OrderText;

export interface Readiness {
  power: Power;
  orders: number;
  units: number;
  errors: number;
  /**
   * The subset of `errors` that are coast trouble. These lines *did* parse and their
   * orders are on the board — the coast is just wrong or missing, so the adjudicator
   * will void them. Worth counting as a problem, not worth calling a parse failure.
   */
  coastIssues: number;
  unordered: Unit[];
  /** Units given more than one order this phase; only the last of each reaches the engine. */
  duplicates: DuplicateOrder[];
  /** Does this power owe orders at all this phase? (No dislodgement → no retreat owed.) */
  owes: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * What the red badge on a power's chip is actually complaining about. Lines that didn't
 * parse and orders with a bad coast are both problems, but only the first is a line the
 * GM has to rewrite from scratch — the second is a kept order one token away from legal.
 */
function problemSummary(r: Readiness): string {
  const parts: string[] = [];
  const unparsed = r.errors - r.coastIssues;
  if (unparsed) parts.push(`${plural(unparsed, 'line')} did not parse`);
  if (r.coastIssues) parts.push(`${plural(r.coastIssues, 'order')} with a wrong or missing coast`);
  return parts.join('; ');
}

export function unitsWithoutOrders(app: App): Unit[] {
  // Nothing on the board is owed an order during a spawn choice — the only decisions
  // outstanding are for units that don't exist yet.
  if (app.state.phase === 'SPAWN_CHOICE') return [];
  const ordered = new Set(app.allOrders().map((o) => ('unit' in o ? provinceOf(o.unit.loc) : '')));
  return app.state.units.filter((u) => u.power !== 'NEUTRAL' && !ordered.has(provinceOf(u.loc)));
}

/** Per-power submission state for the readiness strip and the adjudicate confirm. */
export function readiness(app: App): Readiness[] {
  const unordered = unitsWithoutOrders(app);
  const counts = new Map(powerCounts(app.state).map((c) => [c.power, c]));
  const dislodged = new Set((app.state.dislodged ?? []).map((d) => d.unit.power));
  return GREAT_POWERS.filter((p) => p !== 'NEUTRAL').map((power) => {
    const parsed = app.parsedFor(power);
    // Only powers that owe something this phase count as "nothing received".
    const owes =
      app.state.phase === 'RETREAT'
        ? dislodged.has(power)
        : app.state.phase === 'ADJUSTMENT'
          ? (counts.get(power)?.delta ?? 0) !== 0
          : app.state.phase === 'SPAWN_CHOICE'
            ? (app.state.pendingBirths ?? []).some((e) => e.power === power)
            : app.state.units.some((u) => u.power === power);
    return {
      power,
      orders: parsed.orders.length,
      units: app.state.units.filter((u) => u.power === power).length,
      errors: parsed.errors.length,
      coastIssues: parsed.errors.filter((e) => e.kind === 'coast').length,
      duplicates: parsed.duplicates,
      unordered: unordered.filter((u) => u.power === power),
      owes,
    };
  });
}

// ---------- the textarea ----------

/**
 * The order box is a single long-lived node, created once and re-parented across
 * renders. It must not be rebuilt: a fresh element cannot be focused until the panel
 * has been appended, so a rebuild drops focus on every keystroke, and one node is also
 * what preserves the textarea's own undo stack, scroll position and IME state.
 */
function orderTextarea(app: App): HTMLTextAreaElement {
  if (app.ta) return app.ta;
  const ta = el('textarea', { class: 'orders', spellcheck: 'false' }) as HTMLTextAreaElement;
  ta.addEventListener('compositionstart', () => {
    app.composing = true;
  });
  ta.addEventListener('compositionend', () => {
    app.composing = false;
    scheduleApply(app);
  });
  ta.addEventListener('input', () => {
    if (app.composing) return; // never re-render mid-IME-composition
    scheduleApply(app);
  });
  ta.addEventListener('blur', () => app.flushText());
  app.ta = ta;
  return ta;
}

function scheduleApply(app: App): void {
  clearTimeout(app.debounce);
  app.debounce = window.setTimeout(() => app.flushText(true), 180);
}

/**
 * Land whatever is sitting in the textarea's debounce window. Anything that acts on
 * the orders — adjudicating, copying, exporting — calls this first, so a GM who pastes
 * and immediately hits Adjudicate doesn't adjudicate the previous contents.
 */
export function flushText(app: App, rerender = false): void {
  clearTimeout(app.debounce);
  const ta = app.ta;
  // The box is one long-lived node, so it stays authoritative even while it is
  // momentarily detached mid-render. Deliberately no `isConnected` guard: that would
  // drop a pending edit *and* cancel the debounce that would have retried it.
  if (!ta) return;
  const current = app.taTab === 'ALL' ? app.allText : (app.orderText[app.taTab] ?? '');
  if (ta.value === current) return;
  applyText(app, app.taTab, ta.value, rerender);
}

export function combinedText(app: App): string {
  return GREAT_POWERS.filter((p) => (app.orderText[p] ?? '').trim())
    .map((p) => `${powerTitle(p)}:\n${(app.orderText[p] ?? '').trim()}`)
    .join('\n\n');
}

function applyText(app: App, tab: Power | 'ALL', value: string, rerender = true): void {
  const split = splitByPowerHeaders(value, GREAT_POWERS);
  if (tab === 'ALL') {
    app.allText = value;
    app.orderText = emptyText();
    if (split) for (const [p, t] of split) app.orderText[p] = t;
    else if (value.trim()) app.say('Add `France:` style headers so orders can be attributed.');
  } else if (split) {
    // a whole dump pasted into one power's box — distribute it and switch to All
    app.orderText = emptyText();
    for (const [p, t] of split) app.orderText[p] = t;
    app.activeTab = 'ALL';
    app.allText = value;
  } else {
    app.orderText[tab] = value;
    app.allText = combinedText(app);
  }
  app.persist();
  if (rerender) app.render();
}

/** Select the offending line in the textarea so the GM can retype it in place. */
function selectLine(app: App, line: string): void {
  const ta = app.ta;
  if (!ta) return;
  const needle = line.trim();
  ta.focus();
  if (!needle) return;
  const idx = ta.value.indexOf(needle);
  if (idx >= 0) ta.setSelectionRange(idx, idx + needle.length);
}

// ---------- the entry section ----------

/** Tabs, mode bar, textarea, problems, readiness, and the Adjudicate button. */
export function entrySection(app: App): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (app.state.phase === 'ADJUSTMENT') out.push(adjustmentTable(app));
  out.push(tabBar(app));
  out.push(modeBar(app));

  const tab = app.activeTab;
  const text = tab === 'ALL' ? app.allText : (app.orderText[tab] ?? '');
  const ta = orderTextarea(app);
  ta.setAttribute('aria-label', tab === 'ALL' ? 'All orders' : `${powerTitle(tab)} orders`);
  ta.setAttribute('placeholder', placeholderFor(app, tab));
  // Never write into the box the GM is typing in: their keystrokes are the truth while
  // it has focus, and assigning `.value` would stomp the caret even when the string
  // happens to match. The exception is a change the model made itself (a map click, a
  // tab switch, an adjudication clearing the box), flagged by `pushTextToBox`.
  const focused = document.activeElement === ta;
  if ((app.pushTextToBox || !focused) && ta.value !== text) {
    ta.value = text;
    if (focused) {
      ta.setSelectionRange(text.length, text.length);
      app.caretMoved = true;
    }
  }
  app.pushTextToBox = false;
  app.taTab = tab;
  out.push(ta);

  out.push(errorList(app, tab));
  out.push(warningList(app, tab));
  out.push(readinessStrip(app));

  const errors = readiness(app).reduce((n, r) => n + r.errors, 0);
  const verb =
    app.state.phase === 'RETREAT'
      ? 'Resolve retreats'
      : app.state.phase === 'ADJUSTMENT'
        ? 'Resolve adjustments'
        : app.state.phase === 'SPAWN_CHOICE'
          ? 'Confirm spawns'
          : 'Adjudicate';
  const go = el('button', { class: `adjudicate${errors ? ' has-errors' : ''}` }, [
    errors ? `${verb} (${errors} error${errors === 1 ? '' : 's'})` : verb,
    el('span', { class: 'keycap-hint' }, ['⌘↵']),
  ]);
  go.addEventListener('click', () => app.adjudicate());
  out.push(go);
  return out;
}

function placeholderFor(app: App, tab: Power | 'ALL'): string {
  const dump = (body: string) => `Place the orders:\n\n${body}`;
  switch (app.state.phase) {
    case 'RETREAT':
      return tab === 'ALL'
        ? dump('France:\nA Bur - Mar\n\nGermany:\nF Kie D')
        : 'A Bur - Mar\nF Kie D          (disband)';
    case 'ADJUSTMENT':
      return tab === 'ALL'
        ? dump('France:\nBuild A Par\nBuild F Bre\n\nGermany:\nRemove A Mun')
        : 'Build A Par\nBuild F Bre/…\nRemove A Mun\nWaive';
    case 'SPAWN_CHOICE':
      return tab === 'ALL'
        ? dump('England:\nBuild F Edi\n\nRussia:\nBuild F Stp/nc')
        : 'Build F Edi\nBuild A Edi\nBuild F Stp/nc';
    default:
      return tab === 'ALL'
        ? dump('France:\nA Par - Bur\nF Bre - MAO\n\nGermany:\nA Mun - Ruh')
        : 'A Par - Bur\nF Bre - MAO\nA Mar S A Par - Bur';
  }
}

/** WINTER: SC / unit counts and each power's allowance. */
function adjustmentTable(app: App): HTMLElement {
  const box = el('div', { class: 'counts' });
  box.append(el('div', { class: 'counts-head' }, ['Centres / units — builds due']));
  for (const c of powerCounts(app.state)) {
    const row = el('div', { class: `count-row${c.delta === 0 ? '' : c.delta > 0 ? ' up' : ' down'}` });
    row.style.setProperty('--chip', POWER_COLORS[c.power].unit);
    row.append(
      el('span', { class: 'count-name' }, [app.nameOf(c.power)]),
      el('span', { class: 'count-num' }, [countChip(c)]),
      el('span', { class: 'count-delta' }, [deltaText(c)]),
    );
    box.append(row);
  }
  return box;
}

function tabBar(app: App): HTMLElement {
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const editHandle = (id: Power) => {
    const cur = app.state.labels?.[id] ?? '';
    const next = prompt(`Player handle for ${powerTitle(id)}:`, cur);
    if (next === null) return;
    app.state = {
      ...app.state,
      labels: { ...(app.state.labels ?? {}), [id]: next.trim() || undefined },
    };
    app.persist();
    app.render();
  };
  const mk = (id: Power | 'ALL', label: string, color?: string) => {
    const active = app.activeTab === id;
    const b = el('button', {
      class: `tab${active ? ' active' : ''}`,
      role: 'tab',
      'aria-selected': String(active),
    }, [el('span', { class: 'tab-label' }, [label])]);
    if (color) b.style.setProperty('--chip', color);
    b.addEventListener('click', () => {
      app.flushText();
      app.activeTab = id;
      if (id === 'ALL') app.allText = combinedText(app);
      app.render();
    });
    if (id !== 'ALL') {
      b.title = 'Click to select; ✎ (or double-click) to set the player handle';
      const pencil = el('span', { class: 'tab-pencil', title: 'Set player handle' }, ['✎']);
      pencil.addEventListener('click', (e) => {
        e.stopPropagation();
        editHandle(id);
      });
      b.append(pencil);
      b.addEventListener('dblclick', () => editHandle(id));
    }
    return b;
  };
  bar.append(mk('ALL', 'All'));
  const counts = new Map(powerCounts(app.state).map((c) => [c.power, c]));
  for (const p of GREAT_POWERS) {
    const parsed = app.parsedFor(p);
    const c = counts.get(p);
    const suffix =
      app.state.phase === 'ADJUSTMENT' && c
        ? ` ${countChip(c)}`
        : parsed.orders.length
          ? ` ${parsed.orders.length}`
          : '';
    const tab = mk(p, `${app.nameOf(p)}${suffix}`, POWER_COLORS[p].unit);
    if (parsed.errors.length) {
      tab.append(el('span', { class: 'tab-errors', title: 'parse errors' }, [String(parsed.errors.length)]));
    }
    bar.append(tab);
  }
  return bar;
}

function modeBar(app: App): HTMLElement {
  if (app.state.phase !== 'MOVEMENT') {
    const hint =
      app.state.phase === 'RETREAT'
        ? 'Click a dislodged unit, then its destination (or itself to disband).'
        : app.state.phase === 'SPAWN_CHOICE'
          ? 'Use the buttons above, or type the decisions here — they are the same lines.'
          : 'Click an empty home centre to build, or one of your units to remove it.';
    return el('div', { class: 'modes hint' }, [hint]);
  }
  const bar = el('div', { class: 'modes' }, [el('span', { class: 'group-label' }, ['Map entry'])]);
  const modes: [ClickMode, string, string][] = [
    ['move', 'Move', 'M'],
    ['support', 'Support', 'S'],
    ['convoy', 'Convoy', 'C'],
  ];
  for (const [m, label, key] of modes) {
    const b = el(
      'button',
      {
        class: `mode${app.clicks.mode === m ? ' active' : ''}`,
        'aria-pressed': String(app.clicks.mode === m),
        title: `Shortcut: ${key}`,
      },
      [label, el('span', { class: 'keycap' }, [key])],
    );
    b.addEventListener('click', () => app.setMode(m));
    bar.append(b);
  }
  const hint =
    app.clicks.mode === 'move'
      ? 'Click a unit, then its destination (or itself to hold).'
      : app.clicks.mode === 'support'
        ? 'Click the supporting unit, the supported unit, then its destination (or itself for a hold).'
        : 'Click the convoying fleet, the army, then the army’s destination.';
  bar.append(el('span', { class: 'hint' }, [hint]));
  return bar;
}

/** Non-fatal problems: over-builds, illegal sites, owed removals, unordered retreats. */
function warningList(app: App, tab: Power | 'ALL'): HTMLElement {
  const box = el('div', { class: 'warnings' });
  const show = (p: Power) => tab === 'ALL' || tab === p;
  if (app.state.phase === 'ADJUSTMENT') {
    for (const w of adjustmentWarnings(app.state, app.map, app.ordersByPower())) {
      if (show(w.power)) box.append(el('div', { class: 'warn' }, [w.message]));
    }
  } else if (app.state.phase === 'RETREAT') {
    const rows = retreatRows(app.state, app.ordersByPower()).filter((r) => show(r.power));
    if (rows.length) {
      box.append(el('div', { class: 'warn-head' }, ['Dislodged units']));
      for (const r of rows) {
        box.append(el('div', { class: `warn${r.ordered ? ' done' : ''}` }, [r.text]));
      }
    }
  }
  return box;
}

function errorList(app: App, tab: Power | 'ALL'): HTMLElement {
  const powers = tab === 'ALL' ? GREAT_POWERS : [tab];
  const box = el('div', { class: 'errors' });
  for (const p of powers) {
    for (const e of app.parsedFor(p).errors) {
      const row = el('button', {
        class: `err${e.kind === 'coast' ? ' err-coast' : ''}`,
        title:
          e.kind === 'coast'
            ? 'The line parsed; its coast is wrong or missing, so this order will be voided'
            : 'Show this line in the orders box',
      }, [
        ...(tab === 'ALL' ? [el('span', { class: 'err-power' }, [app.nameOf(p)])] : []),
        el('code', {}, [e.line.trim() || '(blank)']),
        el('span', { class: 'err-msg' }, [e.message]),
      ]);
      row.style.setProperty('--chip', POWER_COLORS[p].unit);
      row.addEventListener('click', () => {
        if (tab !== 'ALL' && tab !== p) {
          app.activeTab = p;
          app.render();
        }
        selectLine(app, e.line);
      });
      box.append(row);
    }
  }
  return box;
}

/**
 * The seven-power readiness strip: who has sent orders, how many parsed, how many
 * lines are broken. Replaces the wall of comma-separated unordered provinces — those
 * are still one click away, per power.
 */
function readinessStrip(app: App): HTMLElement {
  const box = el('div', { class: 'readiness' });
  const strip = el('div', { class: 'ready-chips' });
  for (const r of readiness(app)) {
    const state = r.errors ? 'errors' : r.orders ? 'ok' : r.owes ? 'none' : 'idle';
    const chip = el('button', {
      class: `ready-chip ready-${state}${app.expandedPower === r.power ? ' open' : ''}`,
      'aria-expanded': String(app.expandedPower === r.power),
      title:
        state === 'errors'
          ? problemSummary(r)
          : state === 'none'
            ? 'nothing received'
            : state === 'idle'
              ? 'nothing owed this phase'
              : `${r.orders} order${r.orders === 1 ? '' : 's'} parsed`,
    }, [
      el('span', { class: 'ready-init' }, [POWER_INITIAL[r.power]]),
      el('span', { class: 'ready-count' }, [
        // Never more ordered than there are units to order: two orders for one unit is
        // one unit ordered (plus an error), not two.
        app.state.phase === 'MOVEMENT'
          ? `${Math.min(r.orders, r.units)}/${r.units}`
          : String(r.orders),
      ]),
    ]);
    chip.style.setProperty('--chip', POWER_COLORS[r.power].unit);
    if (r.errors) chip.append(el('span', { class: 'ready-badge' }, [String(r.errors)]));
    chip.addEventListener('click', () => {
      app.expandedPower = app.expandedPower === r.power ? null : r.power;
      app.render();
    });
    strip.append(chip);
  }
  box.append(strip);

  const open = app.expandedPower;
  if (open) {
    const r = readiness(app).find((x) => x.power === open)!;
    const detail = el('div', { class: 'ready-detail' });
    detail.append(el('div', { class: 'ready-detail-head' }, [app.nameOf(open)]));
    if (!r.orders) detail.append(el('div', {}, ['Nothing received.']));
    if (r.unordered.length) {
      detail.append(
        el('div', {}, [
          `No order (will hold): ${r.unordered.map((u) => `${u.type} ${locText(u.loc)}`).join(', ')}`,
        ]),
      );
    } else if (r.orders && !r.duplicates.length) {
      detail.append(el('div', { class: 'ok' }, ['Every unit ordered.']));
    }
    for (const d of r.duplicates) {
      detail.append(
        el('div', { class: 'ready-err' }, [
          `${d.type} ${locText(d.loc)}: ${d.count} orders, using the last.`,
        ]),
      );
    }
    for (const e of app.parsedFor(open).errors) {
      if (e.kind === 'duplicate') continue; // already spelled out above
      detail.append(el('div', { class: 'ready-err' }, [`“${e.line.trim() || '(blank)'}” — ${e.message}`]));
    }
    box.append(detail);
  } else if (app.state.phase === 'MOVEMENT') {
    const missing = unitsWithoutOrders(app).length;
    box.append(
      el('div', { class: `ready-note${missing ? '' : ' ok'}` }, [
        missing
          ? `${missing} unit${missing === 1 ? '' : 's'} without orders — tap a power for detail.`
          : 'All units ordered.',
      ]),
    );
  }
  return box;
}

/**
 * The classic failure is a truncated paste: two lines don't parse, five units
 * quietly hold, and nobody notices until next phase. Spell all of it out before
 * committing rather than trusting undo to catch it.
 */
export function confirmAdjudicate(app: App, ready: Readiness[]): void {
  const errored = ready.filter((r) => r.errors);
  const silent = ready.filter((r) => r.orders === 0 && r.owes);
  const unordered = ready.filter((r) => r.unordered.length);
  const duped = ready.filter((r) => r.duplicates.length);
  showModal(app, 'Adjudicate with problems?', (close) => {
    const body: HTMLElement[] = [];
    const section = (head: string, rows: string[]) => {
      if (!rows.length) return;
      body.push(el('div', { class: 'confirm-head' }, [head]));
      for (const r of rows) body.push(el('div', { class: 'confirm-row' }, [r]));
    };
    const listing = (kind: 'coast' | 'other') =>
      errored.flatMap((r) =>
        app
          .parsedFor(r.power)
          .errors.filter((e) =>
            e.kind === 'duplicate' ? false : kind === 'coast' ? e.kind === 'coast' : e.kind !== 'coast',
          )
          .map((e) => `${app.nameOf(r.power)}: “${e.line.trim() || '(blank)'}” — ${e.message}`),
      );
    const broken = listing('other');
    const coasts = listing('coast');
    section(`Lines that didn't parse (${broken.length})`, broken);
    // Kept orders, not rejected lines: they reach the adjudicator and it voids them there.
    section(`Orders the coast will void (${coasts.length})`, coasts);
    section(
      'Units given more than one order (only the last is used)',
      duped.flatMap((r) =>
        r.duplicates.map(
          (d) => `${app.nameOf(r.power)}: ${d.type} ${locText(d.loc)} — ${d.count} orders`,
        ),
      ),
    );
    section(
      'Nothing received from',
      silent.map((r) => app.nameOf(r.power)),
    );
    if (app.state.phase === 'MOVEMENT') {
      section(
        'Units with no order (they will hold)',
        unordered.map(
          (r) => `${app.nameOf(r.power)}: ${r.unordered.map((u) => `${u.type} ${locText(u.loc)}`).join(', ')}`,
        ),
      );
    }
    const spawning = app.state.phase === 'SPAWN_CHOICE';
    if (spawning) {
      section(
        'Spawns with no choice (they will default to armies)',
        app.undecidedSpawns().map((e) => `${app.nameOf(e.power)}: ${app.provName(e.province)}`),
      );
    }
    const go = el('button', { class: 'big adjudicate' }, [
      spawning ? 'Confirm spawns anyway' : 'Adjudicate anyway',
    ]);
    go.addEventListener('click', () => {
      close();
      if (spawning) app.commitSpawnChoices();
      else app.commitAdjudication();
    });
    body.push(go);
    return body;
  }, { cancelLabel: 'Back' });
}
