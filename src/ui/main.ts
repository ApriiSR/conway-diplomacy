import type {
  GameState,
  LifeEvent,
  LifeResult,
  MapData,
  Order,
  PhaseRecord,
  Power,
  ProvinceId,
  Unit,
  Variant,
} from '../engine/types.js';
import { GREAT_POWERS } from '../engine/types.js';
import { lifeStep } from '../game/life.js';
import { STANDARD_MAP } from '../data/standard-map.js';
import { STANDARD_ART } from '../data/standard-art.js';
import { advance, initialState, nextPhaseLabel, parseOrders, resolveSpawnChoices } from './api.js';
import type { DuplicateOrder, ParseError, SpawnChoice } from './api.js';
import { Board } from './board.js';
import { powerTitle } from './colors.js';
import { installGestures, isMobile, MOBILE_EXIT, MOBILE_MAX, syncLayoutClass } from './gestures.js';
import {
  canStepView,
  historyViews,
  stepView,
  viewLife,
  viewResults,
  viewState,
  type HistoryView,
} from './history-views.js';
import { renderHud, renderToast } from './hud.js';
import { ClickController, type ClickMode } from './interaction.js';
import { provinceOf } from '../engine/map-utils.js';
import { createMapArt, provinceLabel } from './map-art.js';
import { askBuild, askCoast, askUndo, INTRO_KEY, showModal } from './modals.js';
import {
  combinedText,
  confirmAdjudicate,
  emptyText,
  flushText,
  readiness,
  type OrderText,
} from './order-entry.js';
import { renderPanel } from './panel.js';
import { orderPower, upsertOrderLine } from './orders-text.js';
import { applyDraft, lifeCountsText, lifeSummaryText, persist } from './session.js';
import { currentGameId, listGames, loadGame, migrateLegacySave, readShareHash } from './persist.js';
import { el } from './svg.js';

/**
 * The app shell: the whole of the GM's session state, plus the wiring that puts the
 * board, the HUD and the panel on the page. Everything that *draws* something lives in
 * a sibling module — `hud.ts`, `panel.ts`, `order-entry.ts`, `modals.ts`, `session.ts`,
 * `gestures.ts` — and takes this object as its first argument, so the fields below are
 * that family's shared surface rather than private state.
 */
export class App {
  readonly map: MapData = STANDARD_MAP;
  private readonly art = createMapArt(STANDARD_ART);
  readonly board = new Board(this.art, this.map);
  readonly clicks = new ClickController(this.map);

  state: GameState;
  history: PhaseRecord[] = [];
  future: PhaseRecord[] = [];
  title = '';
  /** True for a `#s=` copy: everything still works, but it never writes the GM's slot. */
  sandbox = false;
  bannerDismissed = false;
  orderText: OrderText = emptyText();
  activeTab: Power | 'ALL' = 'ALL';
  /** Raw buffer behind the All tab, so typing there isn't reflowed under the caret. */
  allText = '';
  /** Index into `views()` — null = the live board ("Current"). */
  viewIndex: number | null = null;
  /**
   * Set when *adjudicating* parked the view on the phase it just resolved, rather than
   * the GM choosing it. That view is a result to read and share, so the first move
   * toward the next phase — a keystroke, a unit click, a tab — hands the board back.
   * A view the GM picked themselves is never taken away from them like that.
   */
  landedOnAdjudication = false;
  lifeOpen = false;
  /** "Life preview": mark what the Life step would do to the board as it stands. */
  lifePreview = false;
  /** Do exported images carry the order arrows and Life marks, or just the board? */
  exportMarks = true;
  toast: string | null = null;
  private toastTimer = 0;
  /** After adjudication the results take the panel and entry collapses beneath them. */
  entryOpen = true;
  expandedPower: Power | null = null;
  introDismissed = false;
  sheetOpen = false;
  /** Last decided value of `mobile`, feeding the hysteresis in its getter. */
  mobileState = false;
  /** Installed by `installGestures`; swaps the board between full map and phone fit. */
  applyMobileView: (fit: boolean) => void = () => {};

  // live textarea plumbing (debounce flush, caret/scroll restore, IME)
  ta: HTMLTextAreaElement | null = null;
  taTab: Power | 'ALL' = 'ALL';
  debounce = 0;
  composing = false;
  /** Set when the *model* changed the order text, so the box must be updated even if focused. */
  pushTextToBox = false;
  /** Set by `entrySection` when it did that push, so caret restoration doesn't undo it. */
  caretMoved = false;
  modals: (() => void)[] = [];

  /** Which saved game this session is editing (null while in a sandbox copy). */
  gameId: string | null = null;

