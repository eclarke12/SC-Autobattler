import {
  DECOY_STOCK_BY_SIZE,
  DECOY_STRENGTH,
  DEFLECTION_INTEGRITY_MODEL,
  MISSILE_FUMBLE,
  TORPEDO_CM_EFFICIENCY,
  TURRET_POWER_PIPS,
} from './constants';
import { fullDrawOf, gunCostAt, gunDrawFull, isShieldComponent, isSystemComponent, minOnlineOf, netPower, pipCost, shieldCapOn, shieldOnsOf, shieldStrengthFactor, systemReserve } from './power';
import { DAMAGE_TYPES } from './types';
import type { DamageType, DerivedStats, ShipConfig, ShipData, Weapon } from './types';

export function derivedStats(config: ShipConfig): DerivedStats {
  const { ship, mannedTurrets, powerToWeapons, powerToShields } = config;
  const fixed = ship.weapons.filter((w) => w.type === 'fixed');
  const turrets = ship.weapons.filter((w) => w.type === 'turret');

  const fixedDps = fixed.reduce((s, w) => s + w.dps, 0);
  const turretDpsPool = turrets.reduce((s, w) => s + w.dps, 0);
  const turretDps = ship.turretCount > 0 ? (turretDpsPool * Math.min(mannedTurrets, ship.turretCount)) / ship.turretCount : 0;

  // Weapon supply = the gun-pip fraction of the weapons pool (plan T19; replaces the
  // DPS/500 `powerDemand` heuristic). A ship with an empty pool is only unpowered if
  // it actually has weapons to feed.
  const dpsScale = ship.weaponPool > 0
    ? Math.min(1, powerToWeapons / ship.weaponPool)
    : (fixedDps + turretDps > 0 ? 0 : 1);
  const weaponDps = (fixedDps + turretDps) * dpsScale;

  // Shield regen = the allocated-pip fraction of the shield cap (plan T19; the
  // over-pool bonus model retired) × the per-Shield on/off strength factor
  // (declared heuristic 2026-10-23 — shieldStrengthFactor in power.ts).
  // 0 pips = shields off = no regen; an off generator drops the cap AND scales
  // the regen down by its fullDraw share, so s = cap(ON) reads the ON set's
  // regen, not double-counted against the all-shield pool. Ships with NO Shield
  // components (legacy snapshots, no per-generator data) keep the original
  // allocated/shieldPool formula (cap 0 → pool denominator, factor 1).
  const shieldCap = shieldCapOn(ship, config.shieldOns);
  const regenDenom = shieldCap > 0 ? shieldCap : ship.shieldPool;
  const shieldRegen = ship.shieldPool > 0 && regenDenom > 0
    ? ship.shield.regenPerSec * Math.min(1, powerToShields / regenDenom) * shieldStrengthFactor(ship, config.shieldOns)
    : 0;

  const mix: Record<DamageType, number> = {
    physical: 0, energy: 0, distortion: 0, thermal: 0, biochemical: 0, stun: 0,
  };
  const perType: Record<DamageType, number> = { ...mix };
  for (const w of fixed) perType[w.damageType] += w.dps;
  for (const w of turrets) perType[w.damageType] += w.dps;
  const total = Object.values(perType).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const t of DAMAGE_TYPES) mix[t] = perType[t] / total;
  }

  return { fixedDps, turretDps, weaponDps, dpsScale, shieldRegen, damageMix: mix };
}

/** Split of incoming DPS: fraction absorbed by defender shields vs. fraction that phases
 *  through to armor/hull, weighted by attacker damage mix.
 *  factor = mid(absorption) clamped to [0, 1] per damage type (S5 review 2026-10-22: the
 *  API absorption bands reproduce the in-game absorption at face value — energy {1,1},
 *  ballistic {0,0.45}, distortion {1,1} — while the resistance bands ({0,0.25}, {0,0},
 *  {0.75,0.95}) are a separate reduction band; mid(res) ≤ mid(abs) on all 261 ships, so
 *  subtracting it pushed the physical factor below the documented 0–0.45 absorption
 *  range. Resistance stays out of the split, reserved for regen/durability semantics).
 *  Ballistic (physical) weapons leak ~77.5% of their damage past the shield directly
 *  onto armor (and hull once armor is gone). */
