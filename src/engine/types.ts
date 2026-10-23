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
  /** Ammunition load in shots (W4). `null` = infinite: energy lasers draw ship power, and
   *  alpha-0 guns (unknown fire rate) never deplete. Ballistic guns get a size-class
   *  heuristic from `GUN_AMMO_BY_SIZE` (API has no ammo fields, probe GC2). */
  ammo: number | null;
}

/** Per-resource pip band: `minOnline` = lowest pip count that keeps the
 *  component online, `fullDraw` = draw at full allocation (pips). Raw API usage
 *  can be FRACTIONAL (e.g. 2.1); the engine bills whole segments via
 *  `pipCost` = ceil (round-up rule, 2026-10-23). Nested per
 *  resource (power/coolant) so a future heat model slots in without renaming (T17). */
export interface ShipResourceRange {
  minOnline: number;
  fullDraw: number;
}

/** One equipped item on a ship (ports-tree traversal order). Power fields come from
 *  the item cache join (plan-power-components T17/T18); `coolant` is reserved for
 *  the future heat model, `generation` carries PowerPlant/Cooler output. */
export interface ShipComponent {
  type: string;
  name: string;
  className: string;
  size: number | null;
  grade: number | null;
  /** null = component has no power draw data. */
  power: ShipResourceRange | null;
  coolant: ShipResourceRange | null;
  generation: { power: number | null; coolant: number | null };
}

/** One gun model on a turret hardpoint (T24). `dps` is summed across the mount's
 *  repeated entries of this gun, `alpha` is the max per-gun alpha, `count` the
 *  number of guns, `size` from the API entry-level `weapon_sizes` array aligned to
 *  `weapons[]` (name `S<n>` token fallback, null when neither yields). */
export interface TurretMountWeapon {
  name: string;
  size: number | null;
  dps: number;
  alpha: number;
  count: number;
}

/** Weapons loaded on one turret hardpoint (T23, display-only). Built from the API
 *  `turrets.manned/remote/pdc[i].weapons[]`; `className` is the join key = the
 *  ports-tree Turret/TurretBase component `className`. No engine use —
 *  power for every turret rides in the aggregate guns pool. */
export interface TurretMount {
  /** API entry label (`display_name ?? class_name`) — machine-grade ("port_NameTurret04",
   *  "PDT 1"); the UI shows the component name as the heading and this as context. */
  mount: string;
  className: string;
  kind: 'manned' | 'remote' | 'pdc';
  weapons: TurretMountWeapon[];
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
  /** Per-shot damage thresholds: attacks from weapons with alpha at or below the defender's
   *  deflection for that damage type deal no damage while the defender has armor. */
  armorDeflection: Record<DamageType, number>;
  /** Per-damage-type armor damage multipliers (armor.damage_multipliers, ~0.65–1.0):
   *  armor HP is consumed at dmg × mult; the structural hull takes raw damage. */
  armorMultipliers: Record<DamageType, number>;
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
  /** Per-mount weapons (T23 join, display-only). May be absent on un-migrated
   *  snapshots — the UI degrades to the plain guns-pool row list. */
  turretMounts?: TurretMount[];
  /** Sensor emissions from the wiki API; IR signature drives decoy evasion math. */
  emission: { ir: number };
  /** Ship-launched ordnance from the hardpoint tree + standard-loadout warload. */
  missiles: {
    /** Largest MISSILE size fired (from the rack's ammo size, not the hardpoint);
     *  >= 5 (or a rack named "Torpedo") classifies the warload as torpedoes. */
    size: number;
    /** Total warload (1 missile fired per round until dry; torpedoes every 2). */
    ammo: number;
    /** Explosion damage per missile (bleeds through shields). */
    perShot: number;
    torpedo: boolean;
    /** Blast damage type: 'distortion' for quantum racks (Polaris S6 quantum torpedoes),
     *  else 'physical'. Quantum blasts bypass the armor deflection gate entirely (O1) and
     *  the distortion armor/shield profile applies. */
    damageType: DamageType;
  };
  /** Decoy launchers in the hardpoint tree; 0 = no missile defense. */
  countermeasures: { decoys: number };
  powerSegments: number;
  weaponPool: number;
  /** Σ shield-component `fullDraw` — the ship builder derives it (T18); the W5
   *  `power_pools.Shield` meaning (pool size + over-pool bonus) is retired. */
  shieldPool: number;
  /** Equipped-component records (T18 join). May be absent on un-migrated snapshots —
   *  engine code must treat missing as `[]` (legacy degradation). */
  components?: ShipComponent[];
  /** Aggregate fixed-gun draw = API `used_segments_grouped.WeaponGun` (fractional),
   *  joined by the builder (T18); manned-turret/PDC draw rides in the weapons pool
   *  via `gunDrawFull`. */
  gunDraw?: number;
  /** Σ shield-component `minOnline` over ALL shield components — the ALL-ON shield
   *  power floor (0 = no shield data). The per-Shield toggle (2026-10-23) derives the
   *  effective floor from the ON set (`shieldFloorOn` in power.ts) — generators
   *  switched off drop out of it — enforced by the UI slider bounds, NOT by the
   *  engine. */
  shieldMin?: number;
  /** Count of PDC turret ports; PDC draw (`pdcCount × TURRET_POWER_PIPS`) enters
   *  the weapons pool while the PDC toggle is on (declared heuristic, plan T17). */
  pdcCount?: number;
  crossSection: { length: number; width: number; height: number };
  speed: { scm: number | null; max: number | null };
  mass: number;
  crew: { min: number; max: number };
}

export interface ShipConfig {
  ship: ShipData;
  mannedTurrets: number;
  /** Gun pips 0..weaponPool; gun draw scales with the pip fraction. */
  powerToWeapons: number;
  /** Shield pips; legal UI range is `shieldFloorOn..shieldCapOn` of the ON shield
   *  set (per-Shield toggles, 2026-10-23), 0 = shields off (the engine enforces no
   *  floor). */
  powerToShields: number;
  /** Allocated pips per `ship.components[]` index (0..fullDraw). Missing =
   *  every component at its minOnline. */
  allocs?: number[];
  /** PDC on/off: on draws `pdcCount × TURRET_POWER_PIPS` into the weapons pool. */
  pdcOn?: boolean;
  /** Per-Shield-component on/off, index-parallel to `ship.components[]` (non-Shield
   *  entries ignored; short array = missing entries are on; missing = all shields
   *  on). An OFF generator frees its minOnline pips from the shield floor, its
   *  fullDraw share from the slider cap, and its share of shield strength — a ship
   *  can run 0 shields (floor 0, cap 0, factor 0). */
  shieldOns?: boolean[];
}

export interface BattleConfig {
  seed: number;
}

export interface DerivedStats {
  fixedDps: number;
  turretDps: number;
  weaponDps: number;
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
  /** Number of weapons whose ammunition ran dry (W4). */
  gunsDryRounds: number;
  hullPctAtEnd: number;
  derived: DerivedStats;
}

export interface BattleResult {
  winner: 'a' | 'b' | 'draw';
  rounds: Round[];
  summary: BattleSummary;
}
