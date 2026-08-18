import type { GameState, PhaseRecord } from '../engine/types.js';
import { decodeState, encodeState, exportGame, importGame } from './api.js';

/** Pre-games-list single slot. Read once, migrated into the list, then left alone. */
const LEGACY_KEY = 'conway-diplomacy-game';
/** Scratch slot for `#s=` sandbox copies, so a shared board can't clobber the GM's. */
const SANDBOX_KEY = 'conway-diplomacy-sandbox';
/** The games list: `[{id, title, ...}]`, newest activity first. */
const INDEX_KEY = 'conway-diplomacy:games';
const GAME_PREFIX = 'conway-diplomacy:game:';
const CURRENT_KEY = 'conway-diplomacy:current';

/** Orders typed but not yet adjudicated — saved so a reload doesn't lose the phase. */
export interface OrderDraft {
  /** Per-power textarea contents, keyed by Power. */
  orderText: Record<string, string>;
  /** Raw buffer behind the All tab. */
  allText: string;
  activeTab: string;
}

export interface SavedGame {
  state: GameState;
  history: PhaseRecord[];
  /** The redo stack, saved so that closing the tab doesn't quietly end the redo window. */
  future?: PhaseRecord[];
  title?: string;
  draft?: OrderDraft;
}

/** A row in the games drawer. `phaseLabel` is denormalised so the list needs no decoding. */
export interface GameSummary {
  id: string;
  title: string;
  updatedAt: number;
  phaseLabel: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — autosave is best-effort */
  }
}

