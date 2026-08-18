import type { LifeResult, PhaseRecord, UnitType } from '../engine/types.js';
import { lifeStep } from '../game/life.js';
import { lifeStepLabel, nextPhaseLabel } from './api.js';
import { POWER_COLORS } from './colors.js';
import { sheetHandle } from './gestures.js';
import type { HistoryView } from './history-views.js';
import type { App } from './main.js';
import { introCard } from './modals.js';
import { entrySection } from './order-entry.js';
import { canCopyImage, createGame } from './persist.js';
import { lifeLineText, resultGroups } from './report.js';
import { copyBoardPng, copyResults, exportPng, snapshot } from './session.js';
import { clear, el } from './svg.js';

/**
 * The panel column: results, the Life list, the spawn choices, and the order entry
 * section from `order-entry.ts`. Rebuilt wholesale on every render.
 */
export function renderPanel(app: App): void {
  // The panel is rebuilt wholesale on every render; carry the caret and the scroll
  // position across so typing (which triggers a re-render) doesn't jump.
  const prev = app.ta;
  const hadFocus = !!prev && document.activeElement === prev;
  const caret: [number, number] = [prev?.selectionStart ?? 0, prev?.selectionEnd ?? 0];
  const taScroll = prev?.scrollTop ?? 0;
  const scrollTop = app.panel.scrollTop;
  // Removing a focused node blurs it, so focus/caret/scroll are put back once the
  // panel is fully populated — never on a detached element, which is a silent no-op.
  const restore = () => {
    app.panel.scrollTop = scrollTop;
    const ta = app.ta;
    if (!hadFocus || !ta?.isConnected) return;
    ta.focus({ preventScroll: true });
    // Skip when the box was just rewritten from the model: its caret is already
    // where it should be (the end of the new text), not where the old one was.
    if (!app.caretMoved) ta.setSelectionRange(caret[0], caret[1]);
    app.caretMoved = false;
    ta.scrollTop = taScroll;
  };

  clear(app.panel);
  if (app.mobile) app.panel.append(sheetHandle(app));
  if (app.sandbox && !app.bannerDismissed) app.panel.append(sandboxBanner(app));

  // A history entry reports itself and nothing else: a phase entry its orders and their
  // results, a Life entry its births and deaths. The order box stays below it, so
  // stepping back through the history never hides the draft being typed.
  const view = app.viewedView();
  if (view) {
    app.panel.append(historyEntryPanel(app, view));
    app.panel.append(...entrySection(app));
    restore();
    return;
  }

  if (app.state.phase === 'SPAWN_CHOICE') {
    app.panel.append(spawnChoiceRows(app));
    app.panel.append(...entrySection(app));
    const life = lifeSummary(app);
    if (life) app.panel.append(life);
    const results = resultsPanel(app);
    if (results) app.panel.append(results);
    restore();
    return;
  }

  const record = app.history[app.history.length - 1];
  const fresh = app.isCurrentRecord(record) && !app.orderEntryStarted;

  if (fresh) {
    // Results are the product: they go on top, with the two share actions together.
    const results = resultsPanel(app);
    if (results) app.panel.append(results);
    const life = lifeSummary(app);
    if (life) app.panel.append(life);
  }

  if (showIntro(app)) app.panel.append(introCard(app));

  if (fresh && !app.entryOpen) {
    const open = el('button', { class: 'expand-entry' }, [
      `Enter ${nextPhaseLabel(app.state)} orders`,
    ]);
    open.addEventListener('click', () => {
      app.entryOpen = true;
      app.render();
      app.ta?.focus();
    });
    app.panel.append(open);
  } else {
    app.panel.append(...entrySection(app));
    if (!fresh) {
      const life = lifeSummary(app);
      if (life) app.panel.append(life);
      const results = resultsPanel(app);
      if (results) app.panel.append(results);
    }
  }
  restore();
}

function showIntro(app: App): boolean {
  return !app.introDismissed && !app.history.length && !app.sandbox;
}

