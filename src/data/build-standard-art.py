#!/usr/bin/env python3
"""Extract map art (province outlines, unit anchors, label + SC dot positions) from the
jDip standard map SVG shipped with the python `diplomacy` package.

Source SVG: diplomacy/maps/svg/standard.svg -- "SVG by Zach DelProposto", jDip, GPL.
We take only geometry, not the shipped stylesheet or bitmap; the app renders its own SVG.
See LICENSE-map.txt beside the served page for the attribution we ship.

Outputs (beside this script):
  standard-art.json  -- the data
  standard-art.ts    -- `export const STANDARD_ART: MapArtData = <json>;`

jDip's outlines do not tile: neighbours are separated by a gap of 0-7 units (and by up to
~25 out in the open ocean). Rather than hide that under a fat border stroke, this script
turns the outlines into a true partition -- see `build_tiles` -- and ships the tiles as the
province geometry. `raw` keeps jDip's original path beside each one.

Run (shapely is required):
  python3 src/data/build-standard-art.py [path/to/standard.svg]

With no argument the SVG is read from the installed python `diplomacy` package
(`diplomacy/maps/svg/standard.svg`).
"""

import json
import math
import os
import re
import sys

from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.geometry import box as make_box
from shapely.geometry.polygon import orient
from shapely.ops import polylabel, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))


def _installed_svg():
    """`maps/svg/standard.svg` inside the installed `diplomacy` package, if importable."""
    try:
        import importlib.util

        spec = importlib.util.find_spec("diplomacy")
    except Exception:
        return None
    if not spec or not spec.origin:
        return None
    path = os.path.join(os.path.dirname(spec.origin), "maps", "svg", "standard.svg")
    return path if os.path.exists(path) else None


DEFAULT_SVG = _installed_svg()
OUT_JSON = os.path.join(HERE, "standard-art.json")
OUT_TS = os.path.join(HERE, "standard-art.ts")

# The jDip MapLayer/MouseLayer geometry lives in a translated group; anchors, labels and
# supply-centre dots are in the untranslated page frame. We keep the offset as data and
# let the renderer wrap the province paths in a <g transform>.
PATH_OFFSET = (-195, -170)

# Fragments in MapLayer that are not provinces.
NON_PROVINCE = {"unplayable", "unplayable_water"}
# jDip draws the water *inside* two provinces as its own `class="water"` path: the
# Danish belts between Jutland and the islands, and the Bosporus splitting European
# from Asian Constantinople. Concatenating these into the province outline fills them as
# land -- the "sliver of Turkey through the middle of Con" and Denmark's
# solid-green belt. Keep them out of the fill path and draw them over it in sea colour;
# they stay part of the province for click purposes (jDip's MouseLayer groups them too).
WATER_INSET_OF = {"constantinople_water": "con", "denmark_water": "den"}

# jDip has no Kiel canal (its Kie is one solid blob). Backstabbr draws one, and it is how
# a reader remembers that Kie touches both HEL and BAL. Geometry measured, not eyeballed:
# these are the two nearest points of the Kie/HEL and Kie/BAL borders (in the same
# translated coordinates as the province paths), each pulled ~3 units back inland. The
# channel is drawn under the border pass, so stopping just short of the coast keeps Kie's
# outline continuous while the water still reads as running into HEL and BAL.
# Deliberately overshooting: Kie's coasts sit at x≈890.5 and x≈934 along this line, and
# both endpoints are ~6 units out to sea. The renderer clips the band to Kie's tile, so the
# overshoot is what guarantees the channel meets the water at both ends with no cap and no
# stub -- the earlier arrangement stopped the line short of the coast and relied on a
# 6-unit border pass to bridge the difference.
CANALS = {"kie": "M 884 837 L 940 836"}


# jDip spells five seas differently from the engine map (which follows standard.map's
# first alias). Canonicalise to the engine's spelling; the old spelling stays as an alias.
CANON = {"gol": "lyo", "mid": "mao", "nat": "nao", "nrg": "nwg", "tyn": "tys"}

# Corrections to jDip's label placement, as (dx, dy) nudges in page coordinates. jDip drew
# its labels at a smaller size and beside *its* supply-centre symbol; our label type is
# bigger and our SC dot is a fat disc, so a handful of labels land on a dot, on a
# neighbouring label, or over the border in the wrong province.
#
# These are not eyeballed. `check_furniture` tests every label anchor for containment in
# its own province and for collision with every other label box, unit glyph and SC disc,
# and searches outward (preferring the direction of the province centroid) for the nearest
# clean anchor; the build prints the exact override to paste. Re-run the build after
# editing this table until it reports zero violations.
LABEL_OVERRIDES = {
    "alb": (1.6, -5.8),
    "apu": (4.8, -3.6),
    "cly": (-2.3, -3.2),
    "edi": (5.7, 1.8),
    "hol": (-5.7, 2),
    "lon": (43.3, 32.2),
    "nap": (-0.3, 4),
    "rom": (7.5, -2.8),
    "vie": (1, -3.9),
    "wal": (-4, 0.4),
}

# Two of jDip's unit anchors sit a hair over their own border once centred, so the glyph
# reads as belonging to the neighbour. Nudged toward the centroid, as the build's
# unit-anchor check prints. Coast anchors (bul/ec, bul/sc) are deliberately offshore and
# are left where jDip put them.
UNIT_ANCHOR_OVERRIDES = {
    "edi": (-1.9, -5.4),
    "yor": (-13.9, -2.7),
}

