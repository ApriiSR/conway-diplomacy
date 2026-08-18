// State codec for `#s=` share links (compact + compressed) and full JSON export/import.
//
// `encodeState`/`decodeState` are async because the only compression primitive available in
// both the browser and Node — the Compression Streams API (`CompressionStream`/
// `DecompressionStream`) — is inherently async, so callers must `await` them.
// `exportGame`/`importGame` (uncompressed JSON) stay synchronous.

import type {
  Dislodgement,
  GameState,
  LifeEvent,
  MapData,
  PhaseKind,
  PhaseRecord,
  Power,
  ProvinceId,
  Season,
  Unit,
  Variant,
} from '../engine/types';
import { STANDARD_MAP } from '../data/standard-map.js';
import { provinceOf } from '../engine/map-utils';

const SEASONS: readonly Season[] = ['SPRING', 'SUMMER', 'FALL', 'WINTER'];
const PHASES: readonly PhaseKind[] = ['MOVEMENT', 'RETREAT', 'ADJUSTMENT', 'SPAWN_CHOICE'];

/**
 * Validates a decoded GameState is coherent against `map`: every unit resolves to a real
 * province (and a real coast, if given), no two units occupy the same province, season/phase/
 * year are sane, and every SC in `centers` is a real SC owned by at most one power. Throws
 * with a message fit to show the person importing/opening a share link.
 */
function validateState(state: GameState, map: MapData): void {
  if (!SEASONS.includes(state.season)) {
    throw new Error(`invalid game state: unknown season '${state.season}'`);
  }
  if (!PHASES.includes(state.phase)) {
    throw new Error(`invalid game state: unknown phase '${state.phase}'`);
  }
  if (!Number.isInteger(state.year) || state.year < 1901) {
    throw new Error(`invalid game state: implausible year '${state.year}'`);
  }

  const occupied = new Set<ProvinceId>();
  for (const u of state.units) {
    const [id, coast] = u.loc.split('/');
    const province = map.provinces[id!];
    if (!province) {
      throw new Error(`invalid game state: unit ${u.power} ${u.type} at unknown province '${id}'`);
    }
    if (coast && !province.coasts.includes(coast)) {
      throw new Error(`invalid game state: unit ${u.power} ${u.type} has unknown coast '${u.loc}'`);
    }
    const base = provinceOf(u.loc);
    if (occupied.has(base)) {
      throw new Error(`invalid game state: two units occupy '${base}'`);
    }
    occupied.add(base);
  }

  const ownedBy = new Map<ProvinceId, Power>();
  for (const [power, provinces] of Object.entries(state.centers) as [Power, ProvinceId[]][]) {
    for (const id of provinces ?? []) {
      const province = map.provinces[id];
      if (!province || !province.sc) {
        throw new Error(`invalid game state: '${id}' is not a supply center`);
      }
      const owner = ownedBy.get(id);
      if (owner) {
        throw new Error(`invalid game state: supply center '${id}' owned by both ${owner} and ${power}`);
      }
      ownedBy.set(id, power);
    }
  }
}

const POWER_CODE: Record<Power, string> = {
  AUSTRIA: 'AUS',
  ENGLAND: 'ENG',
  FRANCE: 'FRA',
  GERMANY: 'GER',
  ITALY: 'ITA',
  RUSSIA: 'RUS',
  TURKEY: 'TUR',
  NEUTRAL: 'NEU',
};
const CODE_POWER: Record<string, Power> = Object.fromEntries(
  Object.entries(POWER_CODE).map(([power, code]) => [code, power as Power]),
) as Record<string, Power>;

function encodeUnit(u: Unit): string {
  return `${u.type} ${POWER_CODE[u.power]} ${u.loc}`;
}

function decodeUnit(s: string): Unit {
  const first = s.indexOf(' ');
  const second = s.indexOf(' ', first + 1);
  const type = s.slice(0, first) as Unit['type'];
  const code = s.slice(first + 1, second);
  const loc = s.slice(second + 1);
  const power = CODE_POWER[code];
  if (!power) throw new Error(`decodeUnit(): unknown power code ${code}`);
  return { type, power, loc };
}

interface CompactState {
  v: 1;
  y: number;
  se: Season;
  ph: PhaseKind;
  u: string[];
  c: Partial<Record<Power, ProvinceId[]>>;
  d?: Dislodgement[];
  pb?: LifeEvent[];
  l?: Partial<Record<Power, string>>;
  va?: Variant;
}

