# Developing

Internals: the module contracts a contributor needs before changing anything. The rules
themselves are in the [README](../README.md) (and in the app's Rules panel — both are
generated from `src/ui/rules-text.ts`).

TypeScript, esbuild bundle, vitest, no framework and no runtime dependencies. The shared
model every module depends on is `src/engine/types.ts`. Node 22 or newer is required: the
data modules use JSON import attributes and the codec uses Compression Streams.

## Layout

| Path | What |
| --- | --- |
| `src/engine/` | order parsing and DATC movement/retreat/adjustment resolution |
| `src/game/` | the Life step, the phase machine, the share-link codec |
| `src/ui/` | the browser app (map, order entry, reports, the Rules panel's source text) — see [UI modules](#ui-srcui) below |
| `src/data/` | the standard map graph and the map art, the scripts that generate them, and `source/` — the committed input data |
| `web/` | the served page — HTML, stylesheet, map attribution |
| `test/datc/` | the DATC fixture and its runner |
| `scripts/build.mjs` | the two builds |
| `CONTRIBUTING.md` | the checks a pull request has to pass |

## Engine (`src/engine/`)

```ts
parseOrders(text, state, map, defaultPower?): {
  orders: Order[];
  errors: { line: string; message: string; kind?: 'duplicate' }[];
  duplicates: { loc: Loc; type: UnitType; count: number }[];
}
resolveMovement(state, orders, map): { results: { order, result }[]; dislodged: Dislodgement[]; next: GameState }
resolveRetreats(state, orders, map): { results; next: GameState }
resolveAdjustments(state, orders, map): { results; next: GameState }
```

The resolvers are authoritative for `units`, `centers` and `labels` only; season/year/phase
transitions belong to the phase machine, which overwrites whatever they put there so the
whole state machine lives in one file.

**Neutral units.** Any order naming a NEUTRAL unit is rejected at parse time, and the
resolver treats a neutral as holding. If dislodged it enters `dislodged` like anyone else —
so a turn where only a neutral was dislodged still runs a RETREAT phase — and
`resolveRetreats` disbands it, since no retreat order for it can exist.

**One unit, one order.** `parseOrders` keeps only the LAST order given to a unit, reports
each superseded line as an error with `kind: 'duplicate'`, and lists the unit in
`duplicates`. Adjustment orders are exempt: they key on provinces, and doubled builds are
reported as warnings instead.

## Game flow (`src/game/`)

```
SPRING/MOVEMENT → (RETREAT) → Life → [SUMMER/SPAWN_CHOICE] → FALL/MOVEMENT → (RETREAT)
  → WINTER/ADJUSTMENT → Life → [WINTER/SPAWN_CHOICE] → next year SPRING/MOVEMENT
```

Retreat phases are skipped when nothing is dislodged; the Life step runs either way.
`SUMMER` has no movement phase, but it is an order season: its `SPAWN_CHOICE` takes build
orders for the coastal births the Life step just produced. Winter's Life step runs inside
`WINTER`, after the adjustments, and its spawn choices are `WINTER` + `SPAWN_CHOICE`.

```ts
advance(state, orders, map): PhaseRecord
resolveSpawnChoices(state, choices: { province, type, coast? }[], map): PhaseRecord
lifeStep(units, map): LifeResult    // pure, no engine dependency
```

`resolveSpawnChoices` validates each choice (pending in this SPAWN_CHOICE, coastal per the
map, unoccupied); an invalid choice throws before any unit is placed. A pending birth with
*no* choice is not an error — it defaults to an army, with `note: 'defaulted, no order
given'` on its result — so a silent player can never block the phase. Each decision is
recorded as a `build` order with an `ok` result, and the whole thing returns a
`PhaseRecord`, so spawn resolution appears in history, in undo and in the phase report
exactly like any other phase.

`advance` throws if called in `SPAWN_CHOICE`.

A record whose phase ran a Life step also carries `preLifeUnits`: the board the step acted
on, which `after` no longer is — the history draws the ✕s and birth rings on it. It is
optional on `PhaseRecord` because games exported before it existed don't have it.

## Codec (`src/game/codec.ts`)

`encodeState(state) → Promise<string>` (deflate + base64url, for `#s=` links) and
`decodeState(s, map?) → Promise<GameState>`. Both are async: Compression Streams, the only
compression primitive available in both the browser and Node, is inherently async.
`exportGame`/`importGame` handle the full `{ state, history }` JSON and stay synchronous.

`decodeState` and `importGame` validate against the map before returning: every unit
resolves to a real province and coast, no two units share a province, season/phase/year are
sane, and every `centers` entry is a real, singly-owned supply centre — throwing a message
fit to show whoever opened the link.

## UI (`src/ui/`)

`main.ts` is the entry point esbuild bundles, and the only stateful object in the app is
the `App` class it exports: the GM's session (board, history, order text, view mode) plus
the wiring that puts the three regions — HUD, board, panel — on the page. Every module
beside it is a set of functions taking that `App` as their first argument, so `App`'s
fields are the shared surface of this one family rather than private state, and finding a
piece of the interface means opening the file named after it.

| File | What it owns | Lines |
| --- | --- | --- |
| `main.ts` | the `App` shell: session state, boot, adjudicate/undo/redo, board clicks and keys, `render()` | ~536 |
| `session.ts` | saved games (autosave, load, switch, rename), JSON import/export, share links, the board-image and results sharing, the Games and Game-file dialogs | ~379 |
| `order-entry.ts` | the order text model and its UI: the long-lived textarea, tabs, mode bar, inline errors and warnings, readiness strip, the adjudicate button and its problems-first confirm dialog | ~565 |
| `panel.ts` | the panel column's layout: results, the Life list, spawn-choice rows, sandbox banner, where the intro card and entry section go | ~290 |
| `history-views.ts` | what the history lists and what each entry puts on the board — pure, no DOM | ~73 |
| `hud.ts` | the bar over the map: phase header, tool buttons, history (undo/redo/phase picker), toasts | ~166 |
| `modals.ts` | the modal stack and its dialogs: coast picker, build picker, clipboard fallback, Help, Rules, the first-run card | ~170 |
| `gestures.ts` | phone layout: the mobile/desktop decision and its hysteresis, touch pan/pinch/double-tap, the bottom sheet's handle | ~149 |
| `board.ts` | the `Board` class: the layer stack and the overlays that move — units, order arrows, Life marks, selection | ~357 |
| `board-map.ts` | the map itself, built once: tiles, borders, canal, hit layer, labels, supply-centre dots, tile fills and hover | ~340 |
| `board-glyphs.ts` | the mark vocabulary shared by the overlays and the legend: unit and birth glyphs, arrows, hold brackets, crosses, arrowhead cache, segment geometry | ~315 |
| `board-export.ts` | export-only furniture: the title/phase caption and the symbol legend baked into the SVG for PNG export | ~217 |

- The map is jDip's `standard.svg` province paths behind a `MapArt` interface
  (`provincePath(id)`, `unitAnchor(loc)`). Art and graph are separate contracts — `MapArt`
  for the drawing, `MapData` for adjacency — and `map` is threaded as a parameter almost
  everywhere, so *rendering* a different board is a data change. A different **variant map**
  is not a data-only contribution today: `main.ts` constructs `STANDARD_MAP`/`STANDARD_ART`
  directly, `codec.ts` defaults to `STANDARD_MAP`, and `Power` and every palette in
  `colors.ts` are fixed to the seven standard powers. Those are the three places to change
  first.
- Two order-entry modes write the same order list: a per-power text box (tolerant parsing,
  errors shown inline) and click-on-board. During `SPAWN_CHOICE` the A/F buttons and a typed
  `Build F Edi` are the same act — the buttons write that line.
- **History is a list of *views*, not of records** (`history-views.ts`, `HistoryView`). Every
  mark is drawn on the board it acted on, never on the board it produced, so one record can
  be two things to look at: a **phase** view — `record.before` with that record's own arrows
  and result marks (a bounce ✕ sits where the move was stopped) — and, when the record has a
  Life step that did something, a **Life** view — the board the orders produced, with that
  step's ✕s and birth rings on it. `app.viewIndex` indexes this list; undo/redo still work on
  records, and both return to the live board. "Current" is the live board and carries no
  result or Life marks at all — only what the GM is entering now, and the Life *preview* if
  that toggle is on.
- **Adjudicating lands on the phase view it just produced** (`landOnLastPhase`), so the
  results are on the board and in the panel, ready to copy — and sets `landedOnAdjudication`.
  The first move toward the next phase — a keystroke in the box, a unit click, a power tab,
  the collapsed entry button, Adjudicate itself — calls `returnToLive()` and hands the board
  back. A view the GM picked from the dropdown never carries that flag, so nothing takes it
  away from them. When a Life step ran, the toast names the entry that shows it.
- The Life view's board is `record.preLifeUnits`, recorded by `flow.ts` because `after` no
  longer has the units that died. Exports predating the field are reconstructed from
  `after` + `life` by `preLifeUnits()`.
- Copy results, Copy PNG and Save PNG all act on the view on screen — a phase view copies its
  orders and results, a Life view its births and deaths, and the caption is the view's own
  label. The HUD's `Orders: on/off` toggle (`app.exportMarks`) exports the same view without
  the arrows and marks; the legend rows follow, since they are derived from what is drawn.
- Undo/redo over the history stack, export/import JSON, share links, PNG export.
- `src/ui/rules-text.ts` is the single source of the variant's rules. The Rules panel renders
  it, and the README's rules section is generated from it — `npm run rules:sync` rewrites
  that section, and `npm test` fails if it is stale.

## Generated data

No generator needs to run to install, test or build the app; all their output is committed.
Run them only to change the map or to re-port the DATC suite, and commit what they write.

- **The DATC suite** (`test/datc/cases.json`) is generated from the DATC test cases in
  the python `diplomacy` package's `test_datc.py`. To regenerate: `pip install diplomacy`,
  then `python3 test/datc/port_datc.py` (it reads the file from the installed package).
  See `test/datc/README.md` for the fixture schema.
- **The province graph** (`src/data/standard-map.json` + `src/engine/aliases.json`) is built
  by `src/data/build-standard-map.py`. It reads two things: `src/data/source/classic_diplomacy.json`,
  committed here as this project's source data (adjacency in the province/coast schema the
  engine uses), and `standard.map` from the installed python `diplomacy` package
  (`pip install diplomacy`) for province names, home centres, neutral centres and the 1901
  starting units. A path to `standard.map` can be passed as the first argument instead.
  Needs `python3` only.