# jDip's supply-centre symbol anchors are occasionally parked in a province corner rather
# than near its unit. Same idea: (dx, dy) nudges, only where the dot reads as misplaced.
SC_DOT_OVERRIDES = {
    "mun": (-30, -30),  # jDip parks Munich's dot on the Tyrolia border, far bottom-right
}


def loc_id(raw):
    """'stp-nc' -> 'stp/nc'; '_par' -> 'par'; 'gol' -> 'lyo'."""
    raw = raw.lstrip("_").replace("-", "/")
    head, _, tail = raw.partition("/")
    head = CANON.get(head, head)
    return f"{head}/{tail}" if tail else head


def section(text, start_marker, end_marker):
    a = text.index(start_marker)
    b = text.index(end_marker, a)
    return text[a:b]


def parse_provinces(svg):
    """(provinces, water_insets): provinces is id -> {d, kind} from MapLayer."""
    layer = section(svg, 'id="MapLayer"', 'id="SupplyCenterLayer"')
    out = {}
    insets = {}
    for cls, d, pid in re.findall(
        r'<path class="([^"]*)" d="([^"]*)"\s+id="([^"]*)"\s*/>', layer
    ):
        if pid in NON_PROVINCE:
            continue
        if pid in WATER_INSET_OF:
            insets.setdefault(WATER_INSET_OF[pid], []).append(d)
            continue
        kind = {"water": "sea", "impassable": "impassable"}.get(cls, "land")
        out[loc_id(pid)] = {"d": d, "kind": kind}
    for pid in insets:
        if pid not in out:
            raise SystemExit(f"water inset target {pid} missing")
    return out, {p: " ".join(v) for p, v in insets.items()}


def parse_coasts(svg):
    """Split-coast outlines (spa/nc, bul-ec, ...) come only from MouseLayer."""
    layer = svg[svg.index('id="MouseLayer"'):]
    out = {}
    for pid, d in re.findall(r'<path id="([a-z]{3}-[a-z]{2})" d="([^"]*)"', layer):
        out[loc_id(pid)] = d
    return out


def parse_background(svg):
    layer = section(svg, 'id="MapLayer"', 'id="SupplyCenterLayer"')
    out = {}
    for cls, d, pid in re.findall(
        r'<path class="([^"]*)" d="([^"]*)"\s+id="([^"]*)"\s*/>', layer
    ):
        if pid in NON_PROVINCE:
            out[pid] = d
    return out


def parse_symbol_size(svg, name):
    m = re.search(
        r'<jdipNS:SYMBOLSIZE name="%s" width="([\d.]+)" height="([\d.]+)"' % name, svg
    )
    if not m:
        raise SystemExit(f"SYMBOLSIZE {name} missing")
    return float(m.group(1)), float(m.group(2))


def parse_anchors(svg):
    """UNIT / DISLODGED_UNIT anchors, per province and per coast, as *centres*.

    jDip's x/y is the top-left of the symbol's box, not its middle: its own renderer
    computes the centre as `x + width/2, y + height/2` (see `_get_unit_center` in the
    `diplomacy` package) and both unit symbols declare `SYMBOLSIZE 40x40`. We were using
    the raw x/y, so every unit, arrow endpoint and Life mark sat 20 units up and to the
    left of where jDip draws it -- far enough to push London's fleet, Clyde's and
    Albania's out of their own provinces. Verified against jDip's own PNG render.
    """
    w, h = parse_symbol_size(svg, "Army")
    block = section(svg, "<jdipNS:PROVINCE_DATA>", "</jdipNS:PROVINCE_DATA>")
    unit, dislodged = {}, {}
    for name, body in re.findall(
        r'<jdipNS:PROVINCE name="([^"]+)">(.*?)</jdipNS:PROVINCE>', block, re.S
    ):
        loc = loc_id(name)
        u = re.search(r'<jdipNS:UNIT x="([-\d.]+)" y="([-\d.]+)"', body)
        dd = re.search(r'<jdipNS:DISLODGED_UNIT x="([-\d.]+)" y="([-\d.]+)"', body)
        dx, dy = UNIT_ANCHOR_OVERRIDES.get(loc, (0, 0))
        if u:
            unit[loc] = [float(u.group(1)) + w / 2 + dx, float(u.group(2)) + h / 2 + dy]
        if dd:
            dislodged[loc] = [
                float(dd.group(1)) + w / 2 + dx,
                float(dd.group(2)) + h / 2 + dy,
            ]
    return unit, dislodged


def parse_labels(svg):
    """Brief province labels.

    Three labels (POR, ROM, SKA) are placed with `transform="translate(x y) rotate(a)"`
    and x="0" y="0" so they can sit at an angle. Reading only the x/y attributes drops
    them at the SVG origin, which is why Portugal had no visible label; the translate is
    the real anchor. We ignore the rotation -- our labels are always horizontal.
    """
    layer = section(svg, 'id="BriefLabelLayer"', "</g>")
    out = {}
    for tag, text in re.findall(r'(<text[^>]*>)([A-Za-z]+)</text>', layer):
        xm = re.search(r'\sx="([-\d.]+)"', tag)
        ym = re.search(r'\sy="([-\d.]+)"', tag)
        x = float(xm.group(1)) if xm else 0.0
        y = float(ym.group(1)) if ym else 0.0
        tm = re.search(r'transform="[^"]*translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)', tag)
        if tm:
            x += float(tm.group(1))
            y += float(tm.group(2))
        pid = loc_id(text.lower())
        out[pid] = {"x": x, "y": y, "text": text}
    return out


