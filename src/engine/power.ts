import { TURRET_POWER_PIPS } from './constants';
import type { ShipComponent, ShipConfig, ShipData } from './types';

/** Component power-allocation model (plan-power-components T19). Replaces the W5
 *  pip-scarcity heuristic: supply = `ship.powerSegments`; allocated = Σ component
 *  allocations + shield pips + scaled gun draw; net = supply − allocated.
 *  Overdraw is allowed in the model (net < 0) and gated at the UI Fight boundary.
 *  All ship fields tolerate absence (un-migrated ships.json degrades to 0 draws). */

export function fullDrawOf(c: ShipComponent): number {
  return c.power?.fullDraw ?? 0;
}

export function minOnlineOf(c: ShipComponent): number {
  return c.power?.minOnline ?? 0;
}

/** RULE-R (plan addendum 2026-10-23): the system-reserve budget covers ONLY system
 *  components. PowerPlant carries minOnline=fullDraw=its own generation (fleet Σ
 *  5662) — counting it as draw makes Σmin exceed generation on all 228 ships; it IS
 *  the generation source. Shield components are modeled by the shield slider
 *  (floor ship.shieldMin, cap ship.shieldPool); weapons-category components are
 *  covered by gunDrawFull (gunDraw + pdcCount × TURRET_POWER_PIPS) and are
 *  display-only in the UI. */
export const NON_SYSTEM_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  'PowerPlant', 'Shield', 'Turret', 'TurretBase', 'UtilityTurret',
  'WeaponGun', 'WeaponDefensive', 'MissileLauncher', 'BombLauncher',
]);

export function isSystemComponent(c: ShipComponent): boolean {
  return !NON_SYSTEM_COMPONENT_TYPES.has(c.type ?? '');
}

/** RULE-R display split (2026-10-23): the weapons pool = NON_SYSTEM minus `PowerPlant`
 *  (generation source) and `Shield` (shield slider) — exactly the types the UI lists
 *  under Guns. Shield components render read-only rows in the Shields section. */
export const WEAPONS_POOL_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  'Turret', 'TurretBase', 'UtilityTurret', 'WeaponGun', 'WeaponDefensive',
  'MissileLauncher', 'BombLauncher',
]);

/** The app simulates the SCF/NAV (non-quantum) power state, so QuantumDrive —
 *  including jump modules, which ship as type QuantumDrive — is unpowered by
 *  default (alloc 0, blocks show 0/max). */
export const DEFAULT_UNPOWERED_TYPES: ReadonlySet<string> = new Set(['QuantumDrive']);

export function isPoweredByDefault(c: ShipComponent): boolean {
  return isSystemComponent(c) && !DEFAULT_UNPOWERED_TYPES.has(c.type ?? '');
}

export function defaultAllocOf(c: ShipComponent): number {
  return isPoweredByDefault(c) ? minOnlineOf(c) : 0;
}

/** Σ SYSTEM component allocations, each clamped to [0, fullDraw]; non-system entries
 *  of a parallel allocs array are always treated as 0. A missing (non-array) allocs
 *  list means "every system at its default allocation" (minOnline, except the
 *  unpowered QuantumDrive/jump types at 0) — the default state. */
export function systemReserve(ship: ShipData, allocs: number[] | undefined): number {
  const components = ship.components ?? [];
  if (!Array.isArray(allocs)) return components.reduce((s, c) => s + defaultAllocOf(c), 0);
  return components.reduce((s, c, i) => s + (isSystemComponent(c) ? Math.min(Math.max(0, allocs[i] ?? 0), fullDrawOf(c)) : 0), 0);
}

/** Fixed guns + manned turrets + PDCs all ride in the weapons pool: aggregate fixed
 *  draw (`gunDraw`, API grouped WeaponGun) plus `pdcCount × TURRET_POWER_PIPS`
 *  while the PDC toggle is on. Manned-turret draw scales with the gun-pip fraction
 *  like everything else in the pool (plan: weapons-claim-first is about fitting the
 *  budget, not about turrets drawing at zero pips). */
export function gunDrawFull(ship: ShipData, pdcOn: boolean): number {
  return (ship.gunDraw ?? 0) + (pdcOn ? (ship.pdcCount ?? 0) * TURRET_POWER_PIPS : 0);
}

/** Total pips claimed by the allocation: systems reserve + shield pips +
 *  the gun pool's draw at the gun-pip fraction. */
export function allocatedPower(ship: ShipData, allocs: number[] | undefined, gunPips: number, shieldPips: number, pdcOn: boolean): number {
  const frac = ship.weaponPool > 0 ? Math.min(1, Math.max(0, gunPips / ship.weaponPool)) : 0;
  return systemReserve(ship, allocs) + shieldPips + gunDrawFull(ship, pdcOn) * frac;
}

export function netPower(ship: ShipData, cfg: ShipConfig): number {
  return ship.powerSegments - allocatedPower(ship, cfg.allocs ?? [], cfg.powerToWeapons, cfg.powerToShields, cfg.pdcOn ?? true);
}

export function isOverdrawn(ship: ShipData, cfg: ShipConfig): boolean {
  return netPower(ship, cfg) < 0;
}

export interface PowerAllocation {
  allocs: number[];
  gunPips: number;
  shieldPips: number;
  pdcOn: boolean;
}

/** Opening state (plan Decisions 2/3 + RULE-R + QDrive-unpowered 2026-10-23): every
 *  powered SYSTEM component at minOnline, QuantumDrive/jump at 0 (allocs array stays
 *  index-parallel to ship.components; non-system entries are 0),
 *  PDC on, guns full, shields max. On overdraw: guns → 0 (weapons-claim-first
 *  preserved); if still over, shields → shieldMin. Systems are NEVER forced below
 *  minOnline — the residual overdraw stays on the net (red) for the user to cut;
 *  the T20 Fight gate disables those matchups. */
export function defaultAllocation(ship: ShipData): PowerAllocation {
  const allocs = (ship.components ?? []).map(defaultAllocOf);
  const pdcOn = true;
  let gunPips = ship.weaponPool;
  let shieldPips = ship.shieldPool;
  if (ship.powerSegments - allocatedPower(ship, allocs, gunPips, shieldPips, pdcOn) < 0) gunPips = 0;
  if (ship.powerSegments - allocatedPower(ship, allocs, gunPips, shieldPips, pdcOn) < 0) shieldPips = ship.shieldMin ?? 0;
  return { allocs, gunPips, shieldPips, pdcOn };
}