export function shieldSplitFor(defender: ShipData, mix: Record<DamageType, number>): { shield: number; structure: number } {
  let f = 0;
  for (const t of DAMAGE_TYPES) {
    if (mix[t] === 0) continue;
    const a = defender.shield.absorption[t];
    const typeFactor = Math.min(1, Math.max(0, (a.min + a.max) / 2));
    f += mix[t] * typeFactor;
  }
  return { shield: f, structure: 1 - f };
}

export function deflectionFor(defender: ShipData, type: DamageType): number {
  return defender.armorDeflection?.[type] ?? 0;
}

/** Armor integrity ratio (armor left / armor max): 0 when the ship has no armor pool,
 *  floored at 0, not clamped above 1. Shared by the gate math (gatedLoadout) and the
 *  simulate round loop's deflect notes. */
export function armorRatioOf(armorMax: number, armorLeft: number): number {
  return armorMax > 0 ? Math.max(0, armorLeft / armorMax) : 0;
}

/** Shared armor deflection gate: per-shot damage (alpha) at or below the defender's
 *  effective gate is deflected while the defender has armor (game deflects damage ≤ the
 *  rating); alpha 0 (unknown) is never deflected. The effective gate degrades linearly
 *  with armor integrity (A1, DEFLECTION_INTEGRITY_MODEL): armorRatio 1 ⇒ full gate,
 *  armorRatio 0 (armor destroyed) ⇒ gate lifted.
 *  Used by the weapons path (gatedLoadout). Missiles bypass the gate entirely (O1). */
export function isDeflectedByGate(alpha: number, gate: number, armorRatio: number): boolean {
  return armorRatio > 0 && alpha > 0 && alpha <= effectiveGate(gate, armorRatio);
}

/** Gate value scaled by armor integrity: `gate × armorRatio` (linear model); 0 once the
 *  armor pool is destroyed. Exported for UI effective-gate displays. */
export function effectiveGate(gate: number, armorRatio: number): number {
  if (armorRatio <= 0) return 0;
  return DEFLECTION_INTEGRITY_MODEL === 'linear' ? gate * Math.min(1, armorRatio) : gate;
}

/** Decoys a defender must stack to drag one incoming missile's seeker off its IR
 *  signature: ceil(target IR / decoy strength). Torpedoes are very susceptible: each
 *  decoy counts double. Ships with no decoy launchers can never evade (required is
 *  moot — 0 stock). */
export function requiredDecoysFor(defender: ShipData, torpedo: boolean): number {
  const eff = DECOY_STRENGTH * (torpedo ? TORPEDO_CM_EFFICIENCY : 1);
  return Math.max(1, Math.ceil((defender.emission?.ir ?? 0) / eff));
}

/** Flare charges carried: launcher count × size-class stock (API has no charge counts). */
export function decoyStockFor(ship: ShipData): number {
  return ship.countermeasures?.decoys > 0
    ? DECOY_STOCK_BY_SIZE[ship.sizeClass] * ship.countermeasures.decoys
    : 0;
}

/** P(evade) given remaining decoy stock vs the requirement: sufficient barrage evades
 *  everything except the pilot-fumble share; a partial barrage scales that down; zero
 *  stock never evades. */
export function decoyEvadeChance(decoysLeft: number, required: number): number {
  if (decoysLeft <= 0 || required <= 0) return 0;
  const base = 1 - MISSILE_FUMBLE;
  return decoysLeft >= required ? base : base * (decoysLeft / required);
}

/** Gun ammunition depletion model (W4, T13). Fire rate is derived from the API pair:
 *  alpha is per-shot damage and dps is damage per second, so shots/s = `dps / alpha`
 *  and shots per round = `round(fireRate × roundSeconds)`, floored at 1 shot/round so
 *  slow burst guns (railguns) still spend ammunition. `ammo === null` (energy lasers,
 *  alpha-0 guns with unknown fire rate) = infinite: perRound 0, rounds null. */
