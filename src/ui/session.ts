import type { LifeResult, PhaseRecord, Power, Variant } from '../engine/types.js';
import { GREAT_POWERS } from '../engine/types.js';
import { initialState, lifeStepLabel, nextPhaseLabel } from './api.js';
import type { App } from './main.js';
import { askUndo, showCopyText, showModal, helpModal, rulesModal } from './modals.js';
import { emptyText } from './order-entry.js';
import {
  copyPng,
  createGame,
  deleteGame,
  downloadJson,
  downloadPng,
  duplicateGame,
  listGames,
  loadGame,
  pickJsonFile,
  renameGame,
  saveGame,
  saveSandbox,
  setCurrentGameId,
  shareUrl,
  isOffline,
  SHARE_LINK_WARN_AT,
  type OrderDraft,
  type SavedGame,
} from './persist.js';
import type { HistoryView } from './history-views.js';
import { lifeReportText, reportText } from './report.js';
import { RULES_TITLE } from './rules-text.js';
import { el } from './svg.js';

// ---------- the saved-game slot ----------

export function draft(app: App): OrderDraft {
  return { orderText: { ...app.orderText }, allText: app.allText, activeTab: app.activeTab };
}

export function applyDraft(app: App, saved: OrderDraft | undefined): void {
  if (!saved) return;
  const text = emptyText();
  for (const p of [...GREAT_POWERS, 'NEUTRAL'] as Power[]) {
    text[p] = saved.orderText?.[p] ?? '';
  }
  app.orderText = text;
  app.allText = saved.allText ?? '';
  const tab = saved.activeTab as Power | 'ALL' | undefined;
  if (tab === 'ALL' || (tab && GREAT_POWERS.includes(tab))) app.activeTab = tab;
}

export function snapshot(app: App): SavedGame {
  return { state: app.state, history: app.history, title: app.title, draft: draft(app) };
}

/**
 * Autosave into the *current game's* slot. A sandbox copy from a share link has its own
 * single scratch slot and can never overwrite a saved game; a session with no game yet
 * (a fresh browser) registers one on its first write, so nothing is ever held only in
 * memory.
 */
export function persist(app: App): void {
  const game = snapshot(app);
  if (app.sandbox) {
    saveSandbox(game);
    return;
  }
  if (!app.gameId) app.gameId = createGame(game, nextPhaseLabel(app.state));
  else saveGame(app.gameId, game, nextPhaseLabel(app.state));
}

export function load(app: App, game: SavedGame): void {
  app.state = game.state;
  app.history = game.history ?? [];
  app.future = [];
  app.orderText = emptyText();
  app.allText = '';
  app.activeTab = 'ALL';
  applyDraft(app, game.draft);
  app.viewIndex = null;
  app.landedOnAdjudication = false;
  app.title = game.title ?? app.title;
  app.entryOpen = !app.history.length || app.orderEntryStarted;
  app.persist();
  app.render();
}

/**
 * A new game is a new slot, never an overwrite: whatever the GM was running stays in
 * the games list exactly as it was, and this one is added beside it.
 */
export function newGame(app: App): void {
  showModal(app, 'New game', (close) => {
    const name = el('input', {
      class: 'text-input',
      placeholder: 'Game name (optional)',
      'aria-label': 'Game name',
    }) as HTMLInputElement;
    const start = (variant: Variant) => {
      close();
      app.flushText();
      if (!app.sandbox) app.persist(); // bank the outgoing game before switching away
      app.state = initialState(app.map, variant);
      app.history = [];
      app.future = [];
      app.orderText = emptyText();
      app.allText = '';
      app.viewIndex = null;
      app.landedOnAdjudication = false;
      app.lifeOpen = false;
      app.lifePreview = false;
      app.entryOpen = true;
      app.title = name.value.trim();
      app.sandbox = false;
      app.bannerDismissed = false;
      app.gameId = createGame(snapshot(app), nextPhaseLabel(app.state));
      app.render();
      app.say('New game started — the previous one is still in Games.');
    };
    const conway = el('button', { class: 'big' }, ["Conway's Game of Diplomacy"]);
    conway.addEventListener('click', () => start('conway'));
    const std = el('button', { class: 'big' }, ['Standard Diplomacy']);
    std.addEventListener('click', () => start('standard'));
    setTimeout(() => name.focus(), 0);
    return [
      name,
      conway,
      el('p', { class: 'hint' }, ['Standard turns the Life step off entirely — plain Diplomacy.']),
      std,
    ];
  });
}

