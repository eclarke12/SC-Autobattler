import {
  SHIELD_POWER_BONUS_PER_SEGMENT,
  TURRET_POWER_SEGMENTS,
  WEAPON_DPS_PER_SEGMENT,
} from './constants';
import { DAMAGE_TYPES } from './types';
import type { DamageType, DerivedStats, ShipConfig, ShipData } from './types';

export function derivedStats(config: ShipConfig): DerivedStats {
  const { ship, mannedTurrets, powerToWeapons, powerToShields } = config;
  const fixed = ship.weapons.filter((w) => w.type === 'fixed');
  const turrets = ship.weapons.filter((w) => w.type === 'turret');

  const fixedDps = fixed.reduce((s, w) => s + w.dps, 0);
  const turretDpsPool = turrets.reduce((s, w) => s + w.dps, 0);
  const turretDps = ship.turretCount > 0 ? (turretDpsPool * Math.min(mannedTurrets, ship.turretCount)) / ship.turretCount : 0;

  const manned = Math.min(mannedTurrets, ship.turretCount);
  const powerDemand = Math.ceil(fixedDps / WEAPON_DPS_PER_SEGMENT) + manned * TURRET_POWER_SEGMENTS;
  const dpsScale = powerDemand === 0 ? 1 : Math.min(1, powerToWeapons / powerDemand);
  const weaponDps = (fixedDps + turretDps) * dpsScale;

  const extraShieldSegments = Math.max(0, powerToShields - ship.shieldPool);
  const shieldRegen = powerToShields >= 1 ? ship.shield.regenPerSec * (1 + SHIELD_POWER_BONUS_PER_SEGMENT * extraShieldSegments) : 0;

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

  return { fixedDps, turretDps, weaponDps, powerDemand, dpsScale, shieldRegen, damageMix: mix };
}

/** Split of incoming DPS: fraction absorbed by defender shields vs. fraction that phases
 *  through to armor/hull, weighted by attacker damage mix.
 *  factor = mid(absorption) - mid(resistance), clamped to [0, 1] per damage type.
 *  Ballistic (physical) weapons against shield types with low physical absorption leak most
 *  of their damage past the shield directly onto armor (and hull once armor is gone). */
export function shieldSplitFor(defender: ShipData, mix: Record<DamageType, number>): { shield: number; structure: number } {
  let f = 0;
  for (const t of DAMAGE_TYPES) {
    if (mix[t] === 0) continue;
    const a = defender.shield.absorption[t];
    const r = defender.shield.resistance[t];
    const typeFactor = Math.min(1, Math.max(0, (a.min + a.max) / 2 - (r.min + r.max) / 2));
    f += mix[t] * typeFactor;
  }
  return { shield: f, structure: 1 - f };
}

export function deflectionFor(defender: ShipData, type: DamageType): number {
  return defender.armorDeflection?.[type] ?? 0;
}

export interface GatedAttack {
  /** Effective DPS against this defender after the armor deflection gate. */
  dps: number;
  /** Damage-type mix of the surviving (non-deflected) output. */
  mix: Record<DamageType, number>;
  /** Weapons firing at all (effective dps > 0), deflected ones included. */
  fired: number;
  /** Weapons deflected this engagement: label × count. */
  deflected: { name: string; count: number }[];
}

/** Hard gate: while the defender has armor, weapons whose per-shot damage (alpha) is below
 *  the defender's armor deflection for that damage type deal no damage at all. Once armor is
 *  depleted the gate no longer applies. Alpha 0 (unknown) is never deflected. */
export function gatedLoadout(config: ShipConfig, defender: ShipData, defenderArmor: number, dpsScale: number): GatedAttack {
  const { ship, mannedTurrets } = config;
  const gateActive = defenderArmor > 0;
  const turretShare = ship.turretCount > 0 ? Math.min(mannedTurrets, ship.turretCount) / ship.turretCount : 0;
  const mix: Record<DamageType, number> = {
    physical: 0, energy: 0, distortion: 0, thermal: 0, biochemical: 0, stun: 0,
  };
  const deflectedNames = new Map<string, number>();
  let total = 0;
  let fired = 0;
  for (const w of ship.weapons) {
    const dps = (w.type === 'fixed' ? w.dps : w.dps * turretShare) * dpsScale;
    if (dps <= 0) continue;
    fired += 1;
    if (gateActive && w.alpha > 0 && w.alpha < deflectionFor(defender, w.damageType)) {
      deflectedNames.set(w.name, (deflectedNames.get(w.name) ?? 0) + 1);
      continue;
    }
    mix[w.damageType] += dps;
    total += dps;
  }
  if (total > 0) {
    for (const t of DAMAGE_TYPES) mix[t] /= total;
  }
  const deflected = [...deflectedNames.entries()].map(([name, count]) => ({ name, count }));
  return { dps: total, mix, fired, deflected };
}

export interface PowerNote {
  kind: 'under-powered-weapons' | 'over-powered-weapons' | 'over-powered-shields' | 'shields-unpowered';
  segments: number;
  text: string;
}

/** Human-readable power-allocation observations (plan Task 6: "power-efficiency notes"). */
export function powerNotes(config: ShipConfig): PowerNote[] {
  const { ship, powerToWeapons, powerToShields } = config;
  const d = derivedStats(config);
  const notes: PowerNote[] = [];
  if (d.dpsScale < 1) {
    notes.push({
      kind: 'under-powered-weapons',
      segments: d.powerDemand - powerToWeapons,
      text: `Weapons under-powered: supply ${(d.dpsScale * 100).toFixed(0)}% of demand (${powerToWeapons}/${d.powerDemand} segments) — DPS cut to ${(d.dpsScale * 100).toFixed(0)}%.`,
    });
  }
  const wasted = powerDemandWaste(powerToWeapons, d.powerDemand);
  if (wasted > 0) {
    notes.push({
      kind: 'over-powered-weapons',
      segments: wasted,
      text: `${wasted} weapon segment(s) above full demand do nothing — move them to shields.`,
    });
  }
  if (powerToShields === 0) {
    notes.push({ kind: 'shields-unpowered', segments: 0, text: 'Shields unpowered: no regeneration.' });
  } else if (powerToShields > ship.shieldPool) {
    const bonus = Math.round(SHIELD_POWER_BONUS_PER_SEGMENT * (powerToShields - ship.shieldPool) * 100);
    notes.push({
      kind: 'over-powered-shields',
      segments: powerToShields - ship.shieldPool,
      text: `Shields over-powered by ${powerToShields - ship.shieldPool} segment(s): regen +${bonus}% (+${Math.round(d.shieldRegen - ship.shield.regenPerSec)}/s), weapons untouched.`,
    });
  }
  return notes;
}

function powerDemandWaste(powerToWeapons: number, demand: number): number {
  return Math.max(0, powerToWeapons - Math.max(demand, 1));
}