export function gunAmmoInfo(w: Weapon, roundSeconds: number): { perRound: number; rounds: number | null } {
  if (w.ammo === null) return { perRound: 0, rounds: null };
  const perRound = w.alpha > 0
    ? Math.max(1, Math.round((w.dps / w.alpha) * roundSeconds))
    : Math.max(1, Math.round(roundSeconds));
  return { perRound, rounds: Math.ceil(w.ammo / perRound) };
}

export interface GatedAttack {
  /** Effective DPS against this defender after the armor deflection gate. */
  dps: number;
  /** Damage-type mix of the surviving (non-deflected) output. */
  mix: Record<DamageType, number>;
  /** Weapons firing at all (effective dps > 0), deflected ones included. */
  fired: number;
  /** Indices into `config.ship.weapons` of the weapons that fired this engagement —
   *  deflected weapons included (a deflected shot leaves the barrel and spends ammo).
   *  Dry (ammo ≤ 0) and zero-dps weapons are excluded. Drives gun-ammo depletion. */
  firedIndices: number[];
  /** Weapons deflected this engagement: label × count. */
  deflected: { name: string; count: number }[];
}

/** Hard gate: while the defender has armor, weapons whose per-shot damage (alpha) is at or
 *  below the defender's effective gate (deflection × armor integrity) for that damage type
 *  deal no damage at all. As the armor pool depletes the gate shrinks and marginal weapons
 *  resume fire; at 0 armor the gate lifts. Alpha 0 (unknown) is never deflected.
 *  `ammoLeft` (W4, indexed by weapon): entries ≤ 0 are dry — zero contribution, excluded
 *  from `fired` and the mix (they consume no ammo — there is none left). Omitted (UI) =
 *  full loadout. */
export function gatedLoadout(config: ShipConfig, defender: ShipData, defenderArmor: number, dpsScale: number, ammoLeft?: number[]): GatedAttack {
  const { ship, mannedTurrets } = config;
  const armorRatio = armorRatioOf(defender.armor, defenderArmor);
  const turretShare = ship.turretCount > 0 ? Math.min(mannedTurrets, ship.turretCount) / ship.turretCount : 0;
  const mix: Record<DamageType, number> = {
    physical: 0, energy: 0, distortion: 0, thermal: 0, biochemical: 0, stun: 0,
  };
  const deflectedNames = new Map<string, number>();
  let total = 0;
  let fired = 0;
  const firedIndices: number[] = [];
  ship.weapons.forEach((w, i) => {
    if (ammoLeft && ammoLeft[i] !== undefined && ammoLeft[i] <= 0) return;
    const dps = (w.type === 'fixed' ? w.dps : w.dps * turretShare) * dpsScale;
    if (dps <= 0) return;
    fired += 1;
    firedIndices.push(i);
    if (isDeflectedByGate(w.alpha, deflectionFor(defender, w.damageType), armorRatio)) {
      deflectedNames.set(w.name, (deflectedNames.get(w.name) ?? 0) + 1);
      return;
    }
    mix[w.damageType] += dps;
    total += dps;
  });
  if (total > 0) {
    for (const t of DAMAGE_TYPES) mix[t] /= total;
  }
  const deflected = [...deflectedNames.entries()].map(([name, count]) => ({ name, count }));
  return { dps: total, mix, fired, firedIndices, deflected };
}

export interface PowerNote {
  kind: 'systems-reserve' | 'pdc-draw' | 'under-powered-guns' | 'shields-off' | 'shields-at-floor' | 'overdrawn';
  pips: number;
  text: string;
}