- **The map art** (`src/data/standard-art.json` + `standard-art.ts`) is built by
  `src/data/build-standard-art.py`, which extracts province outlines, unit anchors and label
  positions from jDip's `standard.svg` — also read from the installed python `diplomacy`
  package, or from a path given as the first argument. This script needs `python3` **and**
  [shapely](https://shapely.readthedocs.io/): jDip's outlines don't tile, so it grows them
  into a true partition.

## Common changes

| Want to | Files |
| --- | --- |
| Add or change a variant rule | `src/game/life.ts` (the Life step itself) and/or `src/game/flow.ts` (when it runs); the rule text in `src/ui/rules-text.ts` + `npm run rules:sync`; tests in `test/game/life.test.ts` / `flow.test.ts` |
| Change how a phase is reported | `src/ui/report.ts`, `src/ui/phase-info.ts`; tests in `test/ui/report.test.ts` |
| Change what the history lists or shows | `src/ui/history-views.ts` (the views themselves), `hud.ts` (the picker), `panel.ts` (the entry's report); tests in `test/ui/history-views.test.ts` |
| Add a map | `src/data/` (a new `MapData` + `MapArtData` pair and their generators), then `src/ui/main.ts` and `src/game/codec.ts`, which name `STANDARD_MAP`/`STANDARD_ART` directly. Honestly: this is not a drop-in yet — `Power` in `src/engine/types.ts` and the palettes in `src/ui/colors.ts` are fixed to the seven standard powers, so a map with different powers needs those opened up first |
| Fix a UI bug | the module that owns it, per the [UI table](#ui-srcui): order entry → `src/ui/order-entry.ts`, panel layout → `panel.ts`, top bar/history/toasts → `hud.ts`, dialogs → `modals.ts`, saved games and sharing → `session.ts`, phone pan/zoom → `gestures.ts`, the board → `board.ts` / `board-map.ts` / `board-glyphs.ts` / `board-export.ts`, click-to-order → `interaction.ts`, styling → `web/style.css`. `src/ui/main.ts` is the shell: session state and wiring only |
| Change order parsing or resolution | `src/engine/parse.ts` / `src/engine/resolve.ts`; tests in `test/engine/`, and the DATC suite must stay green |
