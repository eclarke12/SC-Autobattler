import { TURRET_POWER_PIPS } from './constants';
import type { ShipComponent, ShipConfig, ShipData } from './types';

/** Component power-allocation model (plan-power-components T19). Replaces the W5
 *  pip-scarcity heuristic: supply = `ship.powerSegments`; allocated = Σ component
 *  allocations + shield pips + scaled gun draw; net = supply − allocated.
 *  Overdraw is allowed in the model (net < 0) and gated at the UI Fight boundary.
 *  All ship fields tolerate absence (un-migrated ships.json degrades to 0 draws).
 *  Pip costs are billed in WHOLE pips via `pipCost` (round-up rule, 2026-10-23). */

/** Round-up pip cost: in Star Citizen power is allocated in discrete whole segments
 *  while the API reports FRACTIONAL component usage — RSI Ship Owner's Guide
 *  "Components, Power, Signatures" (official Comm-Link 20263, retrieved via
 *  api.star-citizen.wiki): "Power is allocated in segments to components, which
 *  consume these universal units based on their demands" and "Some components have a
 *  minimum power consumption that displays as combined power segments" (e.g. the
 *  0.1-minOnline BEHR gatling occupies a whole segment). Data facts: minOnline/
 *  fullDraw 0.1/0.25/1.13/1.4/2.1/2.93/4.8 (WeaponGun classes), fractional
 *  `gunDraw` on 147/228 ships, supply `generation_segments` integer on all ships.
 *  So a 2.1-pip draw OCCUPIES 3 segments: cost = ceil(usage). Applied to every pip
 *  cost entering the budget (system allocations, gun draw at full power and at the
 *  pip fraction — declared heuristic for the grouped draw, per-gun data unavailable
 *  per T17, shield pips). Supply and every cost are integers, so net is always an
 *  integer. Raw usage stays the display spec (component rows). */
export function pipCost(n: number): number {
  return Math.ceil(n);
}

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

export function isShieldComponent(c: ShipComponent): boolean {
  return (c.type ?? '') === 'Shield';
}

/** `ship.shieldOns` normalized to a full `components[]`-parallel boolean list:
 *  entries index-parallel to Shield components default to `true` (missing knob =
 *  all shields on); non-Shield entries are always true (ignored). */
export function shieldOnsOf(ship: ShipData, shieldOns: boolean[] | undefined): boolean[] {
  return (ship.components ?? []).map((c, i) => !isShieldComponent(c) || (shieldOns?.[i] ?? true));
}

/** Shield slider floor: Σ pipCost(minOnline) over the ON Shield components. An OFF
 *  generator frees its minOnline (below minOnline it is offline per Comm-Link 20263
 *  — "requires a significant amount of power just to activate"), so a 2×4-pip ship
 *  with one generator off floors at 4, and with both off at 0 — running with zero
 *  shields is legal. */
export function shieldFloorOn(ship: ShipData, shieldOns: boolean[] | undefined): number {
  const on = shieldOnsOf(ship, shieldOns);
  return (ship.components ?? []).reduce((s, c, i) => s + (isShieldComponent(c) && on[i] ? pipCost(minOnlineOf(c)) : 0), 0);
}

/** Σ pipCost(fullDraw) over the ON Shield components — the sim's pool-strength basis
 *  and the all-ON slider cap (boost ceiling). */
export function shieldFullDrawOn(ship: ShipData, shieldOns: boolean[] | undefined): number {
  const on = shieldOnsOf(ship, shieldOns);
  return (ship.components ?? []).reduce((s, c, i) => s + (isShieldComponent(c) && on[i] ? pipCost(fullDrawOf(c)) : 0), 0);
}

/** Shield slider cap — BOOST LADDER rule (2026-10-23): the whole ship shares one
 *  pool, so boosting above the minOnline floor requires EVERY generator online:
 *  all ON ⇒ cap = Σ pipCost(fullDraw) (full pool + boost room, = ship.shieldPool on
 *  the snapshot); ANY generator OFF ⇒ cap = Σ pipCost(minOnline) over the ON set =
 *  the floor — each ON generator contributes only its minimum (offline generator
 *  offline per Comm-Link 20263, and a partial pool cannot be boosted); all OFF ⇒ 0
 *  (zero-shields loadouts legal). */