def place_labels(labels, tiles, unit, sc, offset):
    """Anchor every label at its tile's pole of inaccessibility, then apply the overrides.

    jDip's own label anchors read as mispositioned here: they were placed beside jDip's
    supply-centre symbol at jDip's smaller type size, so they sit off-centre and hard
    against a border once the names are set at this size. The pole
    of inaccessibility is the centre of the largest circle that fits in the province, which
    is exactly 'the obviously right spot' for a name that has to clear the edges.

    The unit glyph and the supply-centre disc want the middle of the province too, and
    those stay where jDip put them, so the pole is taken of the province *minus* the room
    they occupy: the largest circle that fits in what is actually left for a name. Without
    that every one of the 55 labels landed under its own unit and had to be shoved out by
    the relaxation below, which picks the nearest legal spot rather than the best one.
    """
    ox, oy = offset
    out = {}
    for pid, lab in labels.items():
        anchor = (lab["x"], lab["y"])
        tile = tiles.get(pid)
        if tile is not None and not tile.is_empty:
            free = tile
            blockers = []
            u = unit.get(pid)
            if u:
                blockers.append(Point(u[0] - ox, u[1] - oy).buffer(UNIT_CLEAR + 2))
            d = sc.get(pid)
            if d:
                blockers.append(Point(d[0] - ox, d[1] - oy).buffer(SC_CLEAR + 2))
            if blockers:
                cut = polygonal(tile.difference(unary_union(blockers)))
                # A province small enough that the furniture is most of it (Denmark's
                # islands) is better served by its own centre than by whatever crescent
                # is left over.
                if not cut.is_empty and biggest(cut).area > 0.2 * tile.area:
                    free = cut
            px, py = pole_of_inaccessibility(free)
            # The pole is where the *middle* of the type should sit; SVG hangs text from
            # its baseline, so drop by half the difference between ascent and descent.
            anchor = (px + ox, py + oy + (LABEL_ASCENT - LABEL_DESCENT) / 2)
        dx, dy = LABEL_OVERRIDES.get(pid, (0, 0))
        out[pid] = {"x": anchor[0] + dx, "y": anchor[1] + dy, "text": lab["text"]}
    return out


def parse_sc_dots(svg):
    layer = section(svg, 'id="SupplyCenterLayer"', "</g>")
    out = {}
    for m in re.finditer(
        r'<use height="([\d.]+)" id="sc_([A-Za-z]+)" width="([\d.]+)"'
        r' x="([-\d.]+)" xlink:href="#SupplyCenter" y="([-\d.]+)"/>',
        layer,
    ):
        h, pid, w, x, y = m.groups()
        pid = loc_id(pid.lower())
        dx, dy = SC_DOT_OVERRIDES.get(pid, (0, 0))
        # x/y are the top-left of the symbol box; we want its centre.
        out[pid] = [float(x) + float(w) / 2 + dx, float(y) + float(h) / 2 + dy]
    return out


def parse_viewbox(svg):
    m = re.search(r'<svg[^>]*viewBox="([^"]+)"', svg)
    return m.group(1)


# --------------------------------------------------------------------------------------
# Geometry: enough of an SVG path reader to hand jDip's outlines to shapely.
# jDip's whole file uses only absolute M / L / C / z, checked at build time (see _TOKENS
# and flatten), so this is a complete reader for *this* input rather than a general one.
# --------------------------------------------------------------------------------------

_TOKENS = re.compile(r"([A-Za-z])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)")
_BEZIER_STEPS = 12
# Label metrics for the overlap check, matched to board.ts: font-size 20, semibold, so a
# glyph is ~11 units wide; `text-anchor: middle` centres the box on x and the baseline
# sits at y, with the cap height above it.
LABEL_CHAR_W = 11.0
LABEL_ASCENT = 15.0
LABEL_DESCENT = 5.0
# Radii we refuse to let a label box touch: the unit glyph (UNIT_R = 15) and the SC disc.
UNIT_CLEAR = 17.0
SC_CLEAR = 11.0


def flatten(d):
    """Path data -> list of closed point rings, beziers sampled to polylines."""
    items = []
    for cmd, num in _TOKENS.findall(d):
        items.append(("c", cmd) if cmd else ("n", float(num)))
    rings, cur, pt, start = [], [], (0.0, 0.0), (0.0, 0.0)
    i = 0
    while i < len(items):
        kind, val = items[i]
        i += 1
        if kind != "c":
            raise SystemExit(f"stray number in path data near index {i}")
        if val == "M":
            if cur:
                rings.append(cur)
            pt = (items[i][1], items[i + 1][1])
            i += 2
            start, cur = pt, [pt]
        elif val == "L":
            while i < len(items) and items[i][0] == "n":
                pt = (items[i][1], items[i + 1][1])
                i += 2
                cur.append(pt)
        elif val == "C":
            while i < len(items) and items[i][0] == "n":
                x1, y1, x2, y2, x, y = (items[i + j][1] for j in range(6))
                i += 6
                px, py = pt
                for s in range(1, _BEZIER_STEPS + 1):
                    t = s / _BEZIER_STEPS
                    u = 1 - t
                    cur.append(
                        (
                            u**3 * px + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x,
                            u**3 * py + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y,
                        )
                    )
                pt = (x, y)
        elif val in "zZ":
            if cur:
                cur.append(start)
                rings.append(cur)
                cur = []
            pt = start
        else:
            raise SystemExit(f"unsupported path command {val!r} -- extend flatten()")
    if cur:
        rings.append(cur)
    return rings


