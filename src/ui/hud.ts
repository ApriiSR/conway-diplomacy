import type { GameState } from '../engine/types.js';
import { powerTitle } from './colors.js';
import type { App } from './main.js';
import { helpModal, rulesModal } from './modals.js';
import { powerCounts } from './phase-info.js';
import { canCopyImage } from './persist.js';
import { RULES_TITLE } from './rules-text.js';
import { copyBoardPng, copyResults, copyShareLink, exportPng, gamesMenu, moreMenu } from './session.js';
import { clear, el } from './svg.js';

/**
 * The control bar sits above the map rather than floating over it, so nothing the GM
 * needs to click ever covers a province. It is one tight row at a desktop width, and
 * wraps rather than growing when there isn't room.
 */
export function renderHud(app: App): void {
  clear(app.hud);
  const viewState = app.viewedState();

  const titleInput = el('input', {
    class: 'title-input',
    placeholder: 'untitled game',
    value: app.title,
    'aria-label': 'Game title',
    title: 'Game title (drawn onto exported images)',
  }) as HTMLInputElement;
  titleInput.value = app.title;
  titleInput.addEventListener('change', () => {
    app.title = titleInput.value;
    app.persist();
    app.render();
  });

  // The bar is one fixed-height row in every phase, so the map never jumps when the
  // phase changes. Winter's builds-due summary is in the panel's counts table for that
  // reason; here the phase title carries it only as a tooltip.
  const header = el('div', { class: 'phase-header' }, [
    el('div', { class: 'phase-label' }, [app.viewLabel()]),
    titleInput,
  ]);
  if (viewState.phase === 'ADJUSTMENT') {
    header.title = adjustmentHeadline(viewState);
  }

  const btn = (label: string, fn: () => void, extra = '', tip = '') => {
    const b = el('button', { class: `tool ${extra}`.trim(), title: tip }, [label]);
    b.addEventListener('click', fn);
    return b;
  };

  // The two things that go to your players, plus the share link. Copy comes first
  // because the group-chat workflow is paste, not download-then-attach.
  const tools = el('div', { class: 'toolbar' });
  if (canCopyImage()) {
    tools.append(btn('Copy PNG', () => void copyBoardPng(app), 'primary', 'Copy the board image to the clipboard'));
    tools.append(btn('Save PNG', () => void exportPng(app), '', 'Download a 2× board image'));
  } else {
    tools.append(btn('Save PNG', () => void exportPng(app), 'primary', 'Download a 2× board image'));
  }
  // Both PNG actions export whatever board is on screen; this says whether the arrows and
  // Life marks go with it, so the same view can be shared annotated or bare.
  tools.append(
    btn(
      app.exportMarks ? 'Orders: on' : 'Orders: off',
      () => {
        app.exportMarks = !app.exportMarks;
        app.render();
      },
      app.exportMarks ? 'on' : '',
      'Include the order arrows and Life marks in exported images',
    ),
  );
  const view = app.viewedView();
  const record = app.history[app.history.length - 1];
  if (view) {
    tools.append(btn('Copy results', () => copyResults(app, view), 'primary', `Copy the ${view.label} report`));
  } else if (app.isCurrentRecord(record)) {
    tools.append(btn('Copy results', () => copyResults(app, null), 'primary', 'Copy the phase report'));
  }
  tools.append(btn('Link', () => void copyShareLink(app), '', 'Copy a sandbox link to this board'));
  if (app.variant === 'conway') {
    tools.append(
      btn(
        'Life preview',
        () => {
          app.lifePreview = !app.lifePreview;
          app.render();
        },
        app.lifePreview ? 'on' : '',
        'Mark what the Life step would do to the board as it stands',
      ),
    );
  }
  tools.append(btn('Games', () => gamesMenu(app), '', 'Switch between saved games'));
  tools.append(btn('Rules', () => rulesModal(app), '', RULES_TITLE));
  tools.append(btn('?', () => helpModal(app), '', 'How to run a game'));
  tools.append(btn('⋯', () => moreMenu(app), '', 'Rules, export, import, new game'));

  // Title left, history slider taking the slack, actions right — one row.
  app.hud.append(header);
  if (app.history.length || app.future.length) app.hud.append(historyBar(app));
  app.hud.append(tools);
}

/** Undo / redo / scrubber, grouped and labelled so the glyphs aren't cryptic. */
function historyBar(app: App): HTMLElement {
  const bar = el('div', { class: 'history-bar' }, [el('span', { class: 'group-label' }, ['History'])]);
  const step = (label: string, tip: string, enabled: boolean, fn: () => void) => {
    const b = el('button', { class: 'tool step', title: tip, 'aria-label': tip }, [label]);
    if (!enabled) b.setAttribute('disabled', '');
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    step('↶', 'Undo (⌘Z)', app.history.length > 0, () => app.undo()),
    step('↷', 'Redo (⇧⌘Z)', app.future.length > 0, () => app.redo()),
  );
  if (app.history.length) bar.append(...scrubber(app));
  return bar;
}

/**
 * Phase picker: a `<select>`, which names each entry outright and is the same width
 * whichever one is chosen, so choosing one doesn't resize the bar around it. It lists
 * *views*, not records — a phase and the Life step that followed it are two boards to
 * look at, so they are two entries.
 */
function scrubber(app: App): HTMLElement[] {
  const views = app.views();
  const max = views.length;
  const value = app.viewIndex === null ? max : app.viewIndex;
  const select = el('select', {
    class: 'scrub',
    'aria-label': 'Phase history',
    title: 'Jump to an adjudicated phase, or back to the current one',
  }) as HTMLSelectElement;
  views.forEach((v, i) => {
    select.append(el('option', { value: String(i) }, [`${i + 1}. ${v.label}`]));
  });
  select.append(el('option', { value: String(max) }, ['Current']));
  select.value = String(value);
  // `change`, not `input`: re-rendering the bar mid-interaction is what broke dragging.
  select.addEventListener('change', () => {
    const v = Number(select.value);
    app.viewIndex = v >= max ? null : v;
    app.render();
  });
  // Always present, never conditional: a label that appears only on past phases would
  // reintroduce exactly the width jump the slider was replaced for.
  return [select, el('span', { class: 'scrub-label' }, [app.live ? 'live' : 'read-only'])];
}

export function renderToast(app: App): void {
  clear(app.toastHost);
  if (app.toast) app.toastHost.append(el('div', { class: 'toast', role: 'status' }, [app.toast]));
}

/** "Builds: Germany +1, Russia −1 · even: France, Italy…" for the HUD. */
function adjustmentHeadline(state: GameState): string {
  const cs = powerCounts(state);
  const moving = cs.filter((c) => c.delta !== 0);
  if (!moving.length) return 'No builds or removals due.';
  return moving
    .map((c) => `${powerTitle(c.power)} ${c.delta > 0 ? `+${c.delta}` : `−${-c.delta}`}`)
    .join(' · ');
}
