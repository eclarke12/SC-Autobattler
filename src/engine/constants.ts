// All gameplay tunables live here (plan: "declare in src/engine/constants.ts with comments").

/** Fraction of incoming DPS deflected before it reaches shields. Per-ship deflection is not
 *  exposed by the API (armor.deflection holds numeric penetration thresholds, not %), so this
 *  is a global tunable. */
export const DEFLECTION = 0.1;

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
