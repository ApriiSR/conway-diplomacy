#!/usr/bin/env python3
"""Generate src/data/standard-map.json (MapData shape) for the Conway Diplomacy engine.

Sources:
  - source/classic_diplomacy.json  -- province types + adjacency, committed beside this
                                      script as this project's source data
  - standard.map                   -- full province names, home centres, neutral supply
                                      centres, 1901 starting units; read from the installed
                                      python `diplomacy` package (`pip install diplomacy`),
                                      the same place build-standard-art.py and
                                      test/datc/port_datc.py read their sources from

The generated output is committed, so this only needs running to change the map itself.
Run:  python3 src/data/build-standard-map.py [path/to/standard.map]
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_JSON = os.path.join(HERE, "source", "classic_diplomacy.json")


def _installed_map():
    """`maps/standard.map` inside the installed `diplomacy` package, if importable."""
    try:
        import importlib.util

        spec = importlib.util.find_spec("diplomacy")
    except Exception:
        return None
    if not spec or not spec.origin:
        return None
    path = os.path.join(os.path.dirname(spec.origin), "maps", "standard.map")
    return path if os.path.exists(path) else None


SRC_MAP = sys.argv[1] if len(sys.argv) > 1 else _installed_map()
OUT = os.path.join(HERE, "standard-map.json")
OUT_ALIASES = os.path.join(HERE, "..", "engine", "aliases.json")

POWERS = ["AUSTRIA", "ENGLAND", "FRANCE", "GERMANY", "ITALY", "RUSSIA", "TURKEY"]


def strip_coast(loc):
    return loc.split("/")[0]


def load_names(path):
    """Province id -> display name, from the '<Name> = <aliases>' block."""
    names = {}
    with open(path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            left, right = line.split("=", 1)
            name = left.strip()
            aliases = right.split()
            if not name or not aliases:
                continue
            pid = aliases[0].lower()
            if "/" in pid or "(" in pid:
                continue  # coast entry, e.g. "Spain (north coast) = spa/nc ..."
            if not re.fullmatch(r"[a-z]{3}", pid):
                continue
            names.setdefault(pid, name)
    return names


def load_aliases(path):
    """Loc id (with coast) -> list of accepted spellings, from the alias block."""
    aliases = {}
    with open(path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if "=" not in line or line.lstrip().startswith("#") or " ABUTS " in line:
                continue
            left, right = line.split("=", 1)
            name = left.strip()
            words = right.split()
            if not name or not words:
                continue
            loc = words[0].lower().replace("(", "/").replace(")", "")
            if not re.fullmatch(r"[a-z]{3}(/[a-z]{2})?", loc):
                continue
            spellings = {name.lower()}
            for w in words:
                w = w.lower().replace("+", " ")
                w = w.replace("(", " (")
                spellings.add(w.strip())
            aliases.setdefault(loc, set()).update(spellings)
    return {k: sorted(v) for k, v in sorted(aliases.items())}


def load_powers(path):
    """Returns (home_centers, starting_units, neutral_scs)."""
    home = {}
    units = []
    neutral = []
    cur = None
    with open(path) as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            m = re.match(r"^([A-Z]+)\s+\(([A-Z]+)\)\s+(.*)$", line)
            if m and m.group(1) in POWERS:
                cur = m.group(1)
                home[cur] = [p.lower() for p in m.group(3).split()]
                continue
            m = re.match(r"^UNOWNED\s+(.*)$", line)
            if m:
                cur = None
                neutral = [p.lower() for p in m.group(1).split()]
                continue
            m = re.match(r"^([AF])\s+([A-Za-z/]+)\s*$", line)
            if m and cur:
                units.append({"power": cur, "type": m.group(1), "loc": m.group(2).lower()})
                continue
            if line.startswith("BEGIN") or line.startswith("#"):
                continue
            if "=" in line or " ABUTS " in line:
                cur = None
    return home, units, neutral


def main():
    if not SRC_MAP or not os.path.exists(SRC_MAP):
        sys.exit(
            "standard.map not found: install the python `diplomacy` package "
            "(`pip install diplomacy`) or pass the path as the first argument"
        )
    raw = json.load(open(SRC_JSON))["provinces"]
    names = load_names(SRC_MAP)
    home_centers, starting_units, neutral_scs = load_powers(SRC_MAP)

    home_of = {}
    for power, provs in home_centers.items():
        for p in provs:
            home_of[p] = power
    sc_set = set(neutral_scs) | set(home_of)

    # Impassable/off-board references (Switzerland leaks into a couple of coastal
    # abut lists in the source data) are dropped.
    def keep(locs):
        return sorted(l for l in locs if strip_coast(l) in raw)

    provinces = {}
    for pid, info in sorted(raw.items()):
        coasts = sorted(info.get("coasts", {}).keys())
        if coasts:
            fleet_adj = {c: keep(info["coasts"][c]) for c in coasts}
        else:
            fleet_adj = {"": keep(info.get("fleet_adj", []))} if info.get("fleet_adj") else {}
        provinces[pid] = {
            "id": pid,
            "name": names.get(pid, pid.upper()),
            "type": info["type"],
            "sc": pid in sc_set,
            "home": home_of.get(pid),
            "coasts": coasts,
            "armyAdj": keep(info.get("army_adj", [])),
            "fleetAdj": fleet_adj,
        }

    # Life adjacency: symmetric closure of (army_adj U fleet_adj), coasts stripped, no self-edges.
    life = {pid: set() for pid in provinces}
    for pid, info in raw.items():
        neigh = list(info.get("army_adj", [])) + list(info.get("fleet_adj", []))
        for coast_list in info.get("coasts", {}).values():
            neigh.extend(coast_list)
        for n in neigh:
            n = strip_coast(n)
            if n == pid or n not in life:
                continue
            life[pid].add(n)
            life[n].add(pid)
    life_adjacency = {pid: sorted(v) for pid, v in sorted(life.items())}

    starting_centers = {p: sorted(home_centers[p]) for p in POWERS}

    data = {
        "provinces": provinces,
        "lifeAdjacency": life_adjacency,
        "startingUnits": starting_units,
        "startingCenters": starting_centers,
    }

    # ---- verification ----
    errs = []
    if len(provinces) != 75:
        errs.append(f"expected 75 provinces, got {len(provinces)}")
    n_sc = sum(1 for p in provinces.values() if p["sc"])
    if n_sc != 34:
        errs.append(f"expected 34 supply centres, got {n_sc}")
    if len(starting_units) != 22:
        errs.append(f"expected 22 starting units, got {len(starting_units)}")
    for pid, ns in life_adjacency.items():
        if pid in ns:
            errs.append(f"self-edge at {pid}")
        for n in ns:
            if pid not in life_adjacency[n]:
                errs.append(f"asymmetric life edge {pid}->{n}")
        if len(ns) != len(set(ns)):
            errs.append(f"duplicate life edge at {pid}")
    # movement adjacency sanity: every referenced loc resolves
    for pid, p in provinces.items():
        for loc in p["armyAdj"]:
            if "/" in loc:
                errs.append(f"{pid} armyAdj has coast {loc}")
            if strip_coast(loc) not in provinces:
                errs.append(f"{pid} armyAdj unknown {loc}")
        for coast, locs in p["fleetAdj"].items():
            for loc in locs:
                base, _, c = loc.partition("/")
                if base not in provinces:
                    errs.append(f"{pid} fleetAdj unknown {loc}")
                elif c and c not in provinces[base]["coasts"]:
                    errs.append(f"{pid} fleetAdj bad coast {loc}")
                elif not c and provinces[base]["coasts"]:
                    errs.append(f"{pid} fleetAdj missing coast for {loc}")
    # fleet adjacency symmetry (coast-aware)
    for pid, p in provinces.items():
        for coast, locs in p["fleetAdj"].items():
            src = pid if not coast else f"{pid}/{coast}"
            for loc in locs:
                base, _, c = loc.partition("/")
                back = provinces[base]["fleetAdj"].get(c, [])
                if src not in back:
                    errs.append(f"asymmetric fleet edge {src} -> {loc}")
    for pid, p in provinces.items():
        for loc in p["armyAdj"]:
            if pid not in provinces[loc]["armyAdj"]:
                errs.append(f"asymmetric army edge {pid} -> {loc}")
    for u in starting_units:
        base = strip_coast(u["loc"])
        if base not in provinces:
            errs.append(f"starting unit at unknown {u['loc']}")

    if errs:
        for e in errs:
            print("ERROR:", e, file=sys.stderr)
        sys.exit(1)

    with open(OUT, "w") as fh:
        json.dump(data, fh, indent=1, sort_keys=False)
        fh.write("\n")
    aliases = load_aliases(SRC_MAP)
    aliases = {loc: sp for loc, sp in aliases.items() if strip_coast(loc) in provinces}
    with open(os.path.abspath(OUT_ALIASES), "w") as fh:
        json.dump(aliases, fh, indent=1, sort_keys=True)
        fh.write("\n")

    print(f"wrote {OUT}: {len(provinces)} provinces, {n_sc} SCs, {len(starting_units)} units")
    print(f"wrote {os.path.abspath(OUT_ALIASES)}: {len(aliases)} locations")


if __name__ == "__main__":
    main()