function newId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function listGames(): GameSummary[] {
  const list = read<GameSummary[]>(INDEX_KEY) ?? [];
  return list.filter((g) => g && typeof g.id === 'string').sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeIndex(list: GameSummary[]): void {
  write(INDEX_KEY, list);
}

export function loadGame(id: string): SavedGame | null {
  const g = read<SavedGame>(GAME_PREFIX + id);
  return g?.state ? g : null;
}

/** Autosave for one game: writes the slot and refreshes its index row. */
export function saveGame(id: string, game: SavedGame, phaseLabel: string): void {
  write(GAME_PREFIX + id, game);
  const list = listGames();
  const row: GameSummary = {
    id,
    title: game.title ?? '',
    updatedAt: Date.now(),
    phaseLabel,
  };
  writeIndex([row, ...list.filter((g) => g.id !== id)]);
}

/** Register a new, empty slot and return its id. Never touches an existing game. */
export function createGame(game: SavedGame, phaseLabel: string): string {
  const id = newId();
  saveGame(id, game, phaseLabel);
  setCurrentGameId(id);
  return id;
}

export function duplicateGame(id: string): string | null {
  const g = loadGame(id);
  if (!g) return null;
  const row = listGames().find((r) => r.id === id);
  const copy: SavedGame = { ...g, title: `${g.title || 'untitled game'} (copy)` };
  const newer = newId();
  saveGame(newer, copy, row?.phaseLabel ?? '');
  return newer;
}

export function renameGame(id: string, title: string): void {
  const g = loadGame(id);
  if (g) write(GAME_PREFIX + id, { ...g, title });
  writeIndex(listGames().map((r) => (r.id === id ? { ...r, title } : r)));
}

export function deleteGame(id: string): void {
  try {
    localStorage.removeItem(GAME_PREFIX + id);
  } catch {
    /* ignore */
  }
  writeIndex(listGames().filter((g) => g.id !== id));
  if (currentGameId() === id) {
    try {
      localStorage.removeItem(CURRENT_KEY);
    } catch {
      /* ignore */
    }
  }
}

export function currentGameId(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

export function setCurrentGameId(id: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * One-time move of the old single-slot save into the list, so upgrading doesn't look
 * like "my game is gone". The legacy key is left in place: it costs nothing, and a
 * non-empty games list is what stops it being imported twice.
 */
export function migrateLegacySave(phaseLabel: (g: SavedGame) => string): void {
  if (listGames().length) return;
  const raw = read<SavedGame>(LEGACY_KEY);
  if (!raw?.state) return;
  const id = createGame(raw, phaseLabel(raw));
  setCurrentGameId(id);
}

/** Autosave for a `#s=` sandbox copy, which never touches a saved game's slot. */
export function saveSandbox(game: SavedGame): void {
  write(SANDBOX_KEY, game);
}

/**
 * `#s=<encoded>` snapshot in the current URL, if any. A malformed or rejected
 * snapshot comes back as `{ error }` so the app can tell the visitor why the link
 * didn't open instead of silently starting a fresh game.
 */
export async function readShareHash(): Promise<{ state?: GameState; error?: string }> {
  const m = /[#&]s=([^&]+)/.exec(location.hash);
  if (!m) return {};
  try {
    return { state: await decodeState(decodeURIComponent(m[1]!)) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Where the hosted app lives — the only address a share link from an offline copy can use. */
export const CANONICAL_URL = 'https://apriiori.com/conway-diplomacy/';

/** True when the app is running from a local file, where `location` names nobody else's app. */
export function isOffline(): boolean {
  return location.origin === 'null' || location.protocol === 'file:';
}

/**
 * A share link has to be openable by the person you send it to. From a `file://` copy
 * `location.origin` is the string `"null"` and the path is somewhere on this disk, so the
 * board is hung off the hosted address instead — the state travels in the fragment, which
 * is the same either way.
 */
export async function shareUrl(state: GameState): Promise<string> {
  const base = isOffline() ? CANONICAL_URL : `${location.origin}${location.pathname}`;
  return `${base}#s=${encodeURIComponent(await encodeState(state))}`;
}

/** Chat apps typically cap messages around 2000 chars; warn well before a link stops being pasteable. */
export const SHARE_LINK_WARN_AT = 1800;

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * The whole session, not just the board: `exportGame` owns `state`/`history`/`future`, and
 * the GM-side extras (title, in-progress drafts) ride alongside it so an import restores an
 * identical session. Power labels live inside `state`, so they travel already.
 */
export function downloadJson(game: SavedGame, filename: string): void {
  const core = JSON.parse(
    exportGame({ state: game.state, history: game.history, future: game.future }),
  ) as Record<string, unknown>;
  if (game.title) core.title = game.title;
  if (game.draft) core.draft = game.draft;
  download(new Blob([JSON.stringify(core)], { type: 'application/json' }), filename);
}

export function pickJsonFile(): Promise<SavedGame> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('no file chosen'));
      file
        .text()
        .then((t) => {
          const g = importGame(t);
          const extra = JSON.parse(t) as { title?: string; draft?: OrderDraft };
          resolve({
            state: g.state,
            history: g.history,
            future: g.future,
            title: extra.title,
            draft: extra.draft,
          });
        })
        .catch(reject);
    });
    input.click();
  });
}

/** Serialize the live board SVG to a PNG blob at `scale`x. */
export async function renderPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const vb = (svg.getAttribute('viewBox') ?? '0 0 1835 1360').split(/[\s,]+/).map(Number);
  const w = vb[2] ?? 1835;
  const h = vb[3] ?? 1360;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));

  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not rasterise the board'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas context');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('PNG encoding failed');
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadPng(svg: SVGSVGElement, filename: string, scale = 2): Promise<void> {
  download(await renderPngBlob(svg, scale), filename);
}

/** Can this browser put an image on the clipboard at all? (Firefox/older Safari: no.) */
export function canCopyImage(): boolean {
  return typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function';
}

/**
 * Copy the board straight to the clipboard, which is what the group-chat workflow actually
 * wants — paste beats download-then-attach. `ClipboardItem` is handed the *promise* of a
 * blob rather than an awaited one: Safari drops the write if the user gesture has already
 * ended, and passing the promise keeps `clipboard.write` inside the click's task.
 */
export async function copyPng(svg: SVGSVGElement, scale = 2): Promise<void> {
  if (!canCopyImage()) throw new Error('This browser cannot copy images to the clipboard.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderPngBlob(svg, scale) })]);
}