def path_geom(d, offset=(0.0, 0.0)):
    """Path data -> shapely geometry, jDip's even-odd fill rule applied to the rings."""
    ox, oy = offset
    parts = []
    for ring in flatten(d):
        if len(ring) < 4:
            continue
        p = Polygon([(x + ox, y + oy) for x, y in ring])
        if not p.is_valid:
            p = p.buffer(0)
        if not p.is_empty:
            parts.append(p)
    if not parts:
        return Polygon()
    g = parts[0]
    for p in parts[1:]:
        g = g.symmetric_difference(p)
    return polygonal(g)


def polygonal(g):
    """Drop the point/line debris a difference can leave, and any zero-area sliver."""
    if g.is_empty:
        return Polygon()
    bits = list(g.geoms) if hasattr(g, "geoms") else [g]
    keep = [b for b in bits if b.geom_type == "Polygon" and b.area > 1e-6]
    if not keep:
        return Polygon()
    return keep[0] if len(keep) == 1 else MultiPolygon(keep)


def biggest(g):
    return max(g.geoms, key=lambda p: p.area) if g.geom_type == "MultiPolygon" else g


# --------------------------------------------------------------------------------------
# Tiling. jDip's province outlines don't touch: every one of the 76 is its own island in
# the union, separated by 0-7 units of nothing (up to ~25 between the open-ocean seas,
# which nobody drew carefully). Hiding that under a 6-unit border stroke reads as heavy and
# eats provinces the size of Denmark's islands. Instead we make the outlines
# into an actual partition and ship *that* as the province geometry.
#
#   domain  = morphological closing of the union: buffer(+g) then buffer(-g). The +g fills
#             any gap narrower than 2g; the -g puts the *outer* coastline back where jDip
#             drew it, so growing the provinces never encroaches on the out-of-play
#             backdrop. Interior holes smaller than HOLE_KEEP_AREA (the wide ocean gaps)
#             are filled too; the two real ones -- Iceland and Ireland, out-of-play land
#             sitting in a ring of sea provinces -- are above it and stay holes.
#   tiles   = each province grown outward one GROW_STEP at a time, clipped to `domain` and
#             to whatever the other tiles already claim. Because every province is grown
#             from its *original* outline by the same radius each round, the boundary
#             between two neighbours lands on the set of points equidistant from both --
#             a Voronoi split of the gap, up to the GROW_STEP tie-break given to whichever
#             province sorts first.
# --------------------------------------------------------------------------------------

CLOSE_GAP = 5.0
HOLE_KEEP_AREA = 6000.0
# jDip's outermost provinces stop 4-8 units short of the page edge, so the backdrop rect
# showed as a pale ring of out-of-play sea all the way round the board -- the map read as
# floating in a margin rather than as a framed sheet. The domain is therefore extended into
# a band this wide around the viewBox, minus the decorative out-of-play paths (North Africa
# and Asia reach the bottom and right edges, and must not be paved over with sea tiles).
# The band only has to be wider than the largest margin; the tiles grow into whatever of it
# is adjacent to them and `reclaim` mops up the rest.
EDGE_BAND = 16.0
GROW_STEP = 1.0
MAX_GROW = 30.0
# Douglas-Peucker tolerance for the emitted path data: the exact partition is ~52k
# vertices (~600 KB of `d`), which is not worth shipping. Simplifying each tile
# independently can move a shared edge by up to this much in either direction, so the
# residual gap/overlap is reported below and has to stay far under the border width.
SIMPLIFY_TOL = 0.25


def edge_extension(viewbox, background, offset):
    """The strip of page edge the provinces don't reach, minus the decorative landmasses.

    Returned in *path* coordinates (the frame the province geometry lives in), ready to be
    unioned into the domain so the tiles run out to the viewBox rectangle.
    """
    x, y, w, h = (float(v) for v in viewbox.split())
    ox, oy = offset
    page = make_box(x - ox, y - oy, x + w - ox, y + h - oy)
    band = page.difference(page.buffer(-EDGE_BAND))
    decor = unary_union([path_geom(d) for d in background.values()])
    return polygonal(band.difference(decor))


def build_tiles(provinces, edge=None):
    """id -> shapely tile. Returns (tiles, domain, originals, log lines)."""
    orig = {pid: path_geom(v["d"]) for pid, v in provinces.items()}
    ids = sorted(orig)
    log = []

    union = unary_union(list(orig.values()))
    closed = union.buffer(CLOSE_GAP, quad_segs=4).buffer(-CLOSE_GAP, quad_segs=4)
    parts = list(closed.geoms) if closed.geom_type == "MultiPolygon" else [closed]
    filled, dropped = [], 0
    for p in parts:
        holes = []
        for ring in p.interiors:
            if Polygon(ring).area >= HOLE_KEEP_AREA:
                holes.append(ring)
            else:
                dropped += 1
        filled.append(Polygon(p.exterior, holes))
    domain = unary_union(filled)
    # The kept holes -- Iceland and Ireland -- taken *before* the page-edge extension, which
    # closes the out-of-play landmasses into holes of their own. These two are shipped as
    # geometry: jDip's decorative outline of each island is a few units inside the hole the
    # closing left, and that difference showed as a ring of sea between the island and its
    # own coastline. Grown by half a unit so the land always runs under the border stroke
    # that the surrounding sea tiles draw around the hole.
    islands = [
        Polygon(r).buffer(0.5, quad_segs=4)
        for p in (domain.geoms if domain.geom_type == "MultiPolygon" else [domain])
        for r in p.interiors
    ]
    if edge is not None and not edge.is_empty:
        before = domain.area
        domain = polygonal(unary_union([domain, edge]))
        log.append(f"domain: extended {domain.area - before:.0f} area units out to the page edge")
    kept_holes = [round(Polygon(r).area) for r in biggest(domain).interiors]
    log.append(
        f"domain: {len(parts)} part(s), {dropped} gap-pocket(s) filled, "
        f"{len(kept_holes)} hole(s) kept (areas {kept_holes})"
    )

    tiles = dict(orig)
    radius = 0.0
    while radius < MAX_GROW:
        radius += GROW_STEP
        tree = STRtree([tiles[i] for i in ids])
        for pid in ids:
            grown = orig[pid].buffer(radius, quad_segs=2).intersection(domain)
            if grown.is_empty:
                continue
            cand = unary_union([tiles[pid], grown])
            others = [tiles[ids[j]] for j in tree.query(cand) if ids[j] != pid]
            if others:
                cand = cand.difference(unary_union(others))
            tiles[pid] = polygonal(cand)
            tree = STRtree([tiles[i] for i in ids])
        left = domain.area - sum(t.area for t in tiles.values())
        if left < 1.0:
            break
    log.append(
        f"growth: converged at radius {radius:g} "
        f"({domain.area - sum(t.area for t in tiles.values()):+.2f} area units unclaimed)"
    )
    return tiles, domain, orig, islands, log


