#!/usr/bin/env python3
"""Ports the python `diplomacy` package's DATC test suite into a data-driven
JSON fixture (`cases.json`) for the TypeScript engine to run against.

Source of truth is the AST of the upstream test file — this script is
re-runnable any time that file changes; do NOT hand-edit `cases.json`.

Usage:
    python3 test/datc/port_datc.py [path/to/test_datc.py] [-o cases.json]

With no path given, the installed python `diplomacy` package is located on
`sys.path` and its `tests/test_datc.py` is used (`pip install diplomacy`).

See test/datc/README.md for the emitted JSON schema.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

def _installed_datc() -> Path | None:
    """`tests/test_datc.py` inside the installed `diplomacy` package, if it is importable."""
    try:
        import importlib.util

        spec = importlib.util.find_spec("diplomacy")
    except Exception:
        return None
    if not spec or not spec.origin:
        return None
    candidate = Path(spec.origin).parent / "tests" / "test_datc.py"
    return candidate if candidate.exists() else None


DEFAULT_INPUT = _installed_datc()
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "cases.json"

# diplomacy.utils.order_results names -> our engine's OrderResult union (types.ts).
RESULT_MAP = {
    "OK": "ok",
    "BOUNCE": "bounce",
    "VOID": "void",
    "CUT": "cut",
    "DISLODGED": "dislodged",
    "DISRUPTED": "disrupted",
    "DISBAND": "disband",
    "NO_CONVOY": "no-convoy",
}

DOC_HEADER = re.compile(r"^\s*(\d+\.[A-Z]+\.\d+)\.?\s+TEST CASE,?\s*(.*)$")
PHASE_RE = re.compile(r"^([SFW])(\d{4})([MRA])$")

SEASON_MAP = {"S": "SPRING", "F": "FALL", "W": "WINTER"}
KIND_MAP = {"M": "MOVEMENT", "R": "RETREAT", "A": "ADJUSTMENT"}


class PortError(Exception):
    """Raised for a statement/expression this porter doesn't understand.

    Caught per-test so the offending case is emitted with `unsupported`
    instead of silently dropped.
    """


def lit(node: ast.AST):
    return ast.literal_eval(node)


def as_str_list(node: ast.AST) -> list[str]:
    """A python arg that's either a single order/unit string or a list of them."""
    value = lit(node)
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return list(value)
    raise PortError(f"expected str or list of str, got {value!r}")


def parse_unit_ref(s: str) -> dict:
    """'F STP/NC' -> {'type': 'F', 'loc': 'stp/nc'}"""
    parts = s.strip().split(None, 1)
    if len(parts) != 2 or parts[0] not in ("A", "F"):
        raise PortError(f"can't parse unit reference {s!r}")
    utype, loc = parts
    return {"type": utype, "loc": loc.strip().lower()}


def parse_province(s: str) -> str:
    """Province id without coast, lowercase: 'STP/NC' or 'STP' -> 'stp'."""
    return s.strip().split("/")[0].lower()


def parse_phase(s: str) -> dict:
    m = PHASE_RE.match(s.strip())
    if not m:
        raise PortError(f"can't parse phase string {s!r}")
    season, year, kind = m.groups()
    return {"season": SEASON_MAP[season], "year": int(year), "kind": KIND_MAP[kind]}


