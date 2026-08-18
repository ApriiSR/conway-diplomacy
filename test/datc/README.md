# DATC fixture

`cases.json` is a data-driven port of the python `diplomacy` package's DATC
suite (`test_datc.py`, 160 cases). It is **generated**, not hand-written —
regenerate with:

```
python3 test/datc/port_datc.py
```

(with no argument it locates `tests/test_datc.py` inside the installed python
`diplomacy` package — `pip install diplomacy` — and any other path can be
passed as the first arg). The script prints
the case count and any `unsupported` cases with reasons; as of this port,
**0 of 160 are unsupported** (no `add_rule`/`remove_rule`/`NO_CHECK` usage in
the upstream suite, so nothing needed dropping).

Provenance: the upstream `test_datc.py` belongs to the python `diplomacy` package
(AGPL-3.0). This fixture is derived from it and is used only as a development-time
test asset — it is never shipped in the built app. The DATC cases themselves are
Lucas Kruijswijk's Diplomacy Adjudicator Test Cases.

`datc.test.ts` is the vitest runner that drives `src/engine/*` through each
case and asserts the expectations.

## Case shape

```ts
{ id: "6.A.1", title: string, description: string, unsupported?: string, steps: Step[] }
```

`id`/`title` come from the docstring header (`"6.A.1 TEST CASE, <TITLE>"`);
`description` is the rest of the docstring, flattened to one line.

## Steps

Each case is a flat list of steps, applied in order against one `GameState`
(mutations, order submission, `process`, then assertions — repeat). This
mirrors the upstream test bodies exactly: `if game.phase_type == 'A'/'R':`
guards were flattened unconditionally (in every occurrence, the preceding
`process()` had already produced that phase, so the guard is always true in
context).

- `clear_units` / `clear_centers` — reset that half of the board.
- `set_units { power, units: [{type, loc}] }` — **replaces** that power's
  units (matches `game.set_units`, called once per power per test).
- `set_centers { power, centers: [provinceId] }` — same, for SC ownership.
- `set_phase { phase: "W1901A", season, year, kind }` — jumps straight to a
  phase (`kind` is `MOVEMENT`/`RETREAT`/`ADJUSTMENT`); only ever `W1901A` in
  the source (retreat-phase entry always happens organically via a preceding
  `process()` that produced dislodgements).
- `orders { power, orders: [string] }` — raw judge-notation order lines
  (`"A NWY - SWE VIA"`, `"F NTH R HOL"`, `"A WAR B"`, `"F LYO D"`), untouched
  from the python source. Multiple consecutive `orders` steps (one per power)
  accumulate into a single submission consumed by the next `process`.
- `process` — resolve the current phase (movement/retreat/adjustment) and
  advance.
- `expect_owner { unit, power: Power | null }` — who (if anyone) occupies that
  loc afterward. `null` = unoccupied.
- `expect_owned { unit }` — someone occupies it, don't care who (a handful of
  upstream asserts are bare-truthy `self.owner_name(...)` with no `==`).
- `expect_owner_one_of { options: [{unit, power}] }` — upstream's one `or`
  assertion (6.J.2: "removes A PAR *or* the civil-disorder pick between PIC
  and NAO", never both).
- `expect_dislodged { unit, from: provinceId }` / `expect_not_dislodged` —
  was this unit dislodged this movement phase, and by an attack from where.
- `expect_result { unit, results: OrderResult[], phase: "M"|"R"|"A", exact }` —
  see below.

`unit`/`loc` are lowercase engine form throughout (`"stp/nc"`, not
`"STP/NC"`); order text keeps upstream's uppercase judge notation as-is since
`parseOrders` is documented as tolerant.

## `expect_result` semantics — NOT a naive "does this code appear" check

This is the fiddly part; it mirrors upstream `check_results` exactly (see
`port_datc.py`'s `TestPorter.port_assert` and the runner's `checkResult`):

- **phase `M` (default)**: `results` is always one value.
  - `void`: passes if `'void'` is recorded for that unit **or** the unit
    received no order at all this phase. Upstream's python engine never
    literally records VOID in movement results — it recognizes void via "this
    unit's order was rejected pre-resolution, so it's absent from
    `ordered_units`" — but our engine's `OrderResult` type has `'void'` as a
    first-class value, so the runner accepts *either* signal to stay
    compatible with either design.
  - `ok`: passes if nothing but `'ok'` is recorded (i.e. no bounce/cut/etc.) —
    upstream OK means "order_status is empty", not "contains OK".
  - anything else (`bounce`/`cut`/`dislodged`/`disrupted`/`disband`/
    `no-convoy`): membership. A unit can get **two** separate `expect_result`
    steps (e.g. 6.A.5's Yorkshire army is both `void` — the move itself is
    illegal — and `dislodged` — it still gets rolled by the German attack).
- **phase `R` (retreat)**: same `void` rule. `ok` passes if the unit has *no*
  recorded results (upstream: not in `game.popped` and empty result list) —
  a successfully-retreating unit is not expected to accumulate a result.
  Anything else is membership, and a failed retreat/disband typically shows
  up as **two** codes on the same unit (e.g. `bounce` + `disband`, each its
  own `expect_result` step) — this is exactly what a contested retreat looks
  like: bounced off the spot it tried, then removed since it had nowhere else
  to go.
- **phase `A` (adjustment)**: `exact: true` cases (`results` is a real list,
  e.g. `["void", "ok"]`) must match the engine's recorded result list for
  that unit **exactly, in order** — this is how upstream encodes "two build
  orders for the same province: first succeeds, second doesn't" (both keyed
  under the one province). `exact: false` only ever appears with
  `results: ["void"]` (one case, 6.B.14) and uses the same void-membership
  rule as M/R.

Result matching is by **order → unit (type + loc)**, not by original test
target string — an order's `unit` field is compared against the step's `unit`
ref using `locMatches` (province always; coast too, but only when the ref
specifies one — e.g. `"F STP/NC"` requires the coast, `"F STP"` matches
either).

## Where the runner expects the engine to be

`datc.test.ts` imports `parseOrders`/`resolveMovement`/`resolveRetreats`/
`resolveAdjustments` from `src/engine/index.ts`. If those are ever split across
multiple files, update that one import — everything else is
engine-shape-agnostic. A missing or renamed export is a hard failure, not a
skip: the suite is the project's gate, so it must never quietly pass by running
nothing.