def reclaim(tiles, domain):
    """Give every scrap of the domain back to a tile.

    Simplifying each tile on its own moves a shared edge by up to the tolerance in either
    direction, which leaves ~1000 hairline holes between neighbours. They are a fraction of
    a unit wide, so the border stroke covers them -- but only where a border is drawn, and
    the failure mode when one isn't covered is a line of backdrop sea showing through the
    middle of a province, which is not a subtle bug. Cheaper to have no unclaimed area at
    all: each leftover scrap goes to whichever tile it shares the most boundary with.
    """
    ids = sorted(tiles)
    left = polygonal(domain.difference(unary_union(list(tiles.values()))))
    scraps = list(left.geoms) if left.geom_type == "MultiPolygon" else ([left] if not left.is_empty else [])
    if not scraps:
        return tiles
    tree = STRtree([tiles[i] for i in ids])
    claimed = {}
    for s in scraps:
        near = [ids[j] for j in tree.query(s.buffer(0.5))]
        if not near:
            continue
        best = max(near, key=lambda p: tiles[p].intersection(s.buffer(0.05)).area)
        claimed.setdefault(best, []).append(s)
    out = dict(tiles)
    for pid, bits in claimed.items():
        out[pid] = polygonal(unary_union([out[pid], *bits]))
    print(
        f"reclaim: {len(scraps)} unclaimed scrap(s) totalling {left.area:.3g} area units "
        f"folded into {len(claimed)} tile(s)"
    )
    return out


def sliver_depth(g):
    """Half-width of the fattest part of `g`: how far a bite reaches in, not how long it
    is. A Douglas-Peucker sliver is long and 'large' by area but only a fraction of a unit
    deep, which is the number that decides whether anyone can see it."""
    if g.is_empty:
        return 0.0
    lo, hi = 0.0, 4.0
    for _ in range(14):
        mid = (lo + hi) / 2
        if g.buffer(-mid).is_empty:
            hi = mid
        else:
            lo = mid
    return hi * 2


def check_tiling(tiles, domain, orig, water_insets, label=""):
    """The three properties that make the tiles usable: pairwise disjoint, covering the
    domain with no holes but the real ones, and each containing its own jDip outline."""
    ids = sorted(tiles)
    out = []
    tree = STRtree([tiles[i] for i in ids])
    worst_overlap, worst_pair = 0.0, None
    for i, pid in enumerate(ids):
        for j in tree.query(tiles[pid]):
            if j <= i:
                continue
            a = tiles[pid].intersection(tiles[ids[j]]).area
            if a > worst_overlap:
                worst_overlap, worst_pair = a, (pid, ids[j])
    out.append(
        f"{label}disjoint: worst pairwise overlap {worst_overlap:.3g} area units"
        + (f" ({worst_pair[0]}/{worst_pair[1]})" if worst_pair else "")
    )

    covered = unary_union(list(tiles.values()))
    holes = sorted(
        (round(Polygon(r).area, 2) for p in (covered.geoms if covered.geom_type == "MultiPolygon" else [covered]) for r in p.interiors),
        reverse=True,
    )
    real = [h for h in holes if h >= HOLE_KEEP_AREA]
    slivers = [h for h in holes if h < HOLE_KEEP_AREA]
    out.append(
        f"{label}coverage: {domain.area - covered.area:+.3g} area units of the domain "
        f"unclaimed; {len(real)} real hole(s) {real} (Iceland, Ireland and the "
        f"out-of-play landmasses the page-edge extension closes off), "
        f"{len(slivers)} sliver hole(s) totalling {sum(slivers):.3g}"
    )

    # A tile has to contain the outline it came from. The simplified pass is allowed to
    # shave a Douglas-Peucker sliver off it -- SIMPLIFY_TOL wide and at most as long as the
    # outline -- so it is judged by the deepest bite taken, not by the area of the sliver.
    lost = sorted(
        ((orig[p].difference(tiles[p]), p) for p in ids),
        key=lambda t: -t[0].area,
    )
    bite = max((0.0, *(sliver_depth(g) for g, _ in lost[:8])))
    # Douglas-Peucker moves a vertex by at most the tolerance, but `sliver_depth` measures
    # an inscribed diameter, which reads high at a corner where two shaved edges meet --
    # hence 3x rather than 2x.
    limit = max(0.5, SIMPLIFY_TOL * 3)
    out.append(
        f"{label}containment: worst bite out of a jDip outline is {bite:.3g} units deep "
        f"(largest is {lost[0][0].area:.3g} area units, {lost[0][1]})"
        + ("" if bite <= limit else f"  -- TOO DEEP, limit {limit}")
    )
    if water_insets:
        out.append(
            f"{label}water insets cut back out of {sorted(water_insets)} "
            "(their holes are drawn as sea, above the border pass)"
        )
    return out