/** The games drawer: open / rename / duplicate / delete, plus a New button. */
export function gamesMenu(app: App): void {
  showModal(app, 'Games in this browser', (close) => {
    const out: HTMLElement[] = [];
    const rows = listGames();
    if (!rows.length) out.push(el('p', { class: 'hint' }, ['No saved games yet.']));
    for (const g of rows) {
      const row = el('div', { class: `game-row${g.id === app.gameId ? ' current' : ''}` });
      const open = el('button', { class: 'game-open' }, [
        el('span', { class: 'game-title' }, [g.title || 'untitled game']),
        el('span', { class: 'game-meta' }, [
          `${g.phaseLabel || '—'} · ${relativeTime(g.updatedAt)}${g.id === app.gameId ? ' · open' : ''}`,
        ]),
      ]);
      open.addEventListener('click', () => {
        if (g.id === app.gameId && !app.sandbox) return close();
        const saved = loadGame(g.id);
        if (!saved) return app.say('That game could not be read.');
        close();
        app.flushText();
        if (!app.sandbox) app.persist();
        app.sandbox = false;
        app.gameId = g.id;
        setCurrentGameId(g.id);
        load(app, saved);
      });
      const act = (label: string, tip: string, fn: () => void) => {
        const b = el('button', { class: 'ghost small', title: tip, 'aria-label': `${tip}` }, [label]);
        b.addEventListener('click', fn);
        return b;
      };
      row.append(
        open,
        act('rename', `Rename ${g.title || 'untitled game'}`, () => {
          const next = prompt('Game name:', g.title);
          if (next === null) return;
          renameGame(g.id, next.trim());
          if (g.id === app.gameId) app.title = next.trim();
          close();
          app.render();
          gamesMenu(app);
        }),
        act('duplicate', `Duplicate ${g.title || 'untitled game'}`, () => {
          duplicateGame(g.id);
          close();
          gamesMenu(app);
        }),
        act('delete', `Delete ${g.title || 'untitled game'}`, () => {
          if (!confirm(`Delete “${g.title || 'untitled game'}” and its history? This cannot be undone.`)) return;
          deleteGame(g.id);
          if (g.id === app.gameId) app.gameId = null;
          close();
          gamesMenu(app);
        }),
      );
      out.push(row);
    }
    const add = el('button', { class: 'big' }, ['New game…']);
    add.addEventListener('click', () => {
      close();
      newGame(app);
    });
    out.push(add);
    return out;
  });
}

/**
 * The ⋯ menu: undo/redo, plus everything that acts on the game *file* rather than on the
 * board. Undo lives here because it is the one board action too destructive to spend a
 * bare glyph on.
 */
export function moreMenu(app: App): void {
  showModal(app, 'Game', (close) => {
    const item = (label: string, hint: string, fn: () => void) => {
      const b = el('button', { class: 'big' }, [label]);
      b.addEventListener('click', () => {
        close();
        fn();
      });
      return [b, el('p', { class: 'hint' }, [hint])];
    };
    const out: HTMLElement[] = [];
    // Undo and redo are spelled out here rather than sitting on a glyph in the history
    // bar, where they read as previous/next beside the phase picker.
    if (app.canUndo) {
      out.push(
        ...item(
          `Undo last adjudication (⌘Z)`,
          `Take back ${app.undoLabel()} — its orders come back to the box, its result is discarded.`,
          () => askUndo(app),
        ),
      );
    }
    if (app.canRedo) {
      out.push(
        ...item('Redo (⇧⌘Z)', 'Put back the adjudication you just undid.', () => app.redo()),
      );
    }
    out.push(
      ...item(RULES_TITLE, 'The Life step, neutrals, edge cases and this tool\'s own rulings.', () =>
        rulesModal(app),
      ),
    );
    out.push(
      ...item('Export JSON', 'The whole session: board, history, title and any drafts.', () => {
        app.flushText();
        downloadJson(
          { state: app.state, history: app.history, title: app.title, draft: draft(app) },
          `${filenameStem(app)}.json`,
        );
      }),
    );
    out.push(
      ...item('Import JSON', 'Replace what is on screen with a saved session.', () => {
        void pickJsonFile()
          .then((g) => load(app, g))
          .catch((e) => app.say(e instanceof Error ? e.message : String(e)));
      }),
    );
    out.push(
      ...item('Games', 'Switch between the games saved in this browser.', () => gamesMenu(app)),
    );
    out.push(
      ...item('How to run a game', 'The first-run instructions, any time you want them back.', () =>
        helpModal(app),
      ),
    );
    out.push(
      ...item('New game', 'Start a fresh 1901 board — kept beside the current one, not over it.', () =>
        newGame(app),
      ),
    );
    return out;
  });
}

// ---------- sharing: report text, share links, board images ----------

/**
 * Copy the report for one history entry, or for the phase just adjudicated when `view`
 * is null. A Life entry reports its births and deaths and nothing else — its orders
 * belong to the phase entry beside it, which reports them without the Life list.
 */
