import type { Loc, Order, Power, Unit } from '../engine/types.js';
import { provinceOf } from '../engine/map-utils.js';

/** Render a location the way players write it: 'stp/nc' -> 'STP/NC'. */
export function locText(loc: Loc): string {
  const i = loc.indexOf('/');
  return i < 0 ? loc.toUpperCase() : `${loc.slice(0, i).toUpperCase()}/${loc.slice(i + 1).toUpperCase()}`;
}

export function unitText(u: Unit): string {
  return `${u.type} ${locText(u.loc)}`;
}

/** Canonical one-line rendering of an order, in the notation the parser accepts. */
export function formatOrder(o: Order): string {
  switch (o.kind) {
    case 'move':
      return `${unitText(o.unit)} - ${locText(o.to)}${o.viaConvoy ? ' via convoy' : ''}`;
    case 'hold':
      return `${unitText(o.unit)} H`;
    case 'support':
      return o.to === undefined
        ? `${unitText(o.unit)} S ${unitText(o.target)}`
        : `${unitText(o.unit)} S ${unitText(o.target)} - ${locText(o.to)}`;
    case 'convoy':
      return `${unitText(o.unit)} C ${unitText(o.target)} - ${locText(o.to)}`;
    case 'retreat':
      return `${unitText(o.unit)} R ${locText(o.to)}`;
    case 'disband':
      return `${unitText(o.unit)} D`;
    case 'build':
      return `Build ${unitText(o.unit)}`;
    case 'remove':
      return `Remove ${unitText(o.unit)}`;
    case 'waive':
      return 'Waive';
  }
}

/** The unit an order is issued to, or null (waives have no unit). */
export function orderUnit(o: Order): Unit | null {
  return 'unit' in o ? o.unit : null;
}

export function orderPower(o: Order): Power {
  return 'unit' in o ? o.unit.power : o.power;
}

/** Does this text line already give an order to a unit in `prov`? */
export function lineTargetsProvince(line: string, prov: string): boolean {
  const m = /^\s*(?:build\s+|remove\s+)?[AF]\s+([A-Za-z]{3})(?:[/-][A-Za-z]{2})?/i.exec(line);
  return !!m && m[1]!.toLowerCase() === provinceOf(prov).toLowerCase();
}

/**
 * Insert or replace the order for a unit inside a power's textarea contents.
 * Click-entry writes through this so the textarea stays the single source of truth.
 */
export function upsertOrderLine(text: string, order: Order): string {
  const unit = orderUnit(order);
  const line = formatOrder(order);
  if (!unit) return text.trimEnd() ? `${text.trimEnd()}\n${line}\n` : `${line}\n`;
  const prov = provinceOf(unit.loc);
  const lines = text.split('\n');
  const trailingBlank = lines.length > 0 && lines[lines.length - 1]!.trim() === '';
  let replaced = false;
  const out = lines.map((l) => {
    if (!replaced && lineTargetsProvince(l, prov)) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (!replaced) {
    if (trailingBlank) out.splice(out.length - 1, 0, line);
    else out.push(line);
  }
  return out.join('\n');
}

/** Split a pasted chat dump into per-power blocks using `France:` style headers. */
export function splitByPowerHeaders(text: string, powers: readonly Power[]): Map<Power, string> | null {
  const lines = text.split('\n');
  const blocks = new Map<Power, string[]>();
  let current: Power | null = null;
  let sawHeader = false;
  for (const line of lines) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    const named = m ? powers.find((p) => p.toLowerCase().startsWith(m[1]!.toLowerCase().slice(0, 3))) : undefined;
    if (m && named && m[1]!.length >= 3) {
      sawHeader = true;
      current = named;
      if (!blocks.has(current)) blocks.set(current, []);
      if (m[2]!.trim()) blocks.get(current)!.push(m[2]!);
      continue;
    }
    if (current) blocks.get(current)!.push(line);
  }
  if (!sawHeader) return null;
  const out = new Map<Power, string>();
  for (const [p, ls] of blocks) out.set(p, ls.join('\n').trim() + '\n');
  return out;
}