def geom_to_path(g):
    """Shapely polygon(s) -> SVG `d`, exteriors CCW and holes CW so the nonzero and
    even-odd fill rules agree on which parts are holes."""
    parts = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    out = []
    for p in parts:
        if p.is_empty:
            continue
        p = orient(p, sign=1.0)
        for ring in [p.exterior, *p.interiors]:
            pts = list(ring.coords)
            if len(pts) < 4:
                continue
            rounded = [(round(x, 1), round(y, 1)) for x, y in pts[:-1]]
            deduped = [rounded[0]]
            for pt in rounded[1:]:
                if pt != deduped[-1]:
                    deduped.append(pt)
            if len(deduped) < 3:
                continue
            head = f"M {deduped[0][0]:g} {deduped[0][1]:g}"
            body = " ".join(f"{x:g} {y:g}" for x, y in deduped[1:])
            out.append(f"{head} L {body} Z")
    return " ".join(out)


def label_box(anchor, text):
    half = len(text) * LABEL_CHAR_W / 2
    return (
        anchor[0] - half,
        anchor[1] - LABEL_ASCENT,
        anchor[0] + half,
        anchor[1] + LABEL_DESCENT,
    )


def boxes_overlap(a, b, pad=0.0):
    return (
        a[0] - pad < b[2] and b[0] - pad < a[2] and a[1] - pad < b[3] and b[1] - pad < a[3]
    )


def box_hits_disc(box, c, r):
    nx = min(max(c[0], box[0]), box[2])
    ny = min(max(c[1], box[1]), box[3])
    return math.hypot(nx - c[0], ny - c[1]) < r


def pole_of_inaccessibility(tile):
    """Centre of the largest circle that fits inside the tile: where a name obviously
    belongs, as against jDip's anchor (which was placed beside *its* supply-centre symbol
    at *its* type size, and left a good half of the labels visibly off-centre)."""
    p = biggest(tile)
    try:
        pt = polylabel(p, tolerance=1.0)
    except Exception:
        pt = p.representative_point()
    return (pt.x, pt.y)


