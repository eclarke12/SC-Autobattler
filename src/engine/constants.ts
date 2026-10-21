// All gameplay tunables live here (plan: "declare in src/engine/constants.ts with comments").

import type { ShipData } from './types';

/** Armor deflection is modeled as a hard gate per weapon (api.star-citizen.wiki
 *  `armor.deflection.{physical,energy}` vs. weapon alpha), not a flat percentage.
 *  Weapons whose per-shot damage (alpha) is below the defender's deflection for that
 *  damage type deal no damage while the defender's armor pool is above zero.
 *  Alpha values of 0 (unknown per-shot damage) are never deflected.
 *  `armor.penetration_resistance` is 1.0 fleet-wide in the API, so no penetration
 *  multiplier is applied; shots that pass the gate deal full damage to armor, with
 *  overflow to hull once armor is depleted. */

/** Per-round damage roll variance: ±15%, seeded. */
export const VARIANCE = 0.15;

/** Simulated seconds per round. */
export const ROUND_SECONDS = 10;

/** Hard cap; winner decided by hull % if reached. */
export const MAX_ROUNDS = 100;

/** Shield regen bonus per power segment allocated ABOVE the ship's shield pool size. */
export const SHIELD_POWER_BONUS_PER_SEGMENT = 0.25;

/** Assumed DPS of fixed weapons per power segment at nominal supply. The API exposes no
 *  per-weapon power draw for ship weapons, so weapon power demand is derived from total DPS.
 *  Below full demand, DPS scales linearly (proportional cut). */
export const WEAPON_DPS_PER_SEGMENT = 500;

/** Power segments consumed by each manned turret. */
export const TURRET_POWER_SEGMENTS = 1;

/** Ordnance & countermeasures.
 *
 *  Evasion model (Star Citizen mechanics): missiles home on the strongest signal source,
 *  so stacked decoys must add up to at least the target's IR signature to drag the seeker
 *  off (community rule of thumb: "the amount required depends on the size of your
 *  signature and the size of the flares", r/starcitizen; decoy-vs-missile updates,
 *  RSI Spectrum 3.11). required = ceil(target IR signature / decoy strength). Ships with
 *  no decoys (no CountermeasureLauncher in the hardpoint tree) are hit by everything.
 *
 *  Shield interaction: missiles deal physical/ballistic explosive damage, and physical
 *  shield penetration lets the blast bleed through — ~70% of a missile's damage reaches
 *  armor/hull even at full shields, rising to 100% as shields drop. The engine already
 *  models this leak via shield.absorption/resistance, so missiles route through it. */

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
