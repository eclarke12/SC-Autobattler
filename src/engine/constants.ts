// All gameplay tunables live here (plan: "declare in src/engine/constants.ts with comments").

import gunAmmoSizes from '../../data/gun-ammo-sizes.json';
import type { ShipData } from './types';

/** Armor deflection is modeled as a hard gate per weapon (api.star-citizen.wiki
 *  `armor.deflection.{physical,energy}` vs. weapon alpha), not a flat percentage.
 *  Weapons whose per-shot damage (alpha) is at or below the defender's deflection for that
 *  damage type deal no damage while the defender's armor pool is above zero (the game
 *  deflects damage ≤ the rating). The gate scales with armor integrity (A1, 2026-10-22):
 *  the effective gate is `deflection × armor/armorMax`, reaching 0 when the armor pool is
 *  destroyed — the game degrades deflection as armor is stripped.
 *  Alpha values of 0 (unknown per-shot damage) are never deflected.
 *  `armor.penetration_resistance` is 1.0 fleet-wide in the API, so no penetration
 *  multiplier is applied; shots that pass the gate deal full damage to armor (scaled by
 *  `armor.damage_multipliers`), with overflow to hull once armor is depleted. */

/** Gate-vs-integrity curve. 'linear' = effective gate × (armor/armorMax). Tunable hook
 *  for curve variants (e.g. convex degradation) if the 4.x curve gets pinned down. */
export const DEFLECTION_INTEGRITY_MODEL = 'linear' as const;

/** Per-round damage roll variance: ±15%, seeded. */
export const VARIANCE = 0.15;

/** Simulated seconds per round. */
export const ROUND_SECONDS = 10;

/** Hard cap; winner decided by hull % if reached. */
export const MAX_ROUNDS = 100;

/** Power pips consumed by each manned turret AND each PDC (plan-power-components
 *  T17: the API exposes no per-turret/PDC power — turret item usage is 0–0 — so this
 *  is a declared heuristic; PDCs lump into the weapons pool with a single on/off
 *  toggle, manned-turret draw scales with the gun-pip fraction in `gunDrawFull`). */
export const TURRET_POWER_PIPS = 1;

/** Ordnance & countermeasures.
 *
 *  Evasion model (Star Citizen mechanics): missiles home on the strongest signal source,
 *  so stacked decoys must add up to at least the target's IR signature to drag the seeker
 *  off (community rule of thumb: "the amount required depends on the size of your
 *  signature and the size of the flares", r/starcitizen; decoy-vs-missile updates,
 *  RSI Spectrum 3.11). required = ceil(target IR signature / decoy strength). Ships with
 *  no decoys (no CountermeasureLauncher in the hardpoint tree) are hit by everything.
 *
 *  Shield interaction: missiles deal explosive blast routed as physical (quantum racks —
 *  the Polaris S6 torpedoes — route as distortion, O3), and physical shield penetration
 *  lets the blast bleed through: 77.5% of a missile's damage reaches armor/hull even at
 *  full shields (factor = mid(absorption.physical) 0.225, S5 review), rising to 100% as
 *  shields drop. Distortion blasts are fully absorbed by shields (absorption 1.0) —
 *  quantum torpedoes grind shield pools and only strike structure once shields are down.
 *  Missiles bypass the armor deflection gate entirely (O1, 2026-10-22: explosives and
 *  quantum have deflection 0 in-game); decoys and maneuver are the only defense. */

/** IR strength of one decoy/flare; a 5,000 IR ship needs 5 decoys to evade a missile. */
export const DECOY_STRENGTH = 1000;

/** Torpedoes (size >= 5 racks) are very susceptible to countermeasures: each decoy
 *  counts double against them (requirement = ceil(IR / (2 × DECOY_STRENGTH))). */
export const TORPEDO_CM_EFFICIENCY = 2;

/** Pilot fumble: chance a missile slips through a sufficient decoy barrage. */
export const MISSILE_FUMBLE = 0.1;

/** Missiles salvo 1 per round until dry; torpedoes reload between shots. */
export const TORPEDO_FIRE_EVERY_ROUNDS = 2;

/** Decoy ammunition stock by hull size (API exposes launcher count, not charges). */
export const DECOY_STOCK_BY_SIZE: Record<ShipData['sizeClass'], number> = {
  snub: 10, small: 15, medium: 25, large: 50, capital: 100, special: 25, unknown: 10,
};

/** Gun ammunition (W4, T13): shots per ballistic gun, by gun size class. The API ships
 *  NO per-weapon ammo fields and NO gun size (probe GC2: fixed entries are exactly
 *  {name, dps, sustained_dps, alpha}) — declared heuristic table mirroring the
 *  DECOY_STOCK_BY_SIZE pattern; the deviation is recorded in the primer (§12.17).
 *  Size comes from `S<n>` name tokens (e.g. "KLWE_LaserRepeater_S4"); untagged guns
 *  default to S2 (fleet's most common gun class). Energy weapons (lasers) draw ship
 *  power and are infinite (ammo null, never in this table); alpha-0 guns have unknown
 *  fire rate and consume no ammo. In-game reference points: S1 gatling mags run to
 *  thousands of rounds, S5+ railguns drop to hundreds. Single source:
 *  data/gun-ammo-sizes.json (imported here and read by scripts/build-data.mjs). */
export const GUN_AMMO_BY_SIZE: Record<number, number> = gunAmmoSizes as unknown as Record<number, number>;
export const GUN_AMMO_SIZE_DEFAULT = 2;