  // DOM
  private readonly root = document.getElementById('app')!;
  /** The map's own column: a control bar, then the board — the bar never covers it. */
  private readonly boardCol = el('div', { class: 'board-col' });
  private readonly boardWrap = el('div', { class: 'board-wrap' });
  readonly hud = el('div', { class: 'topbar' });
  readonly toastHost = el('div', { class: 'toast-host' });
  readonly panel = el('div', { class: 'panel' });
  readonly overlay = el('div', { class: 'overlay-host' });

  static async boot(): Promise<App> {
    const shared = await readShareHash();
    return new App(shared);
  }

  private constructor(shared: { state?: GameState; error?: string }) {
    migrateLegacySave((g) => nextPhaseLabel(g.state));
    const id = currentGameId() ?? listGames()[0]?.id ?? null;
    const saved = id ? loadGame(id) : null;
    if (shared.state) {
      this.state = shared.state;
      this.sandbox = true;
    } else if (saved) {
      this.gameId = id;
      this.state = saved.state;
      this.history = saved.history ?? [];
      this.title = saved.title ?? '';
      applyDraft(this, saved.draft);
    } else {
      this.state = initialState(this.map, 'conway');
    }
    this.entryOpen = !this.history.length || this.orderEntryStarted;
    try {
      this.introDismissed = localStorage.getItem(INTRO_KEY) === '1';
    } catch {
      /* private mode */
    }

    this.boardWrap.append(this.board.svg, this.toastHost);
    this.boardCol.append(this.hud, this.boardWrap);
    this.root.append(this.boardCol, this.panel, this.overlay);
    this.board.setProvinceClickHandler((id) => this.onBoardClick(id));
    document.addEventListener('keydown', (e) => this.onKey(e));
    installGestures(this);
    // Layout mode is decided ONLY from real viewport-size signals, never as a side effect
    // of an unrelated render (e.g. typing an order) — otherwise a stale reading only gets
    // caught up whenever the next render happens to run, which looks like the sidebar
    // jumping in response to typing rather than to the resize/zoom that actually caused it.
    // matchMedia's `change` event is used alongside `resize` because some browsers don't
    // reliably fire `resize` for page-zoom (⌘+/⌘-, trackpad pinch) even though it does
    // change the CSS viewport width that the media queries and this getter both key off.
    const relayout = () => syncLayoutClass(this);
    window.addEventListener('resize', relayout);
    window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).addEventListener('change', relayout);
    window.matchMedia(`(max-width: ${MOBILE_EXIT}px)`).addEventListener('change', relayout);
    syncLayoutClass(this);
    this.render();
    if (shared.error) {
      showModal(this, 'That share link could not be opened', () => [
        el('p', { class: 'hint' }, [shared.error!]),
        el('p', { class: 'hint' }, ['Showing your own saved game instead.']),
      ]);
    }
  }

  // ---------- derived ----------

  get live(): boolean {
    return this.viewIndex === null;
  }

  get mobile(): boolean {
    return isMobile(this.mobileState);
  }

  /** 'conway' unless the state says otherwise; drives whether Life UI is shown at all. */
  get variant(): Variant {
    return this.state.variant ?? 'conway';
  }

  /**
   * The history dropdown's entries. A phase and its Life step are two entries over one
   * record, so this is what `viewIndex` indexes — not `history` itself. Undo and redo
   * still work on records: viewing is read-only, and both of them return to the live board.
   */
  views(): HistoryView[] {
    return historyViews(this.history);
  }

  /** The history entry being looked at, or null on the live board. */
  viewedView(): HistoryView | null {
    if (this.viewIndex === null) return null;
    return this.views()[this.viewIndex] ?? null;
  }

  viewedRecord(): PhaseRecord | null {
    return this.viewedView()?.record ?? this.history[this.history.length - 1] ?? null;
  }

  viewedState(): GameState {
    const view = this.viewedView();
    return view ? viewState(view) : this.state;
  }

  /** What the board on screen is: the entry's own name, or the phase awaiting orders. */
  viewLabel(): string {
    return this.viewedView()?.label ?? nextPhaseLabel(this.state);
  }

  /**
   * Can the history bar's ← / → step that way? `delta` is in picker positions, where the
   * last one past the views is "Current".
   */
  canStepView(delta: number): boolean {
    return canStepView(this.viewIndex, this.views().length, delta);
  }

  /**
   * Move one entry along the history bar. Looking at something is not editing it — this
   * never touches `history` or `future` — and a step is the GM choosing a view, so it
   * clears `landedOnAdjudication` the way the dropdown does.
   */
  stepView(delta: number): void {
    if (!this.canStepView(delta)) return;
    this.viewIndex = stepView(this.viewIndex, this.views().length, delta);
    this.landedOnAdjudication = false;
    this.render();
  }

  /** Park on the phase view of the record just adjudicated: its arrows, its results. */
  private landOnLastPhase(): void {
    const last = this.history.length - 1;
    const at = this.views().findIndex((v) => v.index === last && v.kind === 'phase');
    this.viewIndex = at < 0 ? null : at;
    this.landedOnAdjudication = at >= 0;
  }

  /**
   * Hand the board back after an adjudication parked it on a result. Returns whether it
   * did anything, so callers can skip a render they don't otherwise need.
   */
  returnToLive(): boolean {
    if (!this.landedOnAdjudication) return false;
    this.landedOnAdjudication = false;
    this.viewIndex = null;
    return true;
  }

  parsedFor(power: Power): { orders: Order[]; errors: ParseError[]; duplicates: DuplicateOrder[] } {
    return parseOrders(this.orderText[power] ?? '', this.state, this.map, power);
  }

  allOrders(): Order[] {
    const out: Order[] = [];
    for (const p of GREAT_POWERS) out.push(...this.parsedFor(p).orders);
    return out;
  }

  ordersByPower(): Map<Power, Order[]> {
    return new Map(GREAT_POWERS.map((p) => [p, this.parsedFor(p).orders]));
  }

  /**
   * Has the GM started entering orders for the phase now on the board? Only actual order
   * text counts: merely selecting a unit must not wipe the result arrows the GM is
   * reading off while they type the next phase.
   */
  get orderEntryStarted(): boolean {
    return GREAT_POWERS.some((p) => (this.orderText[p] ?? '').trim() !== '');
  }

  /**
   * Is this record's outcome the board we're playing on? The history is a chain — each
   * record's `after` is the next one's `before`, and every path that changes the board
   * (adjudicate, undo, redo, load) keeps that true — so the answer is simply whether it
   * is the last record. Asked by index rather than by comparing the two boards, which
   * would have to know which fields count: a reload rebuilds `after` and the live state
   * as separate objects, and renaming a player replaces the state without changing the
   * phase at all.
   */
  isCurrentRecord(record: PhaseRecord | null | undefined): boolean {
    return !!record && this.history.length > 0 && record === this.history[this.history.length - 1];
  }

  nameOf(p: Power): string {
    return this.state.labels?.[p] || powerTitle(p);
  }

  /** Presentation-only name for a province: seas ALL CAPS, land Initial-cap. */
  provName(id: ProvinceId): string {
    return provinceLabel(id, this.map.provinces[id]?.type === 'sea');
  }

  // ---------- actions ----------

  say(text: string): void {
    this.toast = text;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = null;
      renderToast(this);
    }, 3200);
    renderToast(this);
  }

  persist(): void {
    persist(this);
  }

  flushText(rerender = false): void {
    flushText(this, rerender);
  }

  addOrder(order: Order): void {
    const power: Power = 'unit' in order ? order.unit.power : order.power;
    this.orderText[power] = upsertOrderLine(this.orderText[power] ?? '', order);
    this.allText = combinedText(this);
    if (this.activeTab !== 'ALL' && this.activeTab !== power) this.activeTab = power;
    // A completed support/convoy shouldn't leave the next map click in the same mode.
    if (order.kind === 'support' || order.kind === 'convoy') this.clicks.setMode('move');
    // A click-entered order is an edit the GM did NOT type, so it has to be pushed into
    // the box even while the box has focus — the "never stomp a focused textarea" rule
    // exists to protect keystrokes, not to hide map clicks.
    this.pushTextToBox = true;
    this.entryOpen = true;
    this.persist();
    this.render();
  }

  adjudicate(): void {
    this.flushText();
    // Adjudicating from the result we parked them on is the ordinary next step, not an
    // attempt to edit history: take the board back first rather than scolding them.
    this.returnToLive();
    if (!this.live) {
      this.say('Viewing history — jump to the current phase first.');
      return;
    }
    const ready = readiness(this);
    const errors = ready.reduce((n, r) => n + r.errors, 0);
    if (this.state.phase === 'SPAWN_CHOICE') {
      // Undecided spawns don't block — but they do become armies, so say so first.
      if (errors || this.undecidedSpawns().length) confirmAdjudicate(this, ready);
      else this.commitSpawnChoices();
      return;
    }
    if (errors) confirmAdjudicate(this, ready);
    else this.commitAdjudication();
  }

  commitAdjudication(): void {
    let record: PhaseRecord;
    try {
      record = advance(this.state, this.allOrders(), this.map);
    } catch (e) {
      this.say(String(e instanceof Error ? e.message : e));
      return;
    }
    this.history.push(record);
    this.future = [];
    this.state = record.after;
    this.orderText = emptyText();
    this.allText = '';
    this.clicks.reset();
    this.entryOpen = false;
    this.expandedPower = null;
    this.lifeOpen = this.variant === 'conway' && !!record.life && record.life.events.length > 0;
    this.landOnLastPhase();
    this.persist();
    this.render();
    this.announceLifeStep();
  }

  /**
   * The Life step is a second board, one entry further along, and landing on the phase
   * view is the only place it isn't in front of the GM — so the toast says it happened
   * and names the entry that shows it.
   */
  private announceLifeStep(): void {
    const last = this.history.length - 1;
    const lifeView = this.views().find((v) => v.index === last && v.kind === 'life');
    const life = lifeView?.record.life;
    if (!lifeView || !life) return;
    this.say(`Adjudicated — Life step: ${lifeCountsText(life)} (see ${lifeView.label})`);
  }

  /**
   * The spawn decisions the GM has entered, as `{province -> chosen unit}`. They live in
   * the order text like any other order, so the A/F buttons and a typed `Build F Edi`
   * are the same act and neither can get out of step with the other.
   */
  spawnPicks(): Map<ProvinceId, Unit> {
    const out = new Map<ProvinceId, Unit>();
    for (const o of this.allOrders()) {
      if (o.kind === 'build') out.set(provinceOf(o.unit.loc), o.unit);
    }
    return out;
  }

  /** Pending births whose owner hasn't said army or fleet — they will default to armies. */
  undecidedSpawns(): LifeEvent[] {
    if (this.state.phase !== 'SPAWN_CHOICE') return [];
    const picks = this.spawnPicks();
    return (this.state.pendingBirths ?? []).filter((e) => !picks.has(e.province));
  }

  commitSpawnChoices(): void {
    const choices: SpawnChoice[] = [...this.spawnPicks().values()].map((u) => {
      const [id, coast] = u.loc.split('/');
      return coast ? { province: id!, type: u.type, coast } : { province: id!, type: u.type };
    });
    let record: PhaseRecord;
    try {
      record = resolveSpawnChoices(this.state, choices, this.map);
    } catch (e) {
      this.say(String(e instanceof Error ? e.message : e));
      return;
    }
    // The spawn resolution is its own step in history, so undo lands back on the choice.
    this.history.push(record);
    this.future = [];
    this.state = record.after;
    this.orderText = emptyText();
    this.allText = '';
    this.pushTextToBox = true;
    this.clicks.reset();
    this.entryOpen = false;
    this.expandedPower = null;
    this.lifeOpen = false;
    this.landOnLastPhase();
    this.persist();
    this.render();
  }

  /** Does undoing discard an adjudication? (Which is the only thing undo ever does.) */
  get canUndo(): boolean {
    return this.history.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** The label undo's confirmation names — the phase whose result would be discarded. */
  undoLabel(): string | null {
    const record = this.history[this.history.length - 1];
    return record ? nextPhaseLabel(record.before) : null;
  }

  undo(): void {
    const record = this.history.pop();
    if (!record) return;
    this.future.push(record);
    this.state = record.before;
    this.viewIndex = null;
    this.landedOnAdjudication = false;
    // The adjudicated orders go back in the box. Undo hands the phase back to be fixed
    // and re-run, so making the GM retype what they already entered would be the whole
    // cost of the mistake all over again.
    this.orderText = emptyText();
    for (const o of record.orders) {
      this.orderText[orderPower(o)] = upsertOrderLine(this.orderText[orderPower(o)] ?? '', o);
    }
    this.allText = combinedText(this);
    this.pushTextToBox = true;
    this.clicks.reset();
    this.entryOpen = true;
    this.persist();
    this.render();
  }

  redo(): void {
    const record = this.future.pop();
    if (!record) return;
    this.history.push(record);
    this.state = record.after;
    this.viewIndex = null;
    this.landedOnAdjudication = false;
    // Redoing consumes those orders exactly as adjudicating did, so the box is emptied for
    // the next phase — otherwise undo's restored orders are left behind as a stale draft,
    // e.g. a `Build A PRU` sitting in the movement phase that follows a spawn choice.
    this.orderText = emptyText();
    this.allText = '';
    this.pushTextToBox = true;
    this.clicks.reset();
    this.entryOpen = false;
    this.persist();
    this.render();
  }

  // ---------- board clicks and keys ----------

  private onBoardClick(id: ProvinceId): void {
    // Clicking a unit is the GM starting the next phase, so it takes the board back
    // from the result they were parked on — and then counts as the first click.
    const returned = this.returnToLive();
    if (!this.live) {
      this.say('Viewing history — orders are read-only here.');
      return;
    }
    const out = this.clicks.click(this.state, id);
    switch (out.kind) {
      case 'order':
        this.addOrder(out.order);
        return;
      case 'need-coast':
        askCoast(this, out.province, out.coasts, (coast) =>
          this.addOrder(this.clicks.resolveCoast(this.state, out.unit, out.province, coast)),
        );
        break;
      case 'need-build-type':
        askBuild(this, out.province, out.coasts);
        break;
      case 'message':
        this.say(out.text);
        break;
      case 'redraw':
        this.render();
        return;
      default:
        break;
    }
    // A click that changes no order still moved the board back to live, and that has to
    // be drawn — otherwise the flag is cleared while the map still shows the old view.
    if (returned) this.render();
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (k === 'escape' && this.modals.length) {
      e.preventDefault();
      this.modals[this.modals.length - 1]!();
      return;
    }
    const tag = (e.target as HTMLElement | null)?.tagName;
    const typing = tag === 'TEXTAREA' || tag === 'INPUT';
    if (typing && !mod) {
      if (k === 'escape') (e.target as HTMLElement).blur();
      return;
    }
    if (mod) {
      if (k === 'enter') {
        e.preventDefault();
        this.adjudicate();
      } else if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else askUndo(this);
      }
      return;
    }
    if (k === 's') this.setMode('support');
    else if (k === 'c') this.setMode('convoy');
    else if (k === 'm') this.setMode('move');
    else if (k === 'escape') {
      this.clicks.reset();
      this.render();
    }
  }

  setMode(mode: ClickMode): void {
    this.clicks.setMode(mode);
    this.render();
  }

  // ---------- render ----------

  /**
   * What the board's Life layer shows: on a Life history entry, that step's marks; on the
   * live board, only the preview of what the step *would* do, if that toggle is on. A
   * finished step's ✕s and birth rings belong to the board it ran on, which is its own
   * history entry — leaving them on the live board rings units that are simply there now.
   */
  private lifeOverlay(view: HistoryView | null, marks: boolean): LifeResult | undefined {
    if (this.variant !== 'conway' || !marks) return undefined;
    if (this.lifePreview) return lifeStep(this.viewedState().units, this.map);
    return view ? viewLife(view) : undefined;
  }

  /** The exported margin's Life line, on the one view whose board the step acted on. */
  private captionLifeSummary(view: HistoryView | null, marks: boolean): string | undefined {
    return marks && view?.kind === 'life' ? lifeSummaryText(view.record) : undefined;
  }

  /**
   * `marks: false` exports the bare board — the same view, without the arrows and Life
   * marks (and so without their legend rows, which are derived from what is drawn).
   */
  render(opts: { caption?: boolean; marks?: boolean } = {}): void {
    const marks = opts.marks !== false;
    const view = this.viewedView();
    const viewState = this.viewedState();

    this.board.render({
      state: viewState,
      // Result arrows belong to the phase they were given in, so they are drawn on that
      // phase's own history entry and never on the live board, whose units have already
      // moved. `Current` is the board as it stands, plus whatever is being entered onto it.
      results: view && marks ? viewResults(view) : undefined,
      // What the GM has entered so far, drawn provisionally. Only on the live board and
      // never in an export: a shared image should show what happened, not a draft.
      pendingOrders: this.live && !opts.caption ? this.allOrders() : undefined,
      dislodged: viewState.dislodged,
      life: this.lifeOverlay(view, marks),
      selected: this.live ? this.clicks.selected : null,
      secondary: this.live ? this.clicks.secondary : null,
      targets: this.live ? this.clicks.targets : [],
      convoyTargets: this.live ? this.clicks.convoyTargets : [],
      title: this.title,
      phaseLabel: this.viewLabel(),
      showCaption: !!opts.caption,
      lifeSummary: opts.caption ? this.captionLifeSummary(view, marks) : undefined,
    });

    // Layout mode (is-mobile / the 940px→720px stacked breakpoint) is decided solely by
    // the resize/matchMedia listeners installed in the constructor — never here. Re-running
    // it on every render would make layout mode a side effect of typing an order (which
    // triggers a render) instead of an actual viewport change.
    renderHud(this);
    renderToast(this);
    renderPanel(this);
  }
}

void App.boot();
