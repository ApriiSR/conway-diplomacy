# Contributing

The internals — module contracts, the phase machine, the codec, the generated
map and DATC data — are in [`docs/DEVELOPING.md`](docs/DEVELOPING.md). Read that
first; this file is only the housekeeping.

## Before you open a pull request

Node 22 or newer (the code uses JSON import attributes and Compression Streams).

```
npm install
npm run typecheck
npm test        # 313 tests, including all 160 DATC cases
npm run build
```

All four run in CI on every push and pull request, and all four have to pass.
If you changed a rule, add or change the test that pins it — the test suite is
the reason anyone should trust this adjudicator.

## The README's rules section is generated

Do **not** edit the block between the `RULES:BEGIN` and `RULES:END` markers in
`README.md`. It is rendered from `src/ui/rules-text.ts`, which is also what the
app's Rules panel shows. Edit the text there, then run:

```
npm run rules:sync
```

and commit both files. `npm test` fails if the two have drifted.

## The generated data files

`src/data/standard-map.json`, `src/engine/aliases.json`, `src/data/standard-art.json`
and `test/datc/cases.json` are generated and committed. Nothing about installing,
testing or building the app needs their generators — you only need these if you
are changing the map or re-porting the DATC suite:

| Script | Needs |
| --- | --- |
| `src/data/build-standard-map.py` | the python `diplomacy` package (`pip install diplomacy`), for `standard.map` |
| `src/data/build-standard-art.py` | the python `diplomacy` package, for `standard.svg`, plus [shapely](https://shapely.readthedocs.io/) |
| `test/datc/port_datc.py` | the python `diplomacy` package, for `tests/test_datc.py` |

Commit the regenerated output alongside the change.

## Licence

This project is GPL-2.0-or-later; contributions are accepted under the same
terms. See [`LICENSE`](LICENSE) and [`web/LICENSE-map.txt`](web/LICENSE-map.txt).
