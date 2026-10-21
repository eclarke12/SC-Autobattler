import shipsJson from '../data/ships.json';
import type { ShipData } from './engine/types';

export const SHIPS = shipsJson as unknown as ShipData[];

export const shipByUuid = new Map(SHIPS.map((s) => [s.uuid, s]));

export const MANUFACTURERS = [...new Set(SHIPS.map((s) => s.manufacturer))].sort();
export const SIZES = ['snub', 'small', 'medium', 'large', 'capital', 'special', 'unknown'];
export const CAREERS = [...new Set(SHIPS.map((s) => s.career ?? 'Unclassified'))].sort();

export function shipTotalDps(s: ShipData): number {
  return s.weapons.reduce((t, w) => t + (w.type === 'fixed' ? w.dps : 0), 0);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