/** Game-legal manned-turret ceiling (W3): the API's `turrets.manned` hardpoint count
 *  ignores crew — every manned turret needs a gunner, and 1 seat is reserved for the
 *  pilot, so the game-legal count is `crew.max − 1`. The app deliberately does NOT
 *  clamp `mannedTurrets` to this (plan T12: annotation only, no enforcement); the UI
 *  shows "game-legal max: N (crew)" when the cap is below the hardpoint count. In the
 *  current fleet data the API's hardpoint counts already respect the cap for all 228
 *  ships (cap > count on 103, e.g. Hammerhead 6 turrets / 8 crew), so the annotation
 *  is latent — it fires for future data where `turrets.manned` exceeds crew seats. */
export function crewTurretCap(ship: ShipData): number {
  return Math.max(0, (ship.crew.max ?? 0) - 1);
}

/** Pip count formatted for note text (and the T20/T21 UI): integers plain,
 *  fractional (gun draw) at 1 dp, trailing zeros stripped. */
export function fmtPip(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Human-readable power-allocation observations (plan T19 model: overdraw, gun-pip
 *  fraction, shield floor/off, PDC draw, systems reserve). The Fight gate (net < 0)
 *  lives at the App boundary (T20); the engine reports, it never clamps. */
export function powerNotes(config: ShipConfig): PowerNote[] {
  const { ship, powerToWeapons, powerToShields } = config;
  const pdcOn = config.pdcOn ?? true;
  const d = derivedStats(config);
  const notes: PowerNote[] = [];
  const components = (ship.components ?? []).filter(isSystemComponent); // RULE-R: reserve = systems only
  if (components.length > 0) {
    const reserve = systemReserve(ship, config.allocs);
    const capacity = components.reduce((s, c) => s + pipCost(fullDrawOf(c)), 0);
    notes.push({ kind: 'systems-reserve', pips: reserve, text: `systems draw ${fmtPip(reserve)} of ${fmtPip(capacity)} pips (whole-pip billing)` });
  }
  const pdcPips = (ship.pdcCount ?? 0) * TURRET_POWER_PIPS;
  if (pdcOn && pdcPips > 0) {
    notes.push({ kind: 'pdc-draw', pips: pdcPips, text: `PDC × ${ship.pdcCount} draws ${fmtPip(pdcPips)} into the weapons pool when on — toggle off to free pips` });
  }
  if (ship.weaponPool > 0 && d.dpsScale < 1) {
    notes.push({
      kind: 'under-powered-guns',
      pips: Math.max(0, ship.weaponPool - powerToWeapons),
      text: `guns at ${(d.dpsScale * 100).toFixed(0)}% power (${powerToWeapons}/${ship.weaponPool} pips, drawing ${fmtPip(gunCostAt(ship, powerToWeapons, pdcOn))} of ${fmtPip(pipCost(gunDrawFull(ship, pdcOn)))} billed) — DPS cut to ${(d.dpsScale * 100).toFixed(0)}%`,
    });
  }
  const shieldOns = shieldOnsOf(ship, config.shieldOns);
  const shieldCap = shieldCapOn(ship, config.shieldOns);
  // Raw ON-set Σ minOnline — the ON-set floor (per-Shield toggles 2026-10-23); an
  // off generator drops out of the floor, so the floor note follows the ON set.
  const shieldFloorRaw = (ship.components ?? []).reduce((s, c, i) => s + (isShieldComponent(c) && shieldOns[i] ? minOnlineOf(c) : 0), 0);
  if (powerToShields <= 0) {
    notes.push({ kind: 'shields-off', pips: 0, text: 'shields off: no regeneration' });
  } else if (shieldFloorRaw > 0 && shieldFloorRaw < shieldCap && powerToShields <= shieldFloorRaw) {
    notes.push({
      kind: 'shields-at-floor',
      pips: pipCost(shieldFloorRaw),
      text: `shields at floor (${fmtPip(pipCost(shieldFloorRaw))} pips): regen ${(100 * (d.shieldRegen / Math.max(1e-9, ship.shield.regenPerSec))).toFixed(0)}%`,
    });
  }
  const net = netPower(ship, config);
  if (net < 0) {
    notes.push({ kind: 'overdrawn', pips: Math.ceil(-net), text: `overdrawn by ${fmtPip(-net)} — Fight disabled until you cut systems` });
  }
  return notes;
}
