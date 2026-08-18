import { describe, it, expect } from 'vitest';
import { STANDARD_MAP } from '../../src/data/standard-map.js';
import { provinceOf, coastOf } from '../../src/engine/map-utils.js';

const map = STANDARD_MAP;

describe('standard map data', () => {
  it('has 75 provinces and 34 supply centres', () => {
    expect(Object.keys(map.provinces)).toHaveLength(75);
    expect(Object.values(map.provinces).filter((p) => p.sc)).toHaveLength(34);
  });

  it('has 22 starting units and 22 home centres', () => {
    expect(map.startingUnits).toHaveLength(22);
    const homes = Object.values(map.startingCenters).flat();
    expect(homes).toHaveLength(22);
    expect(Object.values(map.provinces).filter((p) => p.home !== null)).toHaveLength(22);
  });

  it('names every province', () => {
    for (const p of Object.values(map.provinces)) {
      expect(p.name.length, p.id).toBeGreaterThan(2);
      expect(p.name).not.toBe(p.id.toUpperCase());
    }
    expect(map.provinces['stp']?.name).toBe('St Petersburg');
    expect(map.provinces['mao']?.name).toBe('Mid-Atlantic Ocean');
  });

  it('has a symmetric, self-edge-free life adjacency over all 75 provinces', () => {
    const life = map.lifeAdjacency;
    expect(Object.keys(life)).toHaveLength(75);
    for (const [id, ns] of Object.entries(life)) {
      expect(ns).not.toContain(id);
      expect(new Set(ns).size).toBe(ns.length);
      for (const n of ns) {
        expect(map.provinces[n], `${id} -> ${n}`).toBeDefined();
        expect(life[n], `${n} -> ${id}`).toContain(id);
      }
    }
  });

  it('collapses coasts in life adjacency', () => {
    // Spain touches both its coasts' seas plus its land neighbours.
    expect(map.lifeAdjacency['spa']).toEqual(['gas', 'lyo', 'mao', 'mar', 'por', 'wes']);
    expect(map.lifeAdjacency['spa']?.some((n) => n.includes('/'))).toBe(false);
  });

  it('keeps army adjacency coast-free and fleet adjacency coast-aware', () => {
    for (const p of Object.values(map.provinces)) {
      for (const a of p.armyAdj) expect(coastOf(a), `${p.id}`).toBe('');
      for (const [coast, list] of Object.entries(p.fleetAdj)) {
        if (p.coasts.length > 0) expect(p.coasts).toContain(coast);
        for (const l of list) {
          const dest = map.provinces[provinceOf(l)]!;
          if (dest.coasts.length > 0) expect(dest.coasts).toContain(coastOf(l));
        }
      }
    }
    expect(map.provinces['spa']?.fleetAdj['nc']).toEqual(['gas', 'mao', 'por']);
    expect(map.provinces['par']?.fleetAdj).toEqual({});
  });

  it('drops impassable Switzerland from every adjacency list', () => {
    for (const p of Object.values(map.provinces)) {
      expect(p.armyAdj).not.toContain('swi');
      for (const list of Object.values(p.fleetAdj)) expect(list).not.toContain('swi');
    }
  });

  it('places the 1901 units correctly', () => {
    const stp = map.startingUnits.find((u) => u.loc.startsWith('stp'));
    expect(stp).toEqual({ power: 'RUSSIA', type: 'F', loc: 'stp/sc' });
    expect(map.startingCenters['RUSSIA']).toEqual(['mos', 'sev', 'stp', 'war']);
  });
});