/**
 * Lives in the panel, not over the map. Dismissing it only hides the strip — the copy
 * stays a copy, and keeps saving to its own slot, until the visitor explicitly adopts it.
 */
function sandboxBanner(app: App): HTMLElement {
  const banner = el('div', { class: 'sandbox-banner' }, [
    el('span', {}, ['Sandbox — this is a copy; changes here don’t affect the GM’s games.']),
  ]);
  const adopt = el('button', { class: 'ghost small' }, ['Save as a new game']);
  adopt.addEventListener('click', () => {
    if (!confirm('Save this board as a new game in this browser?')) return;
    app.sandbox = false;
    app.bannerDismissed = true;
    app.gameId = createGame(snapshot(app), nextPhaseLabel(app.state));
    app.say('Saved — this board is now a game of its own.');
    app.render();
  });
  const x = el('button', { class: 'ghost small', 'aria-label': 'Dismiss sandbox notice' }, ['dismiss']);
  x.addEventListener('click', () => {
    app.bannerDismissed = true;
    app.render();
  });
  banner.append(adopt, x);
  return banner;
}

/**
 * The share row under a report: the two outputs that reach the players, plus what the
 * image carries. "board only" exports the same view without its arrows and Life marks —
 * the position on its own, for a player who wants to plan on it.
 */
function shareGroup(app: App, view: HistoryView | null): HTMLElement {
  const post = el('div', { class: 'post-group' });
  post.append(el('span', { class: 'group-label' }, ['Share results']));
  const copy = el('button', { class: 'post-action' }, ['Copy results']);
  copy.addEventListener('click', () => copyResults(app, view));
  const png = el('button', { class: 'post-action' }, [canCopyImage() ? 'Copy PNG' : 'Save PNG']);
  png.addEventListener('click', () => void (canCopyImage() ? copyBoardPng(app) : exportPng(app)));
  const marks = el('button', {
    class: 'ghost small',
    title: 'What the exported image carries: the order arrows and Life marks, or the bare board',
  }, [app.exportMarks ? 'with orders' : 'board only']);
  marks.addEventListener('click', () => {
    app.exportMarks = !app.exportMarks;
    app.render();
  });
  post.append(copy, png, marks);
  return post;
}

/** The report for one history entry: its own orders and results, or its own Life list. */
function historyEntryPanel(app: App, view: HistoryView): HTMLElement {
  if (view.kind === 'life') {
    const life = view.record.life ?? { units: [], events: [], pending: [] };
    const box = el('div', { class: 'life-panel' });
    box.append(el('div', { class: 'life-head' }, [el('strong', {}, [view.label])]));
    box.append(shareGroup(app, view));
    const list = el('ul', { class: 'life-list' });
    for (const ev of life.events) list.append(el('li', {}, [lifeLineText(ev)]));
    if (!life.events.length) list.append(el('li', {}, ['No births or deaths.']));
    box.append(list);
    return box;
  }
  return resultsBox(app, view.record, view.label, view, false);
}

/** Text cross-check of the phase just adjudicated, with the share actions attached. */
function resultsPanel(app: App): HTMLElement | null {
  const record = app.history[app.history.length - 1];
  if (!record || !app.isCurrentRecord(record)) return null;
  const groups = resultGroups(record);
  if (!groups.length && !record.life) return null;
  return resultsBox(app, record, nextPhaseLabel(record.before), null, true);
}