class TestPorter:
    def resolve_result_name(self, node: ast.AST) -> str:
        if isinstance(node, ast.Name) and node.id in RESULT_MAP:
            return RESULT_MAP[node.id]
        raise PortError(f"not a recognised order-result name: {ast.dump(node)}")

    # ---- statement-level dispatch -----------------------------------------

    def port_call_stmt(self, call: ast.Call) -> list[dict] | None:
        """A bare `self.xxx(game, ...)` or `game.xxx(...)` expression-statement.
        Returns a list of steps (usually 0 or 1), or None if it's a no-op we skip
        (create_game / clear helpers routed elsewhere aren't here — this only
        handles the setup calls)."""
        func = call.func
        if not isinstance(func, ast.Attribute):
            raise PortError(f"unexpected call shape: {ast.dump(call)}")
        attr = func.attr

        if attr == "create_game":
            return []
        if attr == "clear_units":
            return [{"op": "clear_units"}]
        if attr == "clear_centers":
            return [{"op": "clear_centers"}]
        if attr == "process":
            return [{"op": "process"}]
        if attr == "move_to_phase":
            phase_str = lit(call.args[-1])
            return [{"op": "set_phase", "phase": phase_str, **parse_phase(phase_str)}]
        if attr == "set_units":
            power = lit(call.args[1])
            units = [parse_unit_ref(u) for u in as_str_list(call.args[2])]
            return [{"op": "set_units", "power": power, "units": units}]
        if attr == "set_centers":
            power = lit(call.args[1])
            centers = [parse_province(c) for c in as_str_list(call.args[2])]
            return [{"op": "set_centers", "power": power, "centers": centers}]
        if attr == "set_orders":
            power = lit(call.args[1])
            orders = [o.strip() for o in as_str_list(call.args[2])]
            return [{"op": "orders", "power": power, "orders": orders}]
        raise PortError(f"unhandled setup call: self.{attr}(...)")

    def port_assert(self, test: ast.expr) -> list[dict]:
        # not check_dislodged(game, unit, dislodger)
        if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            inner = test.operand
            if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name) and inner.func.id == "check_dislodged":
                unit = parse_unit_ref(lit(inner.args[1]))
                return [{"op": "expect_not_dislodged", "unit": unit}]
            raise PortError(f"unhandled negated assert: {ast.dump(test)}")

        # check_dislodged(game, unit, dislodger)  [module-level helper, no self.]
        # `dislodger` is a full unit string like 'F LON'; the upstream helper compares
        # against just the attacking province code (type token dropped, coast ignored).
        if isinstance(test, ast.Call) and isinstance(test.func, ast.Name) and test.func.id == "check_dislodged":
            unit = parse_unit_ref(lit(test.args[1]))
            attacker_from = parse_province(parse_unit_ref(lit(test.args[2]))["loc"])
            return [{"op": "expect_dislodged", "unit": unit, "from": attacker_from}]

        # self.check_results(game, unit, VALUE[, phase='X'])
        if (
            isinstance(test, ast.Call)
            and isinstance(test.func, ast.Attribute)
            and test.func.attr == "check_results"
        ):
            unit = parse_unit_ref(lit(test.args[1]))
            value_node = test.args[2]
            phase = "M"
            for kw in test.keywords:
                if kw.arg == "phase":
                    phase = lit(kw.value)
            if isinstance(value_node, ast.List):
                results = [self.resolve_result_name(e) for e in value_node.elts]
                return [{"op": "expect_result", "unit": unit, "results": results, "phase": phase, "exact": True}]
            result = self.resolve_result_name(value_node)
            return [{"op": "expect_result", "unit": unit, "results": [result], "phase": phase, "exact": False}]

        # self.owner_name(game, unit) == 'POWER'   or   is None   or bare-truthy
        if isinstance(test, ast.Compare) and self._is_owner_name_call(test.left):
            unit = parse_unit_ref(lit(test.left.args[1]))
            op = test.ops[0]
            comparator = test.comparators[0]
            if isinstance(op, ast.Eq):
                power = lit(comparator)
                return [{"op": "expect_owner", "unit": unit, "power": power}]
            if isinstance(op, ast.Is) and isinstance(comparator, ast.Constant) and comparator.value is None:
                return [{"op": "expect_owner", "unit": unit, "power": None}]
            raise PortError(f"unhandled owner_name comparison: {ast.dump(test)}")

        if self._is_owner_name_call(test):
            # bare `assert self.owner_name(game, unit)` -- "someone (don't care who) owns it"
            unit = parse_unit_ref(lit(test.args[1]))
            return [{"op": "expect_owned", "unit": unit}]

        # `A or B` of owner_name comparisons/bare-truthy ("one of these two is true")
        if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.Or):
            options: list[dict] = []
            for value in test.values:
                steps = self.port_assert(value)
                if len(steps) != 1 or steps[0]["op"] not in ("expect_owner", "expect_owned"):
                    raise PortError(f"unhandled BoolOp branch: {ast.dump(value)}")
                options.append(steps[0])
            return [{"op": "expect_owner_one_of", "options": options}]

        raise PortError(f"unhandled assert expression: {ast.dump(test)}")

    @staticmethod
    def _is_owner_name_call(node: ast.AST) -> bool:
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "owner_name"
        )

    # ---- statement-tree walk -----------------------------------------------

    def port_stmts(self, stmts: list[ast.stmt]) -> list[dict]:
        steps: list[dict] = []
        for stmt in stmts:
            if isinstance(stmt, ast.Assign):
                # only `game = self.create_game()` seen in practice; nothing to emit.
                continue
            if isinstance(stmt, ast.If):
                # Only guard pattern seen: `if game.phase_type in ('A','R'):` --
                # always true in context (the preceding process() already produced
                # that phase), so flatten unconditionally.
                steps.extend(self.port_stmts(stmt.body))
                if stmt.orelse:
                    raise PortError("unexpected else-branch on phase_type guard")
                continue
            if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
                result = self.port_call_stmt(stmt.value)
                if result:
                    steps.extend(result)
                continue
            if isinstance(stmt, ast.Assert):
                steps.extend(self.port_assert(stmt.test))
                continue
            raise PortError(f"unhandled statement: {ast.dump(stmt)}")
        return steps

    def port_test(self, func: ast.FunctionDef) -> dict:
        doc = ast.get_docstring(func) or ""
        lines = [l.strip() for l in doc.split("\n")]
        header = DOC_HEADER.match(lines[0])
        if not header:
            raise PortError(f"docstring header didn't match expected format: {lines[0]!r}")
        case_id, title = header.group(1), header.group(2).strip()
        description = " ".join(l for l in lines[1:] if l).strip()

        case = {"id": case_id, "title": title, "description": description}
        try:
            case["steps"] = self.port_stmts(func.body[1:])  # [0] is the docstring
        except PortError as exc:
            case["unsupported"] = str(exc)
            case["steps"] = []
        return case


def port(input_path: Path) -> tuple[list[dict], list[str]]:
    tree = ast.parse(input_path.read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "TestDATC")
    test_funcs = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name.startswith("test_")]

    porter = TestPorter()
    cases = [porter.port_test(f) for f in test_funcs]

    unsupported = [f"{c['id']}: {c['unsupported']}" for c in cases if c.get("unsupported")]
    return cases, unsupported


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", nargs="?", type=Path, default=DEFAULT_INPUT)
    ap.add_argument("-o", "--output", type=Path, default=DEFAULT_OUTPUT)
    args = ap.parse_args()

    if args.input is None:
        print(
            "error: no input given and the `diplomacy` package is not importable "
            "(pip install diplomacy, or pass path/to/test_datc.py)",
            file=sys.stderr,
        )
        return 1
    if not args.input.exists():
        print(f"error: input file not found: {args.input}", file=sys.stderr)
        return 1

    cases, unsupported = port(args.input)
    args.output.write_text(json.dumps(cases, indent=2) + "\n")

    print(f"ported {len(cases)} cases -> {args.output}")
    if unsupported:
        print(f"{len(unsupported)} unsupported:")
        for u in unsupported:
            print(f"  - {u}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