export function shieldCapOn(ship: ShipData, shieldOns: boolean[] | undefined): number {
  const comps = (ship.components ?? []).filter(isShieldComponent);
  if (comps.length === 0) return 0;
  const on = shieldOnsOf(ship, shieldOns);
  const anyOff = (ship.components ?? []).some((c, i) => isShieldComponent(c) && !on[i]);
  return anyOff ? shieldFloorOn(ship, shieldOns) : shieldFullDrawOn(ship, shieldOns);
}

/** DECLARED HEURISTIC (2026-10-23, per-shield on/off): the API exposes ONE ship-level
 *  shield pool (`ship.shield.hp`/`regenPerSec`, single faceType) with no per-generator
 *  hp split, so the SIM scales the whole pool by
 *  `factor = Σ pipCost(fullDraw ON) / Σ pipCost(fullDraw ALL)` — each generator
 *  contributes its fullDraw share of the pool, and an offline generator (Comm-Link
 *  20263: below minOnline a component is not activated) contributes nothing:
 *  one of two equal shields off ⇒ factor 0.5 (hp and regen halved); all off ⇒
 *  factor 0, shields fully off and damage lands on structure. Ship-level absorption
 *  (shieldSplitFor) is NOT scaled — the API has no per-face absorption data; the
 *  pool/regen scaling is the strength lever. Ships with no Shield components
 *  (Σ fullDraw 0, legacy snapshots) get factor 1 so the legacy pool is untouched. */