function stateToCompact(state: GameState): CompactState {
  const compact: CompactState = {
    v: 1,
    y: state.year,
    se: state.season,
    ph: state.phase,
    u: state.units.map(encodeUnit),
    c: state.centers,
  };
  if (state.dislodged) compact.d = state.dislodged;
  if (state.pendingBirths) compact.pb = state.pendingBirths;
  if (state.labels) compact.l = state.labels;
  // 'conway' is the implicit default when `variant` is absent (see GameState.variant),
  // but an explicit 'conway' is a distinct value from omission and must round-trip as such —
  // only actual absence gets to skip the wire, not the common value.
  if (state.variant) compact.va = state.variant;
  return compact;
}

function compactToState(c: CompactState): GameState {
  const state: GameState = {
    version: 1,
    year: c.y,
    season: c.se,
    phase: c.ph,
    units: c.u.map(decodeUnit),
    centers: c.c,
  };
  if (c.d) state.dislodged = c.d;
  if (c.pb) state.pendingBirths = c.pb;
  if (c.l) state.labels = c.l;
  if (c.va) state.variant = c.va;
  return state;
}

// ---------- compression ----------

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  void writer.write(new Uint8Array(bytes));
  void writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  void writer.write(new Uint8Array(bytes));
  void writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------- base64url (works in both browser and Node via btoa/atob) ----------

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- public API ----------

export async function encodeState(state: GameState): Promise<string> {
  const json = JSON.stringify(stateToCompact(state));
  const compressed = await deflate(new TextEncoder().encode(json));
  return toBase64Url(compressed);
}

export async function decodeState(s: string, map: MapData = STANDARD_MAP): Promise<GameState> {
  const bytes = await inflate(fromBase64Url(s));
  const compact = JSON.parse(new TextDecoder().decode(bytes)) as CompactState;
  const state = compactToState(compact);
  validateState(state, map);
  return state;
}

const EXPORT_VERSION = 1;

export interface GameExport {
  state: GameState;
  history: PhaseRecord[];
}

interface ExportPayload extends GameExport {
  version: number;
}

export function exportGame(data: GameExport): string {
  const payload: ExportPayload = { version: EXPORT_VERSION, state: data.state, history: data.history };
  return JSON.stringify(payload);
}

/**
 * The history is replayed by the phase scrubber and the report panel, so a corrupted
 * record has to be caught here rather than crashing the app several clicks later. Each
 * record's boards go through the same `validateState` as the live one, and `orders`/
 * `results` must at least be arrays — the shapes everything downstream iterates.
 */
function validateHistory(history: unknown, map: MapData): PhaseRecord[] {
  if (history === undefined || history === null) return [];
  if (!Array.isArray(history)) {
    throw new Error('invalid game file: history is not a list of phases');
  }
  history.forEach((record, i) => {
    const where = `history phase ${i + 1}`;
    if (!record || typeof record !== 'object') {
      throw new Error(`invalid game file: ${where} is not a phase record`);
    }
    const r = record as Partial<PhaseRecord>;
    if (!Array.isArray(r.orders)) throw new Error(`invalid game file: ${where} has no orders list`);
    if (!Array.isArray(r.results)) throw new Error(`invalid game file: ${where} has no results list`);
    // Optional: exports written before the Life step got its own history view have no
    // `preLifeUnits`, and the reader reconstructs it — but a present one must be a list.
    if (r.preLifeUnits !== undefined && !Array.isArray(r.preLifeUnits)) {
      throw new Error(`invalid game file: ${where} has an invalid pre-Life unit list`);
    }
    for (const [which, board] of [['before', r.before], ['after', r.after]] as const) {
      if (!board || typeof board !== 'object') {
        throw new Error(`invalid game file: ${where} has no '${which}' board`);
      }
      try {
        validateState(board, map);
      } catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).replace(/^invalid game state: /, '');
        throw new Error(`invalid game file: ${where}'s '${which}' board — ${why}`);
      }
    }
  });
  return history as PhaseRecord[];
}

export function importGame(json: string, map: MapData = STANDARD_MAP): GameExport {
  const payload = JSON.parse(json) as ExportPayload;
  if (payload.version !== EXPORT_VERSION) {
    throw new Error(`importGame(): unsupported export version ${payload.version}`);
  }
  const state = payload.state;
  validateState(state, map);
  return { state, history: validateHistory(payload.history, map) };
}