function resultsBox(
  app: App,
  record: PhaseRecord,
  label: string,
  view: HistoryView | null,
  withLife: boolean,
): HTMLElement {
  const groups = resultGroups(record);
  const box = el('div', { class: 'results-panel' });
  box.append(el('div', { class: 'life-head' }, [el('strong', {}, [`${label} — results`])]));
  box.append(shareGroup(app, view));
  if (!groups.length) box.append(el('p', { class: 'hint' }, ['No orders were given.']));

  for (const g of groups) {
    const grp = el('div', { class: 'result-group' });
    const dot = el('span', { class: 'result-dot' });
    dot.style.background = POWER_COLORS[g.power].unit;
    grp.append(el('div', { class: 'result-power' }, [dot, app.nameOf(g.power)]));
    for (const r of g.rows) {
      grp.append(
        el('div', { class: 'result-row' }, [
          el('code', {}, [r.text]),
          ...r.results.map((res) => el('span', { class: `res res-${res}` }, [res])),
          ...r.notes.map((n) => el('span', { class: 'res-note' }, [`(${n})`])),
        ]),
      );
    }
    box.append(grp);
  }
  // The Life list is only repeated here when the dedicated Life panel is hidden.
  if (withLife && record.life?.events.length && !app.lifeOpen) {
    const grp = el('div', { class: 'result-group' });
    grp.append(el('div', { class: 'result-power' }, [lifeStepLabel(record.before)]));
    for (const ev of record.life.events) {
      grp.append(el('div', { class: 'result-row life' }, [lifeLineText(ev)]));
    }
    box.append(grp);
  }
  return box;
}

/** The Life list that matches whatever the board's Life layer is currently showing. */
function lifeSummary(app: App): HTMLElement | null {
  if (app.variant !== 'conway') return null;
  if (app.lifePreview) {
    return lifePanel(app, lifeStep(app.viewedState().units, app.map), 'Life preview', () => {
      app.lifePreview = false;
    });
  }
  const last = app.history[app.history.length - 1];
  if (!app.lifeOpen || !last?.life) return null;
  return lifePanel(app, last.life, lifeStepLabel(last.before), () => {
    app.lifeOpen = false;
  });
}

function lifePanel(app: App, life: LifeResult, heading: string, dismiss: () => void): HTMLElement {
  const box = el('div', { class: 'life-panel' });
  const head = el('div', { class: 'life-head' }, [el('strong', {}, [heading])]);
  const x = el('button', { class: 'ghost small' }, ['hide']);
  x.addEventListener('click', () => {
    dismiss();
    app.render();
  });
  head.append(x);
  box.append(head);
  const list = el('ul', { class: 'life-list' });
  for (const ev of life.events) list.append(el('li', {}, [lifeLineText(ev)]));
  if (!life.events.length) list.append(el('li', {}, ['No births or deaths.']));
  box.append(list);
  return box;
}

/**
 * The pending-birth rows. Each button writes the same `Build F Edi` line the GM could
 * have typed, so the order box stays the single record of what was decided — and the
 * decisions go into history as build orders, which is what they are.
 */
function spawnChoiceRows(app: App): HTMLElement {
  const box = el('div', { class: 'spawn-panel' });
  box.append(el('h3', {}, ['Choose spawn types']));
  box.append(
    el('p', { class: 'hint' }, [
      'Each coastal birth is an army or a fleet, chosen by its owner. Undecided births become armies.',
    ]),
  );
  const picks = app.spawnPicks();

  for (const ev of app.state.pendingBirths ?? []) {
    const row = el('div', { class: 'spawn-row' });
    const who = ev.power === 'NEUTRAL' ? 'Neutral' : app.nameOf(ev.power);
    row.append(el('span', { class: 'spawn-name' }, [`${app.provName(ev.province)} — ${who}`]));
    const coasts = app.map.provinces[ev.province]?.coasts ?? [];
    const opts: { type: UnitType; coast?: string; label: string }[] = [{ type: 'A', label: 'A' }];
    if (coasts.length) for (const c of coasts) opts.push({ type: 'F', coast: c, label: `F/${c.toUpperCase()}` });
    else opts.push({ type: 'F', label: 'F' });
    const chosen = picks.get(ev.province);
    for (const o of opts) {
      const loc = o.coast ? `${ev.province}/${o.coast}` : ev.province;
      const active = chosen?.type === o.type && chosen.loc === loc;
      const b = el('button', { class: `spawn-opt${active ? ' active' : ''}` }, [o.label]);
      b.addEventListener('click', () =>
        app.addOrder({ kind: 'build', unit: { power: ev.power, type: o.type, loc } }),
      );
      row.append(b);
    }
    box.append(row);
  }
  return box;
}