export function shieldStrengthFactor(ship: ShipData, shieldOns: boolean[] | undefined): number {
  const all = (ship.components ?? []).reduce((s, c) => s + (isShieldComponent(c) ? pipCost(fullDrawOf(c)) : 0), 0);
  if (all <= 0) return 1;
  // Uses the fullDraw ON-sum, NOT shieldCapOn: the cap follows the boost-ladder
  // rule (any generator off ⇒ cap = floor) and must not rescale pool strength.
  return shieldFullDrawOn(ship, shieldOns) / all;
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

/** Billed cost of the default (locked) allocation: whole pips at minOnline. */
export function defaultAllocOf(c: ShipComponent): number {
  return isPoweredByDefault(c) ? pipCost(minOnlineOf(c)) : 0;
}

/** Σ SYSTEM component allocations, each billed via `pipCost` after clamping to
 *  [0, fullDraw]; non-system entries of a parallel allocs array are always treated
 *  as 0. A missing (non-array) allocs list means "every system at its default
 *  allocation" (pipCost minOnline, except the unpowered QuantumDrive/jump types at
 *  0) — the default state. */
export function systemReserve(ship: ShipData, allocs: number[] | undefined): number {
  const components = ship.components ?? [];
  if (!Array.isArray(allocs)) return components.reduce((s, c) => s + defaultAllocOf(c), 0);
  return components.reduce((s, c, i) => s + (isSystemComponent(c) ? pipCost(Math.min(Math.max(0, allocs[i] ?? 0), fullDrawOf(c))) : 0), 0);
}

/** Fixed guns + manned turrets + PDCs all ride in the weapons pool: aggregate fixed
 *  draw (`gunDraw`, API grouped WeaponGun, FRACTIONAL usage) plus `pdcCount ×
 *  TURRET_POWER_PIPS` while the PDC toggle is on. Manned-turret draw scales with the
 *  gun-pip fraction like everything else in the pool (plan: weapons-claim-first is
 *  about fitting the budget, not about turrets drawing at zero pips). Returns the
 *  RAW usage — the billed cost applies `pipCost` at the fraction in `allocatedPower`. */
export function gunDrawFull(ship: ShipData, pdcOn: boolean): number {
  return (ship.gunDraw ?? 0) + (pdcOn ? (ship.pdcCount ?? 0) * TURRET_POWER_PIPS : 0);
}

/** Billed gun-pool cost at the gun-pip fraction: whole pips (ceil) of the scaled
 *  draw; 0 pips at fraction 0 (guns off frees the pool completely). */
export function gunCostAt(ship: ShipData, gunPips: number, pdcOn: boolean): number {
  const frac = ship.weaponPool > 0 ? Math.min(1, Math.max(0, gunPips / ship.weaponPool)) : 0;
  return frac > 0 ? pipCost(gunDrawFull(ship, pdcOn) * frac) : 0;
}

/** Total pips claimed by the allocation: systems reserve + shield pips +
 *  the gun pool's whole-pip cost at the gun-pip fraction. All terms are integers. */
export function allocatedPower(ship: ShipData, allocs: number[] | undefined, gunPips: number, shieldPips: number, pdcOn: boolean): number {
  return systemReserve(ship, allocs) + pipCost(shieldPips) + gunCostAt(ship, gunPips, pdcOn);
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

/** Fewest gun pips that power the gun pool at FULL draw: the smallest p in
 *  [0, weaponPool] with `gunCostAt(ship, p, true) === pipCost(gunDrawFull(ship,
 *  true))` (the cost saturates at p = weaponPool, so the search always
 *  terminates). Fractional draws land the guns just below pool (e.g. draw 2.93 /
 *  pool 3: ceil(2.93·p/3) == 3 at p = 3; draw 3.1 / pool 8: ceil(3.1·p/8) == 4
 *  from p = 9 > pool ⇒ pool). Zero-draw ships get 0. */
export function minGunPipsFull(ship: ShipData): number {
  const pool = Math.max(0, ship.weaponPool);
  const full = pipCost(gunDrawFull(ship, true));
  if (full <= 0) return 0;
  for (let p = 0; p <= pool; p++) if (gunCostAt(ship, p, true) === full) return p;
  return pool;
}

/** Opening state (plan Decisions 2/3 + RULE-R + QDrive-unpowered + round-up billing
 *  + SHIELD/GUN DEFAULTS 2026-10-23): every powered SYSTEM component at its pipCost
 *  minOnline, QuantumDrive/jump at 0 (allocs array stays index-parallel to
 *  ship.components; non-system entries are 0), PDC on, guns at the MINIMUM powered
 *  pips (`minGunPipsFull` — full gun draw at the fewest pips), shields at the
 *  minimum floor **with every shield generator ON** (`shieldFloorOn`, boost room
 *  left to the user). On overdraw, descending ladder: PDC → OFF; if still over,
 *  guns → 0 (weapons-claim-first preserved); shields STAY at the floor; systems
 *  are NEVER forced below minOnline — the residual overdraw stays on the net (red)
 *  for the user to cut; the T20 Fight gate disables those matchups. Per-Shield
 *  toggles (2026-10-23) let a red-at-defaults ship escape overdraw by switching a
 *  generator OFF — the ladder only floors at the ALL-on minOnline, and an OFF
 *  generator's pips are freed (boost cap drops to the reduced floor, so the slider
 *  follows), so the red ships (Ironclad, Ironclad Assault, Prowler Utility WWS,
 *  MISC Hull B under the round-up defaults) become fightable once the user drops a
 *  shield and slides the shield pips down to the reduced ON-set floor. */
export function defaultAllocation(ship: ShipData): PowerAllocation {
  const allocs = (ship.components ?? []).map(defaultAllocOf);
  let pdcOn = true;
  const shieldPips = shieldFloorOn(ship, undefined);
  let gunPips = minGunPipsFull(ship);
  if (ship.powerSegments - allocatedPower(ship, allocs, gunPips, shieldPips, pdcOn) < 0) pdcOn = false;
  if (ship.powerSegments - allocatedPower(ship, allocs, gunPips, shieldPips, pdcOn) < 0) gunPips = 0;
  return { allocs, gunPips, shieldPips, pdcOn };
}
