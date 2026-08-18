import type { Loc, MapData, Province, ProvinceId, Unit, UnitType } from './types.js';

/** Province part of a location id: 'spa/sc' -> 'spa'. */
export function provinceOf(loc: Loc): ProvinceId {
  const i = loc.indexOf('/');
  return i < 0 ? loc : loc.slice(0, i);
}

/** Coast part of a location id: 'spa/sc' -> 'sc', 'par' -> ''. */
export function coastOf(loc: Loc): string {
  const i = loc.indexOf('/');
  return i < 0 ? '' : loc.slice(i + 1);
}

export function provinceData(map: MapData, loc: Loc): Province | undefined {
  return map.provinces[provinceOf(loc)];
}

/** Locations a unit of `type` standing at `from` may move to directly. */
export function moveTargets(map: MapData, type: UnitType, from: Loc): Loc[] {
  const p = map.provinces[provinceOf(from)];
  if (!p) return [];
  if (type === 'A') return p.armyAdj;
  return p.fleetAdj[coastOf(from)] ?? [];
}

/** True if a unit of `type` at `from` may move directly to the exact location `to`. */
export function canMoveDirect(map: MapData, type: UnitType, from: Loc, to: Loc): boolean {
  return moveTargets(map, type, from).includes(to);
}

/**
 * True if a unit of `type` at `from` borders province `toProv` (ignoring which
 * coast of `toProv`). Used for supports, which are coast-insensitive on the
 * destination side but respect the supporting fleet's own coast.
 */
export function abutsProvince(map: MapData, type: UnitType, from: Loc, toProv: ProvinceId): boolean {
  return moveTargets(map, type, from).some((t) => provinceOf(t) === toProv);
}

/** Exact destination locations within `toProv` reachable by a unit of `type` at `from`. */
export function reachableLocsIn(map: MapData, type: UnitType, from: Loc, toProv: ProvinceId): Loc[] {
  return moveTargets(map, type, from).filter((t) => provinceOf(t) === toProv);
}

/** Provinces a fleet standing in sea province `sea` borders (coasts collapsed). */
export function seaNeighbours(map: MapData, sea: ProvinceId): ProvinceId[] {
  const p = map.provinces[sea];
  if (!p) return [];
  const out = new Set<ProvinceId>();
  for (const list of Object.values(p.fleetAdj)) for (const l of list) out.add(provinceOf(l));
  return [...out];
}

export function isSea(map: MapData, id: ProvinceId): boolean {
  return map.provinces[id]?.type === 'sea';
}

export function isCoastal(map: MapData, id: ProvinceId): boolean {
  return map.provinces[id]?.type === 'coastal';
}

/** Sea provinces holding a fleet — the set of squares a convoy chain can use. */
export function convoyerProvinces(map: MapData, units: readonly Unit[]): Set<ProvinceId> {
  const out = new Set<ProvinceId>();
  for (const u of units) {
    if (u.type !== 'F') continue;
    const id = provinceOf(u.loc);
    if (isSea(map, id)) out.add(id);
  }
  return out;
}

/**
 * All simple convoy chains from coastal province `from` to coastal province `to`
 * using only sea provinces in `fleets`. Returned as arrays of sea provinces.
 * `limit` caps the number of routes returned (routes are only ever a handful).
 */
export function convoyRoutes(
  map: MapData,
  fleets: ReadonlySet<ProvinceId>,
  from: ProvinceId,
  to: ProvinceId,
  limit = 200,
): ProvinceId[][] {
  if (from === to) return [];
  if (!isCoastal(map, from) || !isCoastal(map, to)) return [];
  const routes: ProvinceId[][] = [];
  const path: ProvinceId[] = [];
  const seen = new Set<ProvinceId>();

  const walk = (at: ProvinceId): void => {
    if (routes.length >= limit) return;
    for (const n of seaNeighbours(map, at)) {
      if (n === to && path.length > 0) {
        routes.push([...path]);
        if (routes.length >= limit) return;
      }
    }
    for (const n of seaNeighbours(map, at)) {
      if (!fleets.has(n) || seen.has(n)) continue;
      seen.add(n);
      path.push(n);
      walk(n);
      path.pop();
      seen.delete(n);
    }
  };
  walk(from);
  // Deduplicate (a route can be reached by several DFS orders only if graph has
  // parallel edges — it doesn't — but keep this cheap guard anyway).
  const keyed = new Map<string, ProvinceId[]>();
  for (const r of routes) keyed.set(r.join('>'), r);
  return [...keyed.values()];
}

/** Is there any convoy chain at all from `from` to `to` using `fleets`? */
export function hasConvoyRoute(
  map: MapData,
  fleets: ReadonlySet<ProvinceId>,
  from: ProvinceId,
  to: ProvinceId,
): boolean {
  if (from === to) return false;
  if (!isCoastal(map, from) || !isCoastal(map, to)) return false;
  const queue: ProvinceId[] = [];
  const seen = new Set<ProvinceId>();
  for (const n of seaNeighbours(map, from)) {
    if (fleets.has(n) && !seen.has(n)) {
      seen.add(n);
      queue.push(n);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const nbrs = seaNeighbours(map, cur);
    if (nbrs.includes(to)) return true;
    for (const n of nbrs) {
      if (fleets.has(n) && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return false;
}

/** Is there a convoy chain from `from` to `to` using `fleets` that passes through `via`? */
export function hasConvoyRouteThrough(
  map: MapData,
  fleets: ReadonlySet<ProvinceId>,
  from: ProvinceId,
  to: ProvinceId,
  via: ProvinceId,
): boolean {
  if (!fleets.has(via)) return false;
  return convoyRoutes(map, fleets, from, to).some((r) => r.includes(via));
}

/**
 * Shortest distance from a unit to any of `homes`, used by the civil-disorder
 * removal rule. Armies travel over any adjacency (land or sea, DATC 4.D.8
 * choice d); fleets only over fleet adjacency.
 */
export function distanceToHome(
  map: MapData,
  type: UnitType,
  start: Loc,
  homes: readonly ProvinceId[],
): number {
  if (homes.length === 0) return 99999;
  const homeSet = new Set(homes);
  if (homeSet.has(provinceOf(start))) return 0;
  let frontier: Loc[] = [start];
  const seen = new Set<Loc>([start]);
  for (let d = 1; d < 100; d++) {
    const next: Loc[] = [];
    for (const cur of frontier) {
      const nbrs =
        type === 'A' ? (map.lifeAdjacency[provinceOf(cur)] ?? []) : moveTargets(map, 'F', cur);
      for (const n of nbrs) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (homeSet.has(provinceOf(n))) return d;
        next.push(n);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return 99999;
}
