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

/** Share of incoming DPS that reaches defender shields, weighted by attacker damage mix.
 *  factor = mid(absorption) - mid(resistance), clamped to [0, 1]. */
export function shieldFactorFor(defender: ShipData, mix: Record<DamageType, number>): number {
  let f = 0;
  for (const t of DAMAGE_TYPES) {
    if (mix[t] === 0) continue;
    const a = defender.shield.absorption[t];
    const r = defender.shield.resistance[t];
    const typeFactor = Math.min(1, Math.max(0, (a.min + a.max) / 2 - (r.min + r.max) / 2));
    f += mix[t] * typeFactor;
  }
  return f;
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
