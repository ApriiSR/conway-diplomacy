import type { Power, ProvinceId, UnitType } from '../engine/types.js';
import { HELP_ALSO, HELP_ALSO_TITLE, HELP_STEPS, HELP_TITLE } from './help-text.js';
import type { App } from './main.js';
import { RULES_TITLE } from './rules-text.js';
import { rulesElements } from './rules-view.js';
import { el } from './svg.js';

/** Seen the first-run card? Kept out of SavedGame so "New game" doesn't bring it back. */
export const INTRO_KEY = 'conway-diplomacy-intro-seen';

/**
 * Modals are real dialogs: labelled, Escape-closable, focus moves in on open and
 * back to whatever opened them on close.
 */
export function showModal(
  app: App,
  title: string,
  body: (close: () => void) => HTMLElement[],
  opts: { cancelLabel?: string } = {},
): void {
  const returnTo = document.activeElement as HTMLElement | null;
  const host = el('div', { class: 'modal-scrim' });
  const close = () => {
    host.remove();
    app.modals = app.modals.filter((f) => f !== close);
    returnTo?.focus?.();
  };
  app.modals.push(close);
  const card = el('div', {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    tabindex: '-1',
  }, [el('h3', {}, [title])]);
  card.append(...body(close));
  // Taken before the cancel button is appended: a dialog whose body has nothing to act on
  // (the Rules panel, the help text) is something to read, so focus goes to the dialog
  // itself. Focusing the trailing Cancel button instead scrolled long ones to the bottom.
  const first = card.querySelector<HTMLElement>('button, input, textarea, select');
  const cancel = el('button', { class: 'ghost' }, [opts.cancelLabel ?? 'Cancel']);
  cancel.addEventListener('click', close);
  card.append(cancel);
  host.append(card);
  host.addEventListener('click', (e) => {
    if (e.target === host) close();
  });
  app.overlay.append(host);
  (first ?? card).focus();
  card.scrollTop = 0;
}

export function askCoast(
  app: App,
  prov: ProvinceId,
  coasts: string[],
  done: (coast: string) => void,
): void {
  showModal(app, `Which coast of ${app.provName(prov)}?`, (close) =>
    coasts.map((c) => {
      const b = el('button', { class: 'big' }, [c.toUpperCase()]);
      b.addEventListener('click', () => {
        close();
        done(c);
      });
      return b;
    }),
  );
}

export function askBuild(app: App, prov: ProvinceId, coasts: string[]): void {
  const owner = (Object.entries(app.state.centers) as [Power, ProvinceId[]][]).find(([, l]) =>
    l?.includes(prov),
  )?.[0];
  if (!owner) return;
  showModal(app, `Build in ${app.provName(prov)}`, (close) => {
    const opts: HTMLElement[] = [];
    const kinds: { type: UnitType; coast?: string; label: string }[] = [{ type: 'A', label: 'Army' }];
    if (app.map.provinces[prov]?.type !== 'inland') {
      if (coasts.length) for (const c of coasts) kinds.push({ type: 'F', coast: c, label: `Fleet (${c.toUpperCase()})` });
      else kinds.push({ type: 'F', label: 'Fleet' });
    }
    for (const k of kinds) {
      const b = el('button', { class: 'big' }, [k.label]);
      b.addEventListener('click', () => {
        close();
        app.addOrder(app.clicks.resolveBuild(owner, prov, k.type, k.coast));
      });
      opts.push(b);
    }
    return opts;
  });
}

/** Clipboard fallback: hand the GM the text, selected, to copy by hand. */
export function showCopyText(app: App, title: string, text: string): void {
  showModal(app, title, () => {
    const ta = el('textarea', { class: 'orders copy-out', spellcheck: 'false' }) as HTMLTextAreaElement;
    ta.value = text;
    setTimeout(() => {
      ta.focus();
      ta.select();
    }, 0);
    return [el('p', { class: 'hint' }, ['The clipboard was unavailable — select and copy:']), ta];
  });
}

/** The steps list, shared by the first-run card and the on-demand help modal. */
function helpSteps(): HTMLElement[] {
  const steps = el(
    'ol',
    { class: 'intro-steps' },
    HELP_STEPS.map((s) =>
      el('li', {}, [
        s.text,
        ...(s.sub ? [el('ul', { class: 'intro-sub' }, s.sub.map((t) => el('li', {}, [t])))] : []),
      ]),
    ),
  );
  return [
    steps,
    el('div', { class: 'intro-head' }, [HELP_ALSO_TITLE]),
    el('ul', { class: 'intro-steps intro-also' }, HELP_ALSO.map((t) => el('li', {}, [t]))),
  ];
}

/**
 * The same copy as the first-run card, reachable after it has been dismissed —
 * dismissing is meant to clear the panel, not to hide the instructions for good.
 */
export function helpModal(app: App): void {
  showModal(
    app,
    HELP_TITLE,
    (close) => {
      const rules = el('button', { class: 'big' }, [RULES_TITLE]);
      rules.addEventListener('click', () => {
        close();
        rulesModal(app);
      });
      return [...helpSteps(), rules];
    },
    { cancelLabel: 'Close' },
  );
}

/** The variant's rules, from the same source the README's rules section is generated from. */
export function rulesModal(app: App): void {
  showModal(app, RULES_TITLE, () => rulesElements(), { cancelLabel: 'Close' });
}

/** The first-run card in the panel — the same steps as the help modal, shown once. */
export function introCard(app: App): HTMLElement {
  const box = el('div', { class: 'intro-card' }, [
    el('div', { class: 'intro-head' }, [HELP_TITLE]),
    ...helpSteps(),
  ]);
  const x = el('button', { class: 'ghost small' }, ['Got it']);
  x.addEventListener('click', () => {
    app.introDismissed = true;
    try {
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      /* private mode */
    }
    app.render();
  });
  box.append(x);
  return box;
}