def check_furniture(tiles, kinds, coasts, labels, unit, sc, offset):
    """Every label/unit anchor inside its own province; no label box touching another
    label, a unit glyph or an SC disc. Returns (violations, suggestions)."""
    ox, oy = offset
    polys, prepped, centroids = {}, {}, {}
    for pid, tile in tiles.items():
        g = translate(tile, ox, oy)
        polys[pid] = g
        prepped[pid] = prep(g)
        c = biggest(g).centroid
        centroids[pid] = (c.x, c.y)

    named = {
        pid: labels[pid]
        for pid in labels
        if pid in tiles and kinds.get(pid) != "impassable"
    }

    # Working positions, relaxed below; `at[pid]` starts wherever the overrides put it.
    at = {pid: (lab["x"], lab["y"]) for pid, lab in named.items()}
    discs = [(f"unit {loc}", tuple(pt), UNIT_CLEAR) for loc, pt in unit.items() if "/" not in loc]
    discs += [(f"sc {pid}", tuple(pt), SC_CLEAR) for pid, pt in sc.items()]

    # Which provinces can hold a whole label box *anywhere*, ignoring other furniture.
    # This is a property of the outline alone, so the strict/loose split below is decided
    # by the input rather than by where the relaxation happens to be standing -- without
    # that, `loose` depended on the current positions and the relaxation limit-cycled
    # between two states instead of settling.
    roomy = set()
    for pid, lab in named.items():
        minx, miny, maxx, maxy = polys[pid].bounds
        found = False
        y = miny + 2
        while y < maxy and not found:
            x = minx + 2
            while x < maxx:
                b = label_box((x, y), lab["text"])
                if prepped[pid].contains(make_box(*b)):
                    found = True
                    break
                x += 4
            y += 4
        if found:
            roomy.add(pid)

    def clashes(pid, anchor, strict=True):
        """`strict` also demands the label's whole box sit inside the province, not just
        its anchor -- otherwise 'Lon' reads as floating in the North Sea even though the
        point it hangs from is in London. Provinces too small or too ragged to hold the
        box (`roomy` decides) are only held to anchor containment."""
        text = named[pid]["text"]
        b = label_box(anchor, text)
        bad = []
        if not prepped[pid].contains(Point(anchor)):
            bad.append(f"outside {pid}")
        elif strict and not prepped[pid].contains(make_box(*b)):
            bad.append(f"straddles the edge of {pid}")
        for other in named:
            if other != pid and boxes_overlap(b, label_box(at[other], named[other]["text"])):
                bad.append(f"overlaps label {other}")
        for who, c, r in discs:
            if box_hits_disc(b, c, r):
                bad.append(f"overlaps {who}")
        return bad

    def relocate(pid, strict):
        """Nearest anchor with no clashes, preferring the centroid direction. Radius 0 is
        in the list so that relaxing a province's rule can resolve it by leaving the label
        where it already is -- without that the search always moved it, and the loose/strict
        reclassification between builds made the whole pass oscillate instead of settling."""
        here = at[pid]
        c = centroids[pid] or here
        toward = math.atan2(c[1] - here[1], c[0] - here[0])
        if not clashes(pid, here, strict):
            return here
        for radius in range(4, 110, 2):
            best = None
            for step in range(24):
                ang = toward + (step // 2 + 1) * (math.pi / 12) * (1 if step % 2 else -1)
                cand = (here[0] + radius * math.cos(ang), here[1] + radius * math.sin(ang))
                if not clashes(pid, cand, strict):
                    off_axis = abs(((ang - toward + math.pi) % (2 * math.pi)) - math.pi)
                    if best is None or off_axis < best[0]:
                        best = (off_axis, cand)
            if best:
                return best[1]
        return None

    # Moving one label can push it onto another, so relax until it settles. Provinces with
    # no room for a fully-contained box (Lon, Yor) get a second pass at anchor containment
    # only, rather than being left stacked on a neighbour.
    suggestions = {}
    # Provinces whose outline cannot hold a whole label box are loose from the start; a
    # roomy one joins them only if no clean strictly-contained anchor is actually free.
    loose = set(named) - roomy
    original = dict(at)
    for _ in range(24):
        stuck = [pid for pid in sorted(named) if clashes(pid, at[pid], pid not in loose)]
        if not stuck:
            break
        for pid in stuck:
            spot = relocate(pid, pid not in loose)
            if spot is None and pid not in loose:
                loose.add(pid)
                spot = relocate(pid, False)
            if spot:
                at[pid] = spot
    for pid, lab in named.items():
        dx, dy = at[pid][0] - lab["x"], at[pid][1] - lab["y"]
        if abs(dx) > 0.05 or abs(dy) > 0.05:
            suggestions[pid] = (round(dx, 1), round(dy, 1))
    # What was wrong with the *input*, judged with the strictness the relaxation settled
    # on -- so a build whose overrides are already baked in reports clean rather than
    # re-flagging the labels it just placed.
    settled = at
    at = original
    violations = [
        (pid, bad)
        for pid in sorted(named)
        if (bad := clashes(pid, at[pid], pid not in loose))
    ]
    at = settled

    # Unit anchors must sit inside their own outline too -- a unit drawn in the neighbour's
    # territory is the same bug as a label there. A split coast is checked against its own
    # MouseLayer outline, which deliberately reaches into the sea.
    coast_polys = {loc: path_geom(d, offset) for loc, d in coasts.items()}
    stray_units = {}
    for loc, pt in sorted(unit.items()):
        pid = loc.split("/")[0]
        if pid not in polys or kinds.get(pid) == "impassable":
            continue
        area = coast_polys.get(loc) or polys[pid]
        if area.contains(Point(pt)):
            continue
        # Nudge toward the province centroid until the anchor is inside with clearance.
        c = centroids[pid]
        fix = None
        if c:
            dx, dy = c[0] - pt[0], c[1] - pt[1]
            length = math.hypot(dx, dy) or 1
            for step in range(2, 60, 2):
                cand = (pt[0] + dx / length * step, pt[1] + dy / length * step)
                if area.contains(Point(cand)) and area.contains(
                    Point(cand[0] + dx / length * 6, cand[1] + dy / length * 6)
                ):
                    fix = (round(cand[0] - pt[0], 1), round(cand[1] - pt[1], 1))
                    break
        stray_units[loc] = fix
    return violations, suggestions, sorted(loose), stray_units


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SVG
    if src is None:
        raise SystemExit(
            "no svg given and the `diplomacy` package is not importable "
            "(pip install diplomacy, or pass path/to/standard.svg)"
        )
    if not os.path.exists(src):
        raise SystemExit(f"source svg not found: {src}")
    svg = open(src, encoding="utf-8").read()

    provinces, water_insets = parse_provinces(svg)
    coasts = parse_coasts(svg)
    unit, dislodged = parse_anchors(svg)
    sc = parse_sc_dots(svg)
    background = parse_background(svg)

    # The partition. `tiles` is exact; `simple` is what we ship, and the second check is
    # what the Douglas-Peucker pass cost us.
    viewbox = parse_viewbox(svg)
    tiles, domain, orig, islands, tiling_log = build_tiles(
        provinces, edge_extension(viewbox, background, PATH_OFFSET)
    )
    for line in tiling_log:
        print(line)
    for line in check_tiling(tiles, domain, orig, water_insets):
        print(line)
    simple = reclaim(
        {pid: polygonal(t.simplify(SIMPLIFY_TOL)) for pid, t in tiles.items()}, domain
    )
    for line in check_tiling(simple, domain, orig, {}, label=f"simplified({SIMPLIFY_TOL}) "):
        print(line)
    # The Danish belts and the Bosporus are water inside a land province: cut them out of
    # the tile so the fill stops at the shore and the border pass traces the strait, and
    # let the water-inset layer paint them back in sea colour.
    #
    # Clipped to the tile first, and that is not cosmetic. jDip draws these as free-floating
    # water shapes that run well past the province they belong to -- `denmark_water` spills
    # 263 area units into BAL, 51 into SKA and 64 into *Sweden*. Painted unclipped, the
    # Swedish 64 was a thin blue sliver of sea inside southern Sweden, hard against its
    # south coast, with Sweden's own outline drawn on top of it. Clipped, the inset is
    # exactly the hole it was cut from and cannot paint outside its province.
    inset_geom = {}
    for pid, d in water_insets.items():
        g = polygonal(path_geom(d).intersection(simple[pid]))
        spill = path_geom(d).area - g.area
        print(f"water inset {pid}: clipped to its tile, {spill:.1f} area units of spill dropped")
        inset_geom[pid] = g
        water_insets[pid] = geom_to_path(g)
    final = {
        pid: (polygonal(g.difference(inset_geom[pid])) if pid in inset_geom else g)
        for pid, g in simple.items()
    }
    # What a click on the province should cover: the tile with its strait filled back in.
    # Concatenating the two paths and hoping the fill rule sorts it out does not work --
    # jDip's inset ring winds whichever way it wants, so under `nonzero` it as often
    # cancels the tile's hole as fills it. Union them here, where the winding is ours.
    hit_areas = {
        pid: geom_to_path(unary_union([final[pid], g])) for pid, g in inset_geom.items()
    }
    labels = place_labels(parse_labels(svg), final, unit, sc, PATH_OFFSET)
    for pid, v in provinces.items():
        v["raw"] = v["d"]
        v["d"] = geom_to_path(final[pid])

    # sanity
    missing_anchor = sorted(
        p for p, v in provinces.items() if v["kind"] != "impassable" and p not in unit
    )
    if missing_anchor:
        print("WARN: provinces without a unit anchor:", missing_anchor, file=sys.stderr)
    missing_label = sorted(p for p in provinces if p not in labels)
    if missing_label:
        print("WARN: provinces without a label:", missing_label, file=sys.stderr)
    # A label left at the SVG origin is the "Portugal has no label" failure: it is not
    # missing, it is drawn off the played area. Catch it here rather than by eye.
    stray = sorted(p for p, v in labels.items() if v["x"] == 0 and v["y"] == 0)
    if stray:
        print("WARN: labels anchored at the origin:", stray, file=sys.stderr)
    # The real furniture check: every label anchor inside its own province, clear of every
    # other label box, every unit glyph and every SC disc. Eyeballing this is what put
    # "Lon" over the English Channel and stacked "Vie" on "Tri".
    violations, suggestions, loose, stray_units = check_furniture(
        final,
        {p: v["kind"] for p, v in provinces.items()},
        coasts,
        labels,
        unit,
        sc,
        PATH_OFFSET,
    )
    print(f"label check: {len(labels)} labels, {len(violations)} violation(s)")
    for pid, bad in violations:
        print(f"  {pid}: {', '.join(bad)}")
    if suggestions:
        print("  -> paste into LABEL_OVERRIDES and re-run:")
        for pid, (dx, dy) in sorted(suggestions.items()):
            base = LABEL_OVERRIDES.get(pid, (0, 0))
            print(f'       "{pid}": ({base[0] + dx:g}, {base[1] + dy:g}),')
    if loose:
        print(
            f"  ({len(loose)} label(s) too big for their province -- anchor is inside and "
            f"clear of everything, box overhangs: {', '.join(loose)})"
        )
    if stray_units:
        print(f"unit-anchor check: {len(stray_units)} anchor(s) outside their outline:")
        for loc, fix in sorted(stray_units.items()):
            if "/" in loc:
                # jDip parks a named-coast fleet just offshore on purpose: that offset is
                # how you tell BUL/EC from BUL/SC at a glance. Reported, not corrected.
                print(f'  {loc}: offshore by design (coast marker), left alone')
            else:
                print(f'  {loc}: -> UNIT_ANCHOR_OVERRIDES["{loc}"] = {fix}')
    else:
        print(f"unit-anchor check: all {len(unit)} anchors inside their outline")

    art = {
        "source": "jDip standard.svg (SVG by Zach DelProposto), GPL",
        "viewBox": viewbox,
        "pathOffset": {"x": PATH_OFFSET[0], "y": PATH_OFFSET[1]},
        "provinces": dict(sorted(provinces.items())),
        "waterInsets": dict(sorted(water_insets.items())),
        "hitAreas": dict(sorted(hit_areas.items())),
        "canals": dict(sorted(CANALS.items())),
        "coasts": dict(sorted(coasts.items())),
        "background": dict(sorted(background.items())),
        "islands": [geom_to_path(g.simplify(0.2)) for g in islands],
        "unitAnchors": dict(sorted(unit.items())),
        "dislodgedAnchors": dict(sorted(dislodged.items())),
        "labels": dict(sorted(labels.items())),
        "scDots": dict(sorted(sc.items())),
        "aliases": {k: v for k, v in sorted(CANON.items())},
    }

    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(art, fh, separators=(",", ":"))
        fh.write("\n")

    with open(OUT_TS, "w", encoding="utf-8") as fh:
        fh.write("// GENERATED by src/data/build-standard-art.py -- do not edit.\n")
        fh.write("// Geometry derived from jDip standard.svg (GPL); see LICENSE-map.txt.\n")
        fh.write("import type { MapArtData } from '../ui/map-art.js';\n\n")
        fh.write("export const STANDARD_ART: MapArtData = ")
        json.dump(art, fh, separators=(",", ":"))
        fh.write(";\n")

    print(
        f"wrote {OUT_JSON} ({os.path.getsize(OUT_JSON)//1024} KB): "
        f"{len(provinces)} provinces, {len(coasts)} coast outlines, "
        f"{len(unit)} unit anchors, {len(labels)} labels, {len(sc)} sc dots, "
        f"{len(water_insets)} water insets, {len(CANALS)} canal(s)"
    )


if __name__ == "__main__":
    main()
