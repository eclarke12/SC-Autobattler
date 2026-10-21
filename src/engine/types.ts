export const DAMAGE_TYPES = ['physical', 'energy', 'distortion', 'thermal', 'biochemical', 'stun'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

export interface Range {
  min: number;
  max: number;
}

export interface Weapon {
  name: string;
  type: 'fixed' | 'turret';
  damageType: DamageType;
  dps: number;
  /** Per-shot (burst) damage; compared against defender armor deflection as a hard gate.
   *  0 = unknown per-shot damage → never deflected. */
  alpha: number;
  power: number;
}

export interface ShipData {
  uuid: string;
  name: string;
  displayName: string;
  manufacturer: string;
  career: string | null;
  role: string | null;
  sizeClass: 'snub' | 'small' | 'medium' | 'large' | 'capital' | 'special' | 'unknown';
  image: string;
  health: number;
  armor: number;
  /** Per-shot damage thresholds: attacks from weapons with alpha below the defender's
   *  deflection for that damage type deal no damage while the defender has armor. */
  armorDeflection: Record<DamageType, number>;
  shield: {
    hp: number;
    regenPerSec: number;
    faceType: string;
    reconfigurationCooldown: number;
    absorption: Record<DamageType, Range>;
    resistance: Record<DamageType, Range>;
  };
  weapons: Weapon[];
  turretCount: number;
  /** Sensor emissions from the wiki API; IR signature drives decoy evasion math. */
  emission: { ir: number };
  /** Ship-launched ordnance from the hardpoint tree + standard-loadout warload. */
  missiles: {
    /** Largest MISSILE size fired (from the rack's ammo size, not the hardpoint);
     *  >= 5 (or a rack named "Torpedo") classifies the warload as torpedoes. */
    size: number;
    /** Total warload (1 missile fired per round until dry; torpedoes every 2). */
    ammo: number;
    /** Explosion damage per missile (physical; bleeds through shields). */
    perShot: number;
    torpedo: boolean;
  };
  /** Decoy launchers in the hardpoint tree; 0 = no missile defense. */
  countermeasures: { decoys: number };
  powerSegments: number;
  weaponPool: number;
  shieldPool: number;
  powerUsedShields: number;
  crossSection: { length: number; width: number; height: number };
  speed: { scm: number | null; max: number | null };
  mass: number;
  crew: { min: number; max: number };
}

export interface ShipConfig {
  ship: ShipData;
  mannedTurrets: number;
  powerToWeapons: number;
  powerToShields: number;
}

export interface BattleConfig {
  seed: number;
}

export interface DerivedStats {
  fixedDps: number;
  turretDps: number;
  weaponDps: number;
  powerDemand: number;
  dpsScale: number;
  shieldRegen: number;
  /** DPS-weighted share of each damage type in the attacker's output. */
  damageMix: Record<DamageType, number>;
}

export type Phase = 'shield' | 'armor' | 'hull';

export interface ShipRoundState {
  shieldBefore: number;
  shieldAfter: number;
  armorBefore: number;
  armorAfter: number;
  hullBefore: number;
  hullAfter: number;
  dpsApplied: number;
  phase: Phase;
  shieldBrokenAtRound: number | null;
  shieldActive: boolean;
  events: string[];
}

export interface Round {
  index: number;
  a: ShipRoundState;
  b: ShipRoundState;
}

export interface BattleSummary {
  winner: 'a' | 'b' | 'draw';
  winnerName: string | null;
  totalRounds: number;
  seed: number;
  sides: Record<'a' | 'b', SideSummary>;
}

export interface SideSummary {
  shipName: string;
  totalDamageDealt: number;
  damageByType: Record<DamageType, number>;
  missilesFired: number;
  missilesEvaded: number;
  missilesHit: number;
  shieldDownRounds: number;
  firstShieldBreakRound: number | null;
  hullPctAtEnd: number;
  derived: DerivedStats;
}

export interface BattleResult {
  winner: 'a' | 'b' | 'draw';
  rounds: Round[];
  summary: BattleSummary;
}
