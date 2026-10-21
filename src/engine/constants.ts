// All gameplay tunables live here (plan: "declare in src/engine/constants.ts with comments").

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