export function copyResults(app: App, view: HistoryView | null): void {
  app.flushText();
  const record = view?.record ?? app.history[app.history.length - 1];
  if (!record) return;
  const label = view?.label ?? nextPhaseLabel(record.before);
  const text =
    view?.kind === 'life'
      ? lifeReportText(label, record.life ?? { units: [], events: [], pending: [] })
      : reportText(label, record, view ? null : undefined);
  const fallback = () => showCopyText(app, `${label} — results`, text);
  const p = navigator.clipboard?.writeText(text);
  if (!p) return fallback();
  p.then(() => app.say('Results copied.')).catch(fallback);
}

export async function copyShareLink(app: App): Promise<void> {
  app.flushText();
  let url: string;
  try {
    url = await shareUrl(app.viewedState());
  } catch (e) {
    app.say(`Could not build a share link: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const tooLong = url.length > SHARE_LINK_WARN_AT;
  const note = tooLong
    ? ` — ${url.length} chars, too long to paste comfortably in chat (limit 2000); export JSON instead.`
    : ` (${url.length} chars)`;
  // An offline copy has no address anyone else can open, so the link points at the
  // hosted app; say so, or it looks like the wrong link was copied.
  const where = isOffline() ? ' — it opens the board on the web' : '';
  try {
    await navigator.clipboard?.writeText(url);
    app.say(`Share link copied${where}${note}`);
  } catch {
    location.hash = url.slice(url.indexOf('#'));
    app.say(`Share link is in the address bar${note}`);
  }
}

export function filenameStem(app: App): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const t = slug(app.title || 'conway-diplomacy');
  // A history entry names itself — "…-summer-1901-life" — because two entries can share
  // one board's season and phase, and the file is the only label the image keeps.
  const view = app.viewedView();
  if (view) return `${t}-${slug(view.label)}`;
  const s = app.state;
  return `${t}-${s.season.charAt(0)}${s.year}${s.phase.charAt(0)}`;
}

/**
 * The caption, legend and Life summary are baked into the SVG only for export, so the
 * shared image explains its own symbols without doubling up with the on-screen header.
 */
export async function exportPng(app: App): Promise<void> {
  await withExportBoard(app, async () => {
    await downloadPng(app.board.svg, `${filenameStem(app)}.png`);
    app.say('Board PNG downloaded.');
  });
}

/**
 * Copy the board image straight to the clipboard — the group-chat workflow is paste, not
 * download-then-attach. `copyPng` hands `ClipboardItem` an unresolved blob promise so
 * the write stays inside this click's task (Safari drops it otherwise); the whole call
 * therefore has to be started before the board is rendered back to its normal state,
 * which is what `withExportBoard`'s `await` gives us.
 */
export async function copyBoardPng(app: App): Promise<void> {
  await withExportBoard(app, async () => {
    try {
      await copyPng(app.board.svg);
      app.say('Board image copied — paste it wherever your players are.');
    } catch (e) {
      // Firefox and older Safari can't put an image on the clipboard at all.
      await downloadPng(app.board.svg, `${filenameStem(app)}.png`);
      app.say(`This browser can’t copy images (${e instanceof Error ? e.message : e}) — downloaded it instead.`);
    }
  });
}

/**
 * Run `fn` with the board rendered as it should be exported: full extent, caption, and
 * the arrows/Life marks included or left off per the HUD's Orders toggle.
 */
async function withExportBoard(app: App, fn: () => Promise<void>): Promise<void> {
  app.flushText();
  const vb = app.board.svg.getAttribute('viewBox');
  app.board.resetViewBox();
  app.render({ caption: true, marks: app.exportMarks });
  try {
    await fn();
  } catch (e) {
    app.say(String(e instanceof Error ? e.message : e));
  } finally {
    if (vb) app.board.svg.setAttribute('viewBox', vb);
    app.render();
  }
}

/** "2 deaths, 1 birth" — what a Life step did, for a caption or a toast. */
export function lifeCountsText(life: LifeResult): string {
  const deaths = life.events.filter((e) => e.kind === 'death').length;
  const births = life.events.length - deaths;
  const bits: string[] = [];
  if (deaths) bits.push(`${deaths} death${deaths === 1 ? '' : 's'}`);
  if (births) bits.push(`${births} birth${births === 1 ? '' : 's'}`);
  return bits.join(', ');
}

/** "Summer 1901 Life: 2 deaths, 1 birth" for the exported margin, or undefined when none ran. */
export function lifeSummaryText(record: PhaseRecord | null | undefined): string | undefined {
  const life = record?.life;
  if (!life?.events.length) return undefined;
  return `${lifeStepLabel(record!.before)}: ${lifeCountsText(life)}`;
}

/** "3 min ago" / "yesterday" for the games list — an exact timestamp helps nobody here. */
function relativeTime(then: number): string {
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}
