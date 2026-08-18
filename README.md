# Conway's Game of Diplomacy

A GM's adjudicator for **Conway's Game of Diplomacy** — standard [Diplomacy](https://en.wikipedia.org/wiki/Diplomacy_(game)) on the standard map, with a step of Conway's Game of Life applied to the board twice a year. Units die of loneliness and overcrowding, and new units are born in empty provinces.

The variant is Ezio's, presented on DiploStrats: **[Conway's Game of Diplomacy](https://www.youtube.com/watch?v=1ffyKPaCW5g)**.

It runs entirely in the browser. There is no server, no account and no shared state — one person GMs, the app resolves the orders, and the results go back to the players as text and a board image.

- **Play/GM it here:** <https://apriiori.com/conway-diplomacy/>
- **Offline:** download the single-file build (`conway-diplomacy.html`, linked in the page footer) and open it from your own disk. It is one HTML file with everything inlined and works with no network at all.

<!-- RULES:BEGIN — generated from src/ui/rules-text.ts; run `npm run rules:sync` -->

## The variant, briefly

Standard [Diplomacy](https://en.wikipedia.org/wiki/Diplomacy_(game)) on the standard map, plus a step of Conway's Game of Life applied to the board twice a year. The variant is Ezio's, presented on DiploStrats: [Conway's Game of Diplomacy](https://www.youtube.com/watch?v=1ffyKPaCW5g).

A year runs: **Spring Movement → Spring Retreats** (if needed) **→ Life step → Summer Spawn Choices** (if needed) **→ Fall Movement → Fall Retreats** (if needed) **→ Winter Builds → Life step → Winter Spawn Choices** (if needed). The Life step runs whether or not anything was dislodged or built.

Resolution follows the standard rules of Diplomacy — nothing about movement, support, convoys, retreats or adjustments is changed. It is tested against 160 cases from the DATC, the standard adjudication test suite, ported from the python `diplomacy` package's `test_datc.py`.

## The Life step

A province's neighbours are the provinces it touches on the map — by land or by sea, and whether or not either unit type could actually move between them. Sea provinces count like any other, and a province with two coasts is one province. Every province updates simultaneously:

| Province | Occupied neighbours | Result |
| --- | --- | --- |
| occupied | 0–1 | the unit dies (loneliness) |
| occupied | 2–3 | survives |
| occupied | 4 or more | the unit dies (overcrowding) |
| empty | exactly 3 | a new unit is born |

A newborn unit belongs to whichever power supplied at least two of its three parents; with no such majority it is **neutral**.

Its type follows the province — fleet at sea, army inland — but on the coast it is the owning player's choice. Those choices are made in the **Spawn Choices** phase that follows a Life step, entered and reported as build orders: `England: Build F Edi`. If no choice is given, the new unit is an army.

## Neutral units

- They never move and are never ordered.
- They may receive support to hold, and they block movement and occupy their province like any unit.
- If dislodged, a neutral unit disbands, because it cannot submit a retreat.
- They never capture supply centres, and a neutral sitting on a home centre blocks a build there.
- They count as neighbours and as parents: two neutral parents plus one power's own parent produce a neutral birth, not a birth for that power.

A neutral's **unit type is a drawing convention, not a rule** — nothing in play can depend on it. At sea a neutral is drawn as a fleet, inland as an army, and on the coast the tool draws it as an army rather than asking.

## Edge cases

- **Split-coast spawns are this tool's own ruling.** A fleet born on Spain, Bulgaria or St Petersburg also names its coast, chosen by the owning player like the unit type. The video never addresses which coast a split-coast spawn takes; everything else on this page is either stated in the video or standard Diplomacy.
- Life runs after Spring's retreats even if nothing was dislodged, and after Winter's adjustments even if nobody built. Winter's order is builds and removals first, then Life — so a fresh build can die in the same Life pass, and no spawn occurs in a province a build was just placed in, because that province is already occupied when Life runs.
- Retreats resolve before Life: a unit that successfully retreated counts at its new province when Life runs, and a disbanded unit no longer counts as present.
- Two provinces are neighbours whenever they touch on the map, whether by land or by sea, and whether or not the units in them could actually move between them: an army in Marseilles and a fleet on Spain's north coast are neighbours, though the fleet could never move to Marseilles. A province with two coasts is one province, and Switzerland is excluded, since it can never hold a unit.
- Captures happen at the standard time, between Fall retreats and Winter builds. A Summer-born unit sitting on a centre through Fall captures it that Fall like any unit; a Winter-born unit captures at the next Fall; neutrals never capture.
- After the Winter Life step a power's unit count may differ from its centre count. Nothing corrects that until the following Winter.
- Civil disorder: unordered units hold. If a power owes removals it didn't order, the tool auto-removes the units furthest from home by the standard distance-from-home rule rather than prompting again.
- Controlling 18 supply centres is generally a solo victory, although this adjudicator doesn't enforce any particular win condition.
- If one unit is given more than one order, the last one wins, and the tool flags the unit so the GM can see it happened.

## Sharing and saving

- A **share link** hands anyone an independent copy of the current board — the same app, and nothing done there affects your game. Spawn-choice states are real board states, so they share too.
- The **offline build** (`conway-diplomacy.html`, linked in the page footer) is one HTML file with everything inlined; download it and open it from your own disk, with no network at all.
- **Export / Import JSON** saves or restores a whole game, history included.

<!-- RULES:END -->

## Testing the rules

Resolution follows the standard rules of Diplomacy, and is tested against 160 cases from the DATC — the standard adjudication test suite — ported from the python `diplomacy` package's `test_datc.py`. All 160 pass, and that is the project's gate.

The variant's own rules are tested to the same standard, not just the standard game underneath them.

- `test/game/life.test.ts` covers the Life step: loneliness, overcrowding and survival; majority births versus neutral ones; coastal births left pending versus sea and inland births resolved automatically; a neutral coastal birth resolving straight to an army; simultaneity (a unit dying this step still counts as a neighbour for everyone else); and the real 1901 opening board.
- `test/game/flow.test.ts` and `test/game/flow-e2e.test.ts` cover the phase machine — when Life runs and when it doesn't, the Summer and Winter spawn-choice steps and their coast validation, spawn decisions recorded as build orders, the plain-standard toggle that skips Life entirely, and a full game year played end to end on the real map through the real resolvers.
- `test/game/neutral-type-invariance.test.ts` proves the claim that a neutral's unit type is only a drawing convention. Every board in it is resolved once per rendering — as an army, and as a fleet on each coast — and the outcomes are required to be identical: the other powers' units, the centres, the dislodgement roster, every order's result and the whole Life step. It carries its own negative control, so it cannot pass by comparing nothing.

## Using it

Everything a GM needs is in the app itself — press **?** in the top bar (or **⋯ → How to run a game**) for the running instructions, which are deliberately kept there rather than here so they stay next to the buttons they describe.

In outline: name the game, then enter each turn's orders — paste the whole turn into the All tab with `France:` style headers, or put each player's orders in that player's own power tab, or click a unit on the board and then its destination. The readiness strip shows, per power, how many of that player's units have been given orders out of how many they have, and flags lines that didn't parse. Fix anything red, adjudicate, and send the results text and the board image to your players, wherever they post orders.

Games are saved in the browser, undo/redo is a full history scrubber, and a **share link** hands anyone an independent copy of the current board — the same app, and nothing they do there affects your game. **Export/Import JSON** saves or restores a whole game, history included, so a game can be backed up or moved to another browser.

## Developing

Node 22 or newer (the code uses JSON import attributes and Compression Streams).

```
npm install
npm test          # vitest — engine, Life, phase machine, codec, DATC suite
npm run typecheck
npm run dev       # build once, then esbuild watch + dev server on http://localhost:8000
npm run build     # dist/: hosted page + the single-file offline build
npm run rules:sync  # regenerate the README rules section from src/ui/rules-text.ts
```

`npm run dev` serves `dist/`, rebuilding the bundle on every source change; edits to `web/` need a `npm run dev` restart (or a `npm run build`) to be picked up.

`npm run build` produces `dist/index.html` + `dist/app.js` + `dist/style.css` + `dist/LICENSE-map.txt` (the hosted page), and `dist/conway-diplomacy.html` — one self-contained file with the CSS inlined and the bundle inlined as an IIFE, so it opens straight from `file://`.

The rules above are generated from `src/ui/rules-text.ts`, which the app's Rules panel also renders — edit them there, not here, and `npm run rules:sync` writes them back into this file. `npm test` fails if the two have drifted.

Module contracts, the phase machine, the codec and the generated map/DATC data are documented in [`docs/DEVELOPING.md`](docs/DEVELOPING.md). [`CONTRIBUTING.md`](CONTRIBUTING.md) has the checks a pull request has to pass.

## Licence

Copyright © 2026 ApriiSR. GPL-2.0-or-later (see [`LICENSE`](LICENSE)).

The province geometry is derived from `standard.svg`, the detailed standard map shipped with [jDip](https://jdip.sourceforge.net/) — bitmap by J. Fatula III, SVG by Zach DelProposto, © jDip. That file's header states "GPL License" and names no version, so this project distributes the derived geometry under GPL-2.0-or-later, which is why the app is GPL too. Only the geometry is reused; the app draws its own SVG at runtime. See [`web/LICENSE-map.txt`](web/LICENSE-map.txt) for the full map attribution.

The DATC test fixture (`test/datc/cases.json`) is generated from the DATC test cases in the python [`diplomacy`](https://github.com/diplomacy/diplomacy) package, which is AGPL-3.0; the fixture is a development-time test asset only and is not part of the built app. The map graph is likewise parsed from that package's `standard.map`. See [`test/datc/README.md`](test/datc/README.md).

"Diplomacy" is a trademark of Avalon Hill / Hasbro. This is an unofficial fan-made tool for a variant and is not affiliated with them.
