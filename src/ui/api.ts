// The UI's whole view of the engine and the game rules: one re-export point, so a change
// to those module layouts touches this file and nothing else in src/ui/.

export { parseOrders } from '../engine/parse.js';
export type { DuplicateOrder, ParseError, ParseResult } from '../engine/parse.js';
export { advance, initialState, lifeStepLabel, nextPhaseLabel, resolveSpawnChoices } from '../game/flow.js';
export type { SpawnChoice } from '../game/flow.js';
export { decodeState, encodeState, exportGame, importGame } from '../game/codec.js';
export type { GameExport } from '../game/codec.js';
