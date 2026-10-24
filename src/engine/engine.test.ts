import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUN_AMMO_BY_SIZE, GUN_AMMO_SIZE_DEFAULT, MISSILE_FUMBLE, TURRET_POWER_PIPS, WEAPONS_POOL_COMPONENT_TYPES, allocatedPower, armorRatioOf, crewTurretCap, decoyEvadeChance, decoyStockFor, defaultAllocOf, defaultAllocation, derivedStats, fullDrawOf, gatedLoadout, gunAmmoInfo, gunCostAt, gunDrawFull, isOverdrawn, isPoweredByDefault, isSystemComponent, minGunPipsFull, minOnlineOf, missileSizeFor, MISSILE_TORPEDO_MIN_SIZE, mulberry32, netPower, ordnanceKindLabel, pipCost, powerNotes, requiredDecoysFor, shieldCapOn, shieldFloorOn, shieldOnsOf, shieldStrengthFactor, simulate, systemReserve } from './index';
import type { ShipComponent, ShipConfig, ShipData } from './types';
import { DAMAGE_TYPES } from './types';
import { TURRET_COMPONENT_TYPES, fixedGunPairings, turretMountMatcher } from '../components/turretMounts';
import { normalizeKnobs } from '../App';

const ships = JSON.parse(readFileSync(new URL('../../data/ships.json', import.meta.url), 'utf8')) as ShipData[];

function findShip(name: string): ShipData {
  const s = ships.find((x) => x.name === name);
  if (!s) throw new Error(`ship ${name} not in snapshot`);
  return s;
}

function fullConfig(ship: ShipData): ShipConfig {
  return { ship, mannedTurrets: ship.turretCount, powerToWeapons: ship.weaponPool, powerToShields: ship.shieldPool, allocs: [], pdcOn: true };
}

const fullAbsorption = Object.fromEntries(DAMAGE_TYPES.map((t) => [t, { min: 1, max: 1 }]));
const zeroResistance = Object.fromEntries(DAMAGE_TYPES.map((t) => [t, { min: 0, max: 0 }]));

function syn(name: string, opts: {
  health: number;
  armor: number;
  shield: number;
  regen: number;
  fixedDps: number;
  turretDps?: number;
  turretCount?: number;
  alpha?: number;
  deflectPhys?: number;
  deflectEnergy?: number;
  physAbsorb?: number;
  ir?: number;
  missileAmmo?: number;
  missileDmg?: number;
  torpedo?: boolean;
  missileDamageType?: 'physical' | 'distortion';
  decoyLaunchers?: number;
  armorMultPhys?: number;
  crewMax?: number;
  powerSegments?: number;
  gunDraw?: number;
  pdcCount?: number;
  components?: ShipComponent[];
  gunAmmo?: number | null;
  turretAmmo?: number | null;
}): ShipData {
  const turretCount = opts.turretCount ?? 0;
  const alpha = opts.alpha ?? 1000;
  const weapons = [
    ...(opts.fixedDps > 0 ? [{ name: `${name} gun`, type: 'fixed' as const, damageType: 'physical' as const, dps: opts.fixedDps, alpha, power: 1, ammo: opts.gunAmmo ?? null }] : []),
    ...Array.from({ length: turretCount }, (_, i) => ({
      name: `${name} turret ${i + 1}`, type: 'turret' as const, damageType: 'physical' as const,
      dps: (opts.turretDps ?? 0), alpha, power: 1, ammo: opts.turretAmmo ?? null,
    })),
  ];
  return {
    uuid: name, name, displayName: name, manufacturer: 'Test', career: 'Combat', role: 'Test',
    sizeClass: 'small', image: '',
    health: opts.health, armor: opts.armor,
    armorDeflection: {
      physical: opts.deflectPhys ?? 0, energy: opts.deflectEnergy ?? 0,
      distortion: 0, thermal: 0, biochemical: 0, stun: 0,
    },
    armorMultipliers: {
      physical: opts.armorMultPhys ?? 1, energy: 1,
      distortion: 1, thermal: 1, biochemical: 1, stun: 1,
    },
    shield: {
      hp: opts.shield, regenPerSec: opts.regen, faceType: 'Bubble', reconfigurationCooldown: 5,
      absorption: { ...(fullAbsorption as ShipData['shield']['absorption']), physical: { min: opts.physAbsorb ?? 1, max: opts.physAbsorb ?? 1 } },
      resistance: zeroResistance as ShipData['shield']['resistance'],
    },
    weapons,
    turretCount,
    emission: { ir: opts.ir ?? 0 },
    missiles: {
      size: opts.torpedo ? 5 : 3,
      ammo: opts.missileAmmo ?? 0,
      perShot: opts.missileDmg ?? 0,
      torpedo: opts.torpedo ?? false,
      damageType: opts.missileDamageType ?? 'physical',
    },
    countermeasures: { decoys: opts.decoyLaunchers ?? 0 },
    powerSegments: opts.powerSegments ?? 20, weaponPool: 20, shieldPool: 4,
    components: opts.components ?? [], gunDraw: opts.gunDraw ?? 0, shieldMin: 0, pdcCount: opts.pdcCount ?? 0,
    crossSection: { length: 1, width: 1, height: 1 },
    speed: { scm: 200, max: 1000 }, mass: 1000, crew: { min: 1, max: opts.crewMax ?? 1 },
  };
}

describe('golden battles', () => {
  it('Hammerhead vs Gladius: armor gate zeroes the small guns, Hammerhead wins (seed 42)', () => {
    const result = simulate(fullConfig(findShip('Hammerhead')), fullConfig(findShip('Gladius')), 42);
    expect(result.winner).toBe('a');
    // Gladius's guns are gated to zero; only its (small) missile warload lands any damage.
    expect(result.summary.sides.b.totalDamageDealt).toBeLessThan(result.summary.sides.a.totalDamageDealt / 4);
    expect(result.rounds[0].a.events.some((e) => e.includes('Armor deflects'))).toBe(true);
    expect(result.summary.totalRounds).toBeLessThanOrEqual(80);
  });

  it('Stalker ballistic melts Gladius armor straight through its shield (seed 42)', () => {
    const result = simulate(fullConfig(findShip('Avenger Stalker')), fullConfig(findShip('Gladius')), 42);
    const r1 = result.rounds[0];
    // ~77.5% of physical phases through the Gladius shield (factor = mid(absorption) 0.225,
    // S5 review 2026-10-22): armor stripped round 1 and the hull overflows too.
    // GOLDEN REGENERATED 2026-10-22 (T19): Stalker dpsScale is the pool fraction
    // (powerToWeapons/weaponPool = 1 at full pips, was 0.8 under the DPS/500 demand
    // heuristic) — +25% damage leaves the Gladius shield nearly collapsed (~866/6336).
    expect(r1.b.armorAfter).toBe(0);
    expect(r1.b.shieldAfter).toBeGreaterThan(0);
    expect(r1.b.shieldAfter).toBeLessThan(r1.b.shieldBefore * 0.2);
    expect(r1.b.hullAfter).toBeLessThan(0);
    // Gladius's return fire melts the glass-cannon Stalker the same round → mutual destruction.
    expect(result.winner).toBe('draw');
    expect(result.summary.totalRounds).toBe(1);
  });

  it('500 dps vs 2000 hp rig kills in ~2-3 rounds', () => {
    const attacker = syn('Attacker', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const defender = syn('Defender', { health: 2000, armor: 1000, shield: 2000, regen: 0, fixedDps: 0 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      7,
    );
    // No flat deflection anymore: 500 dps * 10s = 5000/round vs 2000 shield + 1000 armor +
    // 2000 hull = 5000 effective; round 1 eats everything, round 2 lands the kill.
    expect(result.winner).toBe('a');
    expect(result.summary.totalRounds).toBeLessThanOrEqual(3);
  });

  it('500 dps vs big-hull rig lands in 4-6 round window', () => {
    const attacker = syn('Attacker', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const defender = syn('Defender', { health: 13000, armor: 3000, shield: 2000, regen: 0, fixedDps: 0 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      7,
    );
    expect(result.winner).toBe('a');
    expect(result.summary.totalRounds).toBeGreaterThanOrEqual(4);
    expect(result.summary.totalRounds).toBeLessThanOrEqual(6);
  });

  it('0 turrets loses to max turrets on time (monotonicity)', () => {
    const mk = (manned: number): ShipConfig => ({
      ship: syn('TurretShip', { health: 20000, armor: 0, shield: 0, regen: 0, fixedDps: 0, turretDps: 500, turretCount: 2 }),
      mannedTurrets: manned, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true,
    });
    const passive: ShipConfig = {
      ship: syn('Target', { health: 9000, armor: 0, shield: 0, regen: 0, fixedDps: 100 }),
      mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true,
    };
    const zero = simulate(mk(0), passive, 3);
    const max = simulate(mk(2), passive, 3);
    expect(max.winner).toBe('a');
    expect(zero.winner).toBe('b');
    expect(max.summary.totalRounds).toBeLessThan(zero.summary.totalRounds);
  });

  it('under-powered weapons reduce derived DPS (gun-pip fraction of the pool, T19)', () => {
    const ship = syn('PowerTest', { health: 1000, armor: 0, shield: 0, regen: 0, fixedDps: 2000 });
    const full = derivedStats({ ship, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true });
    const half = derivedStats({ ship, mannedTurrets: 0, powerToWeapons: 10, powerToShields: 4, allocs: [], pdcOn: true });
    const over = derivedStats({ ship, mannedTurrets: 0, powerToWeapons: 25, powerToShields: 4, allocs: [], pdcOn: true });
    const emptyPool = { ...ship, weaponPool: 0 } as ShipData;
    expect(full.dpsScale).toBe(1);
    expect(half.dpsScale).toBeCloseTo(0.5);
    expect(over.dpsScale).toBe(1); // pips above the pool saturate at full DPS
    expect(half.weaponDps).toBeCloseTo(full.weaponDps * 0.5);
    expect(derivedStats({ ship: emptyPool, mannedTurrets: 0, powerToWeapons: 0, powerToShields: 4, allocs: [], pdcOn: true }).dpsScale).toBe(0);
    const unarmedEmpty = { ...emptyPool, weapons: [], turretCount: 0 } as ShipData;
    expect(derivedStats({ ship: unarmedEmpty, mannedTurrets: 0, powerToWeapons: 0, powerToShields: 4, allocs: [], pdcOn: true }).dpsScale).toBe(1);
  });

  it('same seed replays identically', () => {
    const a = fullConfig(findShip('Avenger Stalker'));
    const b = fullConfig(findShip('Gladius'));
    const r1 = simulate(a, b, 1337);
    const r2 = simulate(a, b, 1337);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('different seeds can diverge', () => {
    const a = fullConfig(findShip('Avenger Stalker'));
    const b = fullConfig(findShip('Gladius'));
    const r1 = JSON.stringify(simulate(a, b, 1));
    const r2 = JSON.stringify(simulate(a, b, 2));
    expect(r1).not.toBe(r2);
  });
});

/** Component power-allocation model (plan-power-components T19) — replaces the W5
 *  baseline/pip-scarcity describe. */
function comp(type: string, minOnline: number, fullDraw: number | null): ShipComponent {
  return {
    type, name: `${type} Mk I`, className: `test.${type}`, size: null, grade: null,
    power: fullDraw === null ? null : { minOnline, fullDraw },
    coolant: null,
    generation: { power: null, coolant: null },
  };
}

function toConfig(ship: ShipData, a: { allocs: number[]; gunPips: number; shieldPips: number; pdcOn: boolean }): ShipConfig {
  return { ship, mannedTurrets: 0, powerToWeapons: a.gunPips, powerToShields: a.shieldPips, allocs: a.allocs, pdcOn: a.pdcOn };
}

describe('component power allocation (T19)', () => {
  it('fullDrawOf / minOnlineOf: null-power components draw 0', () => {
    expect(fullDrawOf(comp('Shield', 2, 5))).toBe(5);
    expect(minOnlineOf(comp('Shield', 2, 5))).toBe(2);
    expect(fullDrawOf(comp('QuantumDrive', 3, null))).toBe(0);
    expect(minOnlineOf(comp('QuantumDrive', 3, null))).toBe(0);
  });

  it('RULE-R: systemReserve counts ONLY system components, clamped per component', () => {
    const ship = syn('Sys', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0,
      components: [comp('Shield', 2, 4), comp('Radar', 1, 2), comp('Cooler', 0, 3), comp('Module', 0, null)],
    });
    expect(isSystemComponent(comp('Shield', 0, 1))).toBe(false);
    expect(isSystemComponent(comp('PowerPlant', 0, 1))).toBe(false);
    expect(isSystemComponent(comp('WeaponGun', 0, 1))).toBe(false);
    expect(isSystemComponent(comp('Radar', 0, 1))).toBe(true);
    // Shield entry (index 0) is always treated as 0; the rest clamp to [0, fullDraw]
    expect(systemReserve(ship, [3, 9, 7, 5])).toBe(2 + 3 + 0);
    expect(systemReserve(ship, [0, -4, 1, 0])).toBe(0 + 1 + 0);
    expect(systemReserve(ship, [])).toBe(0); // explicit zero-allocation
    expect(systemReserve(ship, undefined)).toBe(1 + 0 + 0); // systems Σ minOnline (Shield excluded)
    const legacy = { ...ship } as ShipData;
    delete legacy.components;
    expect(systemReserve(legacy, undefined)).toBe(0);
  });

  it('QDrive/jump modules are unpowered by default (app simulates the non-quantum SCF/NAV state, 2026-10-23)', () => {
    expect(isPoweredByDefault(comp('QuantumDrive', 3, 5))).toBe(false);
    expect(isPoweredByDefault(comp('Radar', 1, 2))).toBe(true);
    expect(isPoweredByDefault(comp('Shield', 1, 2))).toBe(false);
    expect(defaultAllocOf(comp('QuantumDrive', 3, 5))).toBe(0);
    expect(defaultAllocOf(comp('Radar', 3, 5))).toBe(3);
    expect(defaultAllocOf(comp('Shield', 3, 5))).toBe(0);
    // WEAPONS_POOL_COMPONENT_TYPES = NON_SYSTEM minus PowerPlant and Shield
    expect([...WEAPONS_POOL_COMPONENT_TYPES].sort().join(',')).toBe('BombLauncher,MissileLauncher,Turret,TurretBase,UtilityTurret,WeaponDefensive,WeaponGun');
    expect(WEAPONS_POOL_COMPONENT_TYPES.has('Shield')).toBe(false);
    expect(WEAPONS_POOL_COMPONENT_TYPES.has('PowerPlant')).toBe(false);
    const ship = syn('QD', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0,
      components: [comp('Shield', 2, 4), comp('QuantumDrive', 3, 5), comp('Radar', 1, 2)],
    });
    const a = defaultAllocation(ship);
    expect(a.allocs).toEqual([0, 0, 1]); // QDrive ships at 0
    expect(systemReserve(ship, undefined)).toBe(1); // legacy non-array reserve excludes QDrive
    expect(systemReserve(ship, [])).toBe(0);
    // with-array path unchanged: a user-picked QDrive allocation still counts (clamped)
    expect(systemReserve(ship, [0, 5, 2])).toBe(5 + 2);
  });

  it('allocatedPower: systems reserve + shield pips + pool-fraction gun draw (PDC on/off)', () => {
    const ship = syn('Alloc', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, gunDraw: 6,
      components: [comp('Shield', 2, 4), comp('Radar', 1, 1), comp('Module', 0, null)],
    });
    const withPdc = { ...ship, pdcCount: 2 } as ShipData;
    expect(gunDrawFull(ship, true)).toBe(6);
    expect(gunDrawFull(withPdc, true)).toBe(6 + 2 * TURRET_POWER_PIPS);
    expect(gunDrawFull(withPdc, false)).toBe(6);
    // reserve [3,9,7] → Shield 0 + Radar min(9,1) 1 + Module 0 = 1; gunPips 10 of pool 20 → 6×0.5 = 3; shields 2 → 6
    expect(allocatedPower(ship, [3, 9, 7], 10, 2, true)).toBe(6);
    // pdc on, full pips: 1 + 0 + 8×1 = 9; gun pips above the pool clamp to fraction 1
    expect(allocatedPower(withPdc, [3, 9, 7], 20, 0, true)).toBe(9);
    expect(allocatedPower(ship, [3, 9, 7], 25, 2, true)).toBe(1 + 2 + 6);
    expect(allocatedPower(ship, [3, 9, 7], 0, 2, true)).toBe(1 + 2 + 0);
    const legacy = { ...ship } as ShipData;
    delete legacy.components; delete legacy.gunDraw; delete legacy.pdcCount;
    expect(allocatedPower(legacy, undefined, 20, 4, true)).toBe(0 + 4 + 0); // un-migrated: no draws
  });

  it('pipCost (round-up rule, 2026-10-23): fractional usage bills whole segments', () => {
    // RSI Ship Owner's Guide (Comm-Link 20263): power is allocated in segments;
    // 0.1-minOnline BEHR gatling "displays as combined power segments" = 1.
    expect(pipCost(0)).toBe(0);
    expect(pipCost(1)).toBe(1);
    expect(pipCost(2.1)).toBe(3);
    expect(pipCost(0.1)).toBe(1);
    expect(pipCost(2.93)).toBe(3);
    expect(pipCost(4.8)).toBe(5);
    expect(pipCost(-0.5)).toBe(-0);
  });

  it('pipCost billing flows into defaultAllocOf, systemReserve (both paths), and powerNotes capacity', () => {
    // Fractional system draws (synthetic — the real fleet keeps the fractions in
    // WeaponGun, which rides the guns pool): minOnline 0.1 bills 1, 1.13 bills 2,
    // 2.1 bills 3; default allocation = pipCost(minOnline).
    const ship = syn('Frac', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0,
      components: [comp('Shield', 2, 4), comp('Radar', 1.13, 4.8), comp('Cooler', 0.1, 2)],
    });
    expect(defaultAllocOf(comp('Radar', 1.13, 4.8))).toBe(2);
    expect(defaultAllocOf(comp('Cooler', 0.1, 2))).toBe(1);
    expect(systemReserve(ship, undefined)).toBe(2 + 1); // legacy path: Σ pipCost(minOnline), Shield excluded
    expect(systemReserve(ship, [9, 3, 0])).toBe(pipCost(3) + pipCost(0)); // with-array: Σ pipCost(clamp(alloc))
    expect(systemReserve(ship, [9, 4.8, 2])).toBe(pipCost(4.8) + 2); // clamp first: 4.8 ≤ 4.8 bills 5, 2 ≤ 2 bills 2
    expect(systemReserve(ship, [0, -1, 0.5])).toBe(pipCost(0) + pipCost(0.5)); // 0 + 1
    // powerNotes capacity = Σ pipCost(fullDraw) over systems (4.8 → 5, 2 → 2)
    const notes = powerNotes({ ship, mannedTurrets: 0, powerToWeapons: 0, powerToShields: 0, allocs: [0, 0, 0], pdcOn: true });
    expect(notes.find((n) => n.kind === 'systems-reserve')?.text).toBe('systems draw 0 of 7 pips (whole-pip billing)');
  });

  it('pipCost on the guns pool: fractional gunDraw bills ceil at full power and at the pip fraction', () => {
    // 147/228 real ships carry fractional gunDraw (API used_segments_grouped.WeaponGun).
    const ship = syn('GunFrac', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, gunDraw: 2.1,
      components: [comp('Shield', 2, 4)],
    });
    expect(gunDrawFull(ship, true)).toBe(2.1); // RAW usage for display (PDC × 0)
    expect(gunCostAt(ship, ship.weaponPool, true)).toBe(3); // full power: 2.1 → 3
    expect(gunCostAt(ship, ship.weaponPool / 2, true)).toBe(Math.ceil(2.1 * 0.5)); // 1.05 → 2
    expect(gunCostAt(ship, 1, true)).toBe(Math.ceil(2.1 * (1 / ship.weaponPool)));
    expect(gunCostAt(ship, 0, true)).toBe(0); // guns off frees the pool completely
    expect(allocatedPower(ship, [], ship.weaponPool, 0, true)).toBe(3);
    expect(allocatedPower(ship, [], 0, 0, true)).toBe(0);
    expect(allocatedPower(ship, [], ship.weaponPool, 2, true)).toBe(5);
  });

  it('netPower / isOverdrawn', () => {
    const ship = syn('Net', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, powerSegments: 10, gunDraw: 6,
      components: [comp('Shield', 2, 4)], // RULE-R: shield component rides the slider, not the reserve
    });
    const fit = { ship, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 2, allocs: [2], pdcOn: true };
    expect(netPower(ship, fit)).toBe(10 - (0 + 2 + 6));
    expect(isOverdrawn(ship, fit)).toBe(false);
    const over = { ...fit, powerToShields: 6 };
    expect(netPower(ship, over)).toBe(-2);
    expect(isOverdrawn(ship, over)).toBe(true);
  });

  it('defaultAllocation: systems at minOnline, shields at the all-ON FLOOR, guns at the MINIMUM POWERED pips, PDC on', () => {
    const ship = syn('Def', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, gunDraw: 5,
      components: [comp('Shield', 2, 4), comp('Radar', 1, 2), comp('Cooler', 2, 6)],
    });
    // reserve 1+2 = 3 + shields floor 2 + guns: full cost ceil(5) = 5, smallest p with
    // ceil(5·p/20) == 5 is p = 17 → 3 + 2 + 5 = 10 ≤ 20
    const a = defaultAllocation(ship);
    expect(a.allocs).toEqual([0, 1, 2]); // allocs stay index-parallel to ship.components
    expect(a.pdcOn).toBe(true);
    expect(a.gunPips).toBe(17); // not the pool: 17 pips power the 5-pip draw fully
    expect(a.shieldPips).toBe(2); // floor (Σ pipCost minOnline), all generators ON
    expect(netPower(ship, toConfig(ship, a))).toBe(20 - 10);
  });

  it('overdraw defaults: ladder drops PDC OFF first, then guns to 0; shields STAY at the floor', () => {
    const ship = syn('Tight', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, powerSegments: 6, gunDraw: 3, pdcCount: 2,
      components: [comp('Shield', 2, 4)],
    });
    // opening 0 + 2 + ceil((3+2)·p/20 at full cost 5 → 5) = 7 > 6 → PDC OFF →
    // 0 + 2 + ceil(3·17/20) = 5, net 1: guns keep their (redrawn) minimum powered
    // pips, shields stay at the floor.
    const a = defaultAllocation(ship);
    expect(a.pdcOn).toBe(false);
    expect(a.gunPips).toBe(17); // min pips for the full draw at PDC-on (kept after the drop)
    expect(a.shieldPips).toBe(2);
    expect(netPower(ship, toConfig(ship, a))).toBe(1);
    // PDC-off is not enough → guns → 0; shields stay at floor.
    const tight = { ...ship, powerSegments: 4 } as ShipData;
    const b = defaultAllocation(tight);
    expect(b.pdcOn).toBe(false);
    expect(b.gunPips).toBe(0);
    expect(b.shieldPips).toBe(2);
    expect(netPower(tight, toConfig(tight, b))).toBe(2);
  });

  it('minGunPipsFull: full gun draw at the fewest pips (fractional draws land mid-ladder)', () => {
    const gunAt = (draw: number, pool: number, pdc = 0) => minGunPipsFull({
      ...syn('G', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, gunDraw: draw }), weaponPool: pool, pdcCount: pdc,
    } as ShipData);
    expect(gunAt(0, 4)).toBe(0); // zero draw = zero pips
    expect(gunAt(5, 20)).toBe(17); // ceil(5·p/20) == 5 from p = 17
    expect(gunAt(2.93, 3)).toBe(3); // 2.93 occupies 3 at any full-power p
    expect(gunAt(3.1, 8)).toBe(8); // ceil(3.1·p/8) == 4 needs p > 7.74 → pool
    expect(gunAt(1, 20, 4)).toBe(17); // PDC counts into the full draw (1+4 = 5)
  });

  it('residual overdraw: systems are never forced below minOnline — net stays negative for the UI', () => {
    const ship = { ...syn('Deep', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, powerSegments: 3, gunDraw: 8,
      components: [comp('Shield', 2, 4), comp('Radar', 2, 4)],
    }), shieldMin: 2 };
    const b = defaultAllocation(ship);
    expect(b.allocs).toEqual([0, 2]); // system never below minOnline
    expect(b.gunPips).toBe(0);
    expect(b.shieldPips).toBe(2); // shields at floor
    expect(netPower(ship, toConfig(ship, b))).toBe(3 - (2 + 2)); // residual overdraw
    expect(isOverdrawn(ship, toConfig(ship, b))).toBe(true);
  });

  it('shield regen = regenPerSec × (allocated / shieldPool); 0 = shields off; over-pool saturates', () => {
    const ship = syn('Regen', { health: 1000, armor: 0, shield: 1000, regen: 100, fixedDps: 0 });
    const at = (pips: number) => derivedStats({ ship, mannedTurrets: 0, powerToWeapons: 0, powerToShields: pips, allocs: [], pdcOn: true });
    expect(at(4).shieldRegen).toBe(100); // pool 4, full allocation
    expect(at(2).shieldRegen).toBeCloseTo(50);
    expect(at(0).shieldRegen).toBe(0);
    expect(at(9).shieldRegen).toBe(100); // over-pool bonus model retired
    const noPool = { ...ship, shieldPool: 0 } as ShipData;
    expect(derivedStats({ ship: noPool, mannedTurrets: 0, powerToWeapons: 0, powerToShields: 2, allocs: [], pdcOn: true }).shieldRegen).toBe(0);
  });

  it('the shield floor is a UI bound, not an engine clamp: 0 (shields off) simulates', () => {
    const ship = { ...syn('Floor', { health: 90000, armor: 0, shield: 1000, regen: 100, fixedDps: 0 }), shieldMin: 4, shieldPool: 4 };
    const cfg: ShipConfig = { ship, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 0, allocs: [], pdcOn: true };
    expect(derivedStats(cfg).shieldRegen).toBe(0);
    const target = syn('Target', { health: 90000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const result = simulate(cfg, fullConfig(target), 5);
    expect(result.rounds[0].a.shieldBefore).toBe(1000);
    expect(result.rounds[0].a.shieldAfter).toBeLessThan(1000); // took damage, regenerated nothing
  });

  it('powerNotes: overdraw, gun fraction, systems reserve, PDC draw, shields floor/off', () => {
    const ship = { ...syn('Notes', {
      health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 1000, powerSegments: 4, gunDraw: 6,
      components: [comp('Shield', 2, 4), comp('Radar', 1, 2)],
    }), shieldMin: 2, pdcCount: 2 };
    const kinds = (cfg: ShipConfig) => powerNotes(cfg).map((n) => n.kind);
    const over: ShipConfig = { ship, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [2, 1], pdcOn: true };
    // RULE-R reserve = Radar only min(1,2) = 1; 1 + shields 4 + guns (6+2)×1 = 13 > 4 →
    // overdrawn; guns full (scale 1) → no under-powered note.
    expect(kinds(over)).toEqual(['systems-reserve', 'pdc-draw', 'overdrawn']);
    const half: ShipConfig = { ...over, powerToWeapons: 10, powerToShields: 1, allocs: [0, 0], pdcOn: false };
    // scale 10/20 = 0.5 → under-powered-guns; shields 1 ≤ floor 2 → shields-at-floor;
    // allocated 0 + 1 + 6×0.5 = 4 → net 0, no overdraw note.
    expect(kinds(half)).toEqual(['systems-reserve', 'under-powered-guns', 'shields-at-floor']);
    const off: ShipConfig = { ...half, powerToWeapons: 20, powerToShields: 0 };
    // off: gunDraw 6 at full pips (pdc off) with generation 4 → net −2, overdrawn.
    expect(kinds(off)).toEqual(['systems-reserve', 'shields-off', 'overdrawn']);
    const legacy: ShipData = { ...syn('Legacy', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 1000 }) };
    delete legacy.components; delete legacy.pdcCount; delete legacy.shieldMin; delete legacy.gunDraw;
    expect(powerNotes({ ship: legacy, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 2, allocs: [], pdcOn: true })).toEqual([]);
  });

  describe('per-Shield floor at the App trust boundary (App.tsx normalizeKnobs)', () => {
    const twin = () => ({ ...syn('TwinShield', {
      health: 50000, armor: 0, shield: 2000, regen: 200, fixedDps: 0,
      components: [comp('Shield', 4, 5), comp('Shield', 4, 5)],
    }), shieldPool: 10, shieldMin: 8 }) as ShipData;

    it('toggle-off collapses s with the cap; toggle-back-on re-floors s (never a sub-floor 0)', () => {
      const ship = twin();
      const on = normalizeKnobs(ship, { uuid: ship.uuid });
      expect(on.s).toBe(8); // default: all-ON floor (Σ minOnline, whole pips)
      const off = normalizeKnobs(ship, { uuid: ship.uuid, s: on.s, shieldOns: [false, false] });
      expect(off.s).toBe(0); // all off → cap 0 → s 0 (shields down)
      const back = normalizeKnobs(ship, { uuid: ship.uuid, s: off.s, shieldOns: [true, false] });
      expect(back.s).toBe(4); // ON-set floor restored — the stale sub-floor 0 is clamped up
      expect(back.s).toBeGreaterThanOrEqual(shieldFloorOn(ship, back.shieldOns));
    });

    it('overpool links re-fit the reduced cap; all-off links stay at 0', () => {
      const ship = twin();
      expect(normalizeKnobs(ship, { uuid: ship.uuid, s: 10, shieldOns: [true, false] }).s).toBe(4);
      expect(normalizeKnobs(ship, { uuid: ship.uuid, s: 10, shieldOns: [false, false] }).s).toBe(0);
    });
  });

  describe('shared missile-size source (scripts/build-data.mjs == UI classifier, src/engine/missile-size.mjs)', () => {
    it('torpedo threshold + the API naming-convention classifier', () => {
      expect(MISSILE_TORPEDO_MIN_SIZE).toBe(5);
      expect(missileSizeFor({ className: 'MRCK_S06_X_Sabre_Firebird_S03', name: 'Rack', size: 6 })).toBe(3);
      expect(missileSizeFor({ className: 'MRCK_S06_AEGS_TorpedoRack', name: 'Rack' })).toBe(6);
      expect(missileSizeFor({ className: '', name: '12xS3 Missile Rack' })).toBe(3);
      expect(missileSizeFor({ className: '', name: 'Quad S5 Torpedo Rack' })).toBe(5);
      expect(missileSizeFor({ className: '', name: 'MSD-543 Missile Rack' })).toBe(3);
      expect(missileSizeFor({ className: '', name: 'Rack', size: 4 })).toBe(4);
      expect(missileSizeFor({})).toBe(0);
      expect(missileSizeFor({ size: null })).toBe(0);
      expect(missileSizeFor({ className: '', name: 'Rack', size: 6 }) >= MISSILE_TORPEDO_MIN_SIZE).toBe(true);
    });
  });

  it('legacy ships (un-migrated: no components/gunDraw/shieldMin/pdcCount, no allocs/pdcOn) simulate at full weapons + pool shields, net ≥ 0', () => {
    const base = syn('Legacy', { health: 50000, armor: 1000, shield: 2000, regen: 50, fixedDps: 500 });
    const legacy = { ...base } as ShipData;
    delete legacy.components; delete legacy.gunDraw; delete legacy.shieldMin; delete legacy.pdcCount;
    const cfg = fullConfig(legacy);
    expect(netPower(legacy, cfg)).toBeGreaterThanOrEqual(0);
    expect(netPower(legacy, cfg)).toBe(legacy.powerSegments - legacy.shieldPool); // reserve 0, gunDraw absent → 0
    const d = derivedStats(cfg);
    expect(d.dpsScale).toBe(1);
    expect(d.shieldRegen).toBeCloseTo(legacy.shield.regenPerSec);
    const target = syn('Target', { health: 900000, armor: 0, shield: 0, regen: 0, fixedDps: 0 });
    const result = simulate(cfg, fullConfig(target), 7);
    expect(result.summary.sides.a.derived.dpsScale).toBe(1);
    expect(result.rounds[0].b.hullBefore - result.rounds[0].b.hullAfter).toBeGreaterThan(0); // fires at full power
    const a = defaultAllocation(legacy);
    expect(a.allocs).toEqual([]);
    // Defaults on a component-less snapshot: no shield components → floor 0; no
    // gunDraw → full cost 0 → 0 pips. The ship opens minimal and fightable.
    expect(a.gunPips).toBe(0);
    expect(a.shieldPips).toBe(0);
    expect(isOverdrawn(legacy, toConfig(legacy, a))).toBe(false);
  });

  const systemMinSum = (s: ShipData) => (s.components ?? []).reduce((t, c) => t + defaultAllocOf(c), 0);

  it('RULE-R real fleet: free power = generation − Σ default system allocations is ≥ 6 on every ship (min 6, p50 12)', () => {
    const frees = ships.map((s) => s.powerSegments - systemMinSum(s));
    for (const s of ships) expect(s.powerSegments - systemMinSum(s)).toBeGreaterThanOrEqual(6);
    const sorted = [...frees].sort((a, b) => a - b);
    const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
    console.log(`RULE-R fleet (${ships.length} ships): free min ${sorted[0]}, p25 ${sorted[Math.floor(0.25 * (sorted.length - 1))]}, p50 ${median}, p90 ${sorted[Math.floor(0.9 * (sorted.length - 1))]}`);
    // recomputed 2026-10-23: QDrive/jump unpowered (non-NAV state) frees ~2–5 minOnline per ship
    expect(sorted[0]).toBe(6);
    expect(median).toBe(12);
  });

  it('RULE-R real fleet: defaultAllocation reaches net ≥ 0 on ≥ 220/228 ships; only ships whose min achievable net < 0 stay red', () => {
    let atFull = 0;
    let clamped = 0;
    let guns0ShieldsMaxRed = 0;
    const red = new Map<string, number>(); // ship name → clamped-ladder net (integer: gen − ΣminOnline − shieldMin)
    for (const s of ships) {
      const allocs = (s.components ?? []).map(defaultAllocOf);
      if (netPower(s, toConfig(s, { allocs, gunPips: s.weaponPool, shieldPips: s.shieldPool, pdcOn: true })) >= 0) atFull++;
      if (netPower(s, toConfig(s, { allocs, gunPips: 0, shieldPips: s.shieldPool, pdcOn: true })) >= 0) guns0ShieldsMaxRed++;
      const a = defaultAllocation(s);
      const net = netPower(s, toConfig(s, a));
      if (net >= 0) clamped++;
      else red.set(s.name, net);
      // Red only for ships where even guns-0 + shields-floor + systems-at-defaults can't fit:
      const minNet = s.powerSegments - systemMinSum(s) - (s.shieldMin ?? 0);
      expect(net < 0).toBe(minNet < 0);
    }
    console.log(`RULE-R defaults net≥0: shields-max/guns-full ${atFull}/${ships.length}; guns-0/shields-max ${guns0ShieldsMaxRed}/${ships.length}; engine clamped ladder ${clamped}/${ships.length}; red ${red.size}: ${[...red].map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ')}`);
    // recomputed 2026-10-23: QDrive/jump unpowered (non-NAV state) — was 101/228 raw,
    // 206 guns-0, 221 ladder, 7 red (Caterpillar×2, Ironclad×2, Prowler, MISC Hull B, Zeus);
    // freed QDrive draw → 184 raw, 220 guns-0, 224 ladder, exactly the 4 red ships asserted
    // by exact name + net (data-notes RULE-R, L8 review 2026-10-23).
    expect(atFull).toBe(184);
    expect(guns0ShieldsMaxRed).toBe(220);
    expect(clamped).toBe(224); // engine ladder (guns→0, then shields→floor) fits 224
    expect(red.size).toBe(4);
    expect([...red.keys()].sort()).toEqual(['Ironclad', 'Ironclad Assault', 'MISC Hull B', 'Prowler Utility Wikelo Work Special']);
    expect(red.get('Ironclad')).toBe(-1);
    expect(red.get('Ironclad Assault')).toBe(-1);
    expect(red.get('Prowler Utility Wikelo Work Special')).toBe(-3);
    expect(red.get('MISC Hull B')).toBe(-2);
  });
});

describe('turret crew cap (W3, annotation only)', () => {
  it('crew.max minus the pilot seat; floor at 0', () => {
    const crew = (max: number) => syn(`C${max}`, { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, crewMax: max, turretCount: 3 });
    expect(crewTurretCap(crew(1))).toBe(0);
    expect(crewTurretCap(crew(2))).toBe(1);
    expect(crewTurretCap(crew(9))).toBe(8);
    expect(crewTurretCap(crew(0))).toBe(0);
  });

  it('no enforcement: a config above the cap still fires the full turret complement', () => {
    const ship = syn('SixTurret', { health: 9000, armor: 0, shield: 0, regen: 0, fixedDps: 0, turretDps: 500, turretCount: 6, crewMax: 2 });
    const d = derivedStats({ ship, mannedTurrets: 6, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true });
    expect(crewTurretCap(ship)).toBe(1); // crew legally allows 1 manned
    expect(d.turretDps).toBeCloseTo(3000); // 6×500 all firing — annotation, not a clamp
  });

  it('the current fleet hardpoint count respects the crew cap (W3 latent)', () => {
    for (const s of ships) expect(s.turretCount).toBeLessThanOrEqual(crewTurretCap(s));
  });
});

describe('armor deflection gate', () => {
  it('weapons below the gate deal zero damage while armor holds', () => {
    const attacker = syn('Weak', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 100 });
    const defender = syn('Armored', { health: 9000, armor: 500, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    );
    expect(result.winner).toBe('draw');
    expect(result.summary.totalRounds).toBe(100);
    expect(result.summary.sides.a.totalDamageDealt).toBe(0);
    expect(result.rounds.every((rd) => rd.b.armorAfter === 500 && rd.b.hullAfter === 9000)).toBe(true);
    expect(result.rounds.every((rd) => rd.b.events.some((e) => e.includes('Armor deflects')))).toBe(true);
  });

  it('gate-deflected energy repeaters keep grinding the shield pool — shields are never gated (Centaurus vs 600i class)', () => {
    const repeater = { name: 'Energy repeater', type: 'fixed' as const, damageType: 'energy' as const, dps: 1200, alpha: 100, power: 1, ammo: null };
    const attacker: ShipData = { ...syn('RepeaterBoat', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0 }), weapons: [repeater] };
    const defender = syn('ArmoredYacht', { health: 90000, armor: 5000, shield: 20000, regen: 0, fixedDps: 0, deflectEnergy: 500 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 11);
    const r1 = result.rounds[0];
    // Energy absorption {1,1}: every shot is deflected by the 500E gate against armor, yet
    // the FULL 12000·va keeps grinding shields (gate applies after shields, structure-only).
    expect(r1.b.shieldBefore - r1.b.shieldAfter).toBeGreaterThan(10000);
    expect(r1.b.armorAfter).toBe(5000);
    expect(r1.b.hullAfter).toBe(90000);
    expect(r1.b.events.some((e) => e.includes('Armor deflects'))).toBe(true);
    expect(result.summary.sides.a.totalDamageDealt).toBeGreaterThan(0);
    // Once the shields fall, the deflected share evaporates on the intact gate: no armor loss.
    const broken = result.rounds.find((rd) => rd.b.events.some((e) => e.includes('Shields broken')))!;
    const after = result.rounds[result.rounds.length - 1];
    expect(after.b.armorBefore).toBe(broken.b.armorAfter);
    expect(after.b.armorAfter).toBe(5000);
  });

  it('gate-deflected ballistics bleed only the shield-absorption share; armor takes nothing while the gate stands', () => {
    const attacker = syn('Autocannon', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 4000, alpha: 100 });
    const defender = syn('Fortress', { health: 90000, armor: 1000, shield: 20000, regen: 0, fixedDps: 0, deflectPhys: 500, physAbsorb: 0.25 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 5);
    const r1 = result.rounds[0];
    // 40000·va incoming: the 0.25 mid-absorption hits shields, the 77.5 % phase-through
    // share is gate-blocked — armor untouched, hull untouched.
    const shieldLoss = r1.b.shieldBefore - r1.b.shieldAfter;
    expect(shieldLoss).toBeGreaterThan(8000);
    expect(shieldLoss).toBeLessThan(12000);
    expect(r1.b.armorAfter).toBe(1000);
    expect(r1.b.hullAfter).toBe(90000);
  });

  it('weapons above the gate strip armor and overflow carries to hull', () => {
    const attacker = syn('Strong', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 600 });
    const defender = syn('Armored', { health: 13000, armor: 1000, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    );
    const r1 = result.rounds[0];
    expect(r1.b.armorBefore).toBe(1000);
    expect(r1.b.armorAfter).toBe(0);
    // seed 5 round-1 variance ≈ 1.057 → 5285 dmg: 1000 armor + 4285 hull
    expect(r1.b.hullAfter).toBeCloseTo(13000 - 4285, 0);
    expect(result.winner).toBe('a');
  });

  it('deflected weapons resume fire once the armor is gone', () => {
    const base = syn('Heavy', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 900, alpha: 600 });
    const weak = { name: 'Weak gun', type: 'fixed' as const, damageType: 'physical' as const, dps: 400, alpha: 100, power: 1, ammo: null };
    const attacker: ShipData = { ...base, weapons: [...base.weapons, weak] };
    const defender = syn('Armored', { health: 30000, armor: 1000, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      9,
    );
    expect(result.rounds[0].b.armorAfter).toBe(0);
    // seed 9 round-2 variance ≈ 1.105: heavy+weak = 13000 dps-round*va ≈ 14365 hull damage;
    // heavy alone (9000 * va) tops out at 10350, so > 10500 proves the weak gun resumed.
    const r2 = result.rounds[1];
    expect(r2.b.hullBefore - r2.b.hullAfter).toBeGreaterThan(10500);
  });

  it('alpha exactly at the gate is deflected; one point above lands (game deflects ≤)', () => {
    const atGate = simulate(
      { ship: syn('Edge', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 500 }), mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: syn('Armored', { health: 9000, armor: 500, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 }), mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    );
    expect(atGate.summary.sides.a.totalDamageDealt).toBe(0);
    const overGate = simulate(
      { ship: syn('Edge', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 501 }), mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: syn('Armored', { health: 9000, armor: 500, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 }), mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    );
    expect(overGate.rounds[0].b.armorAfter).toBe(0);
  });

  it('snapshot data carries deflection gates and alpha, sentinels normalized', () => {
    for (const s of ships) {
      for (const t of DAMAGE_TYPES) expect(s.armorDeflection[t]).toBeLessThan(1e6);
      for (const w of s.weapons) expect(w.alpha).toBeGreaterThanOrEqual(0);
      expect(s.emission).toBeDefined();
      expect(s.missiles).toBeDefined();
      expect(s.countermeasures).toBeDefined();
    }
    const hammer = findShip('Hammerhead');
    expect(hammer.armorDeflection.physical).toBeGreaterThan(500);
    expect(hammer.weapons.every((w) => w.alpha < hammer.armorDeflection.physical)).toBe(true);
    const stalker = findShip('Avenger Stalker');
    expect(stalker.missiles.ammo).toBe(4);
    expect(stalker.missiles.perShot).toBeGreaterThan(1000);
    expect(stalker.countermeasures.decoys).toBeGreaterThan(0);
  });
});

describe('missiles bypass the armor deflection gate (O1)', () => {
  it('a missile lands on a ship whose gate dwarfs the blast (no gate, no dud)', () => {
    const attacker = syn('Armed', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 1, missileDmg: 1000 });
    const defender = syn('Fortress', { health: 20000, armor: 3000, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 200000, ir: 4000 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 5);
    const r1 = result.rounds[0];
    // seed 5 round-1 va ≈ 1.057 → 1057 blast straight onto armor despite the 200k gate.
    expect(r1.b.armorBefore - r1.b.armorAfter).toBeGreaterThan(500);
    expect(r1.b.events.some((e) => e.includes('harmlessly'))).toBe(false);
    expect(r1.b.events.some((e) => e.includes('Missile impact:'))).toBe(true);
  });
});

describe('armor integrity degrades the gate (A1)', () => {
  it('a marginal weapon resumes fire as the armor pool depletes, before armor is gone', () => {
    const base = syn('Shooter', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 600 });
    const weak = { name: 'Weak gun', type: 'fixed' as const, damageType: 'physical' as const, dps: 400, alpha: 300, power: 1, ammo: null };
    const attacker: ShipData = { ...base, weapons: [...base.weapons, weak] };
    const defender = syn('Armored', { health: 100000, armor: 6000, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    );
    const r1 = result.rounds[0];
    // Round 1 (full armor, gate 500): heavy (alpha 600) lands, weak (300) deflected.
    expect(r1.b.events.some((e) => e.includes('Armor deflects Weak gun'))).toBe(true);
    expect(r1.b.armorAfter).toBeGreaterThan(600);
    expect(r1.b.armorAfter).toBeLessThan(800);
    const r2 = result.rounds[1];
    // Round 2 (armor ≈ 12% → effective gate ≈ 60): weak resumes while armor still holds,
    // stripping the remainder and overkill-hitting the hull; heavy alone caps at ~5035.
    expect(r2.b.armorBefore).toBeGreaterThan(0);
    expect(r2.b.events.some((e) => e.includes('Armor deflects'))).toBe(false);
    expect(r2.b.armorAfter).toBe(0);
    expect(r2.b.hullBefore - r2.b.hullAfter).toBeGreaterThan(6000);
  });

  it('a below-gate alpha weapon still fires once the armor pool is destroyed (gate → 0)', () => {
    const base = syn('Shooter', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 600 });
    const weak = { name: 'Weak gun', type: 'fixed' as const, damageType: 'physical' as const, dps: 400, alpha: 300, power: 1, ammo: null };
    const attacker: ShipData = { ...base, weapons: [...base.weapons, weak] };
    const defender = syn('Armored', { health: 30000, armor: 1000, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      9,
    );
    expect(result.rounds[0].b.armorAfter).toBe(0);
    const r2 = result.rounds[1];
    // heavy + weak = 9000·va ≥ 7650 hull; heavy alone (5000·va) tops out at 5750.
    expect(r2.b.hullBefore - r2.b.hullAfter).toBeGreaterThan(6000);
  });
});

describe('armor damage multipliers (A4)', () => {
  it('physical 0.5 multiplier halves armor HP consumption; hull takes raw damage', () => {
    const attacker = syn('Strong', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 600 });
    const mk = (multPhys: number, armor: number): ShipData =>
      syn('Resistant', { health: 100000, armor, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 0, armorMultPhys: multPhys });
    const half = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: mk(0.5, 3000), mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    ).rounds[0];
    // seed 5 va ≈ 1.057 → 5285 raw: armor eats 2642 (×0.5, survives with ≈358), hull takes 5285 − 2642 raw.
    expect(half.b.armorBefore - half.b.armorAfter).toBeCloseTo(2642, 0);
    expect(half.b.hullBefore - half.b.hullAfter).toBeCloseTo(2642, 0);
    const full = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: mk(1, 1000), mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    ).rounds[0];
    expect(full.b.hullBefore - full.b.hullAfter).toBeCloseTo(4285, 0);
  });

  it('snapshot armor multipliers are normalized positive', () => {
    for (const s of ships) {
      for (const t of DAMAGE_TYPES) {
        expect(s.armorMultipliers[t]).toBeGreaterThan(0);
        expect(s.armorMultipliers[t]).toBeLessThan(1.5);
      }
    }
  });
});

describe('quantum torpedoes (O3)', () => {
  it('distortion blast is fully absorbed by shields — grinds the pool, armor untouched', () => {
    const attacker = syn('Polaris-like', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 4, missileDmg: 1000, torpedo: true, missileDamageType: 'distortion' });
    const defender = syn('LeakyShield', { health: 20000, armor: 3000, shield: 2000, regen: 0, fixedDps: 0, physAbsorb: 0, ir: 4000 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 5);
    const r1 = result.rounds[0];
    // seed 5 va ≈ 1.057 → 1057 distortion: full shield absorption, zero structure damage.
    expect(r1.a.events.some((e) => e.includes('Quantum torpedo fired'))).toBe(true);
    expect(r1.b.shieldAfter).toBeCloseTo(2000 - 1057, 0);
    expect(r1.b.armorAfter).toBe(3000);
    expect(r1.b.events.some((e) => e.includes('fully absorbed by shields'))).toBe(true);
    // Control: the same physical torpedo bleeds straight past the zero-absorption shield.
    const phys = syn('TorpShip', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 4, missileDmg: 1000, torpedo: true });
    const resultP = simulate(fullConfig(phys), fullConfig(defender), 5);
    expect(resultP.rounds[0].b.shieldAfter).toBe(2000);
    expect(resultP.rounds[0].b.armorAfter).toBeLessThan(3000);
  });

  it('Polaris warload is tagged distortion; normal warloads stay physical', () => {
    const polaris = findShip('Polaris');
    expect(polaris.missiles.damageType).toBe('distortion');
    expect(polaris.missiles.torpedo).toBe(true);
    expect(polaris.missiles.ammo).toBe(56);
    expect(polaris.missiles.perShot).toBeGreaterThan(100000);
    for (const name of ['Avenger Stalker', 'Gladius', 'Hammerhead']) {
      expect(findShip(name).missiles.damageType).toBe('physical');
    }
    const quantumShips = ships.filter((s) => s.missiles.damageType === 'distortion');
    expect(quantumShips.map((s) => s.name)).toContain('Polaris');
  });
});

describe('shield absorption leak', () => {  it('ballistic against zero physical absorption phases through shields onto armor/hull', () => {
    const attacker = syn('Ballistic', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const defender = syn('Leaky', { health: 9000, armor: 1000, shield: 2000, regen: 0, fixedDps: 0, physAbsorb: 0 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    );
    const r1 = result.rounds[0];
    // seed 5 round-1 variance ≈ 1.057 → 5285 dmg: shield untouched, 1000 armor + 4285 hull
    expect(r1.b.shieldAfter).toBe(2000);
    expect(r1.b.armorAfter).toBe(0);
    expect(r1.b.hullAfter).toBeCloseTo(9000 - 4285, 0);
    expect(result.winner).toBe('a');
  });

  it('full absorption keeps all damage on shields (no leak)', () => {
    const attacker = syn('Ballistic', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const defender = syn('Absorbing', { health: 9000, armor: 1000, shield: 20000, regen: 0, fixedDps: 0, physAbsorb: 1 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4, allocs: [], pdcOn: true },
      5,
    );
    expect(result.rounds[0].b.armorAfter).toBe(1000);
    expect(result.rounds[0].b.hullAfter).toBe(9000);
    expect(result.rounds[0].b.shieldAfter).toBeLessThan(20000);
  });
});

describe('bomb-rack exclusion (O4)', () => {
  type RawPort = { equipped_item?: { type?: string }; ports?: RawPort[] };
  const treePath = new URL('../../probe/out/vehicles-all.json', import.meta.url);
  const probePresent = existsSync(treePath);
  if (!probePresent) console.info('[fleet-audit] probe/out cache absent — bomb-rack probe cross-check skipped (run `npm run probe` to enable)');
  const raw = probePresent
    ? (JSON.parse(readFileSync(treePath, 'utf8')) as { uuid: string; ports?: RawPort[] }[])
    : null;
  const countType = (ports: RawPort[] | undefined, type: string): number =>
    (ports ?? []).reduce((n, p) => n + (p.equipped_item?.type === type ? 1 : 0) + countType(p.ports, type), 0);

  it('BombLauncher-only ships carry zero missile ammo (bomb ports display-name as "Missile Rack")', () => {
    // Probe GC4 (2026-10-22): bomb racks are hardpoint type BombLauncher on A1 Spirit,
    // A2 Hercules Starlifter, A2 Hercules Starlifter Wikelo War Special. The Starlifter
    // variants have zero MissileLauncher ports, so nothing may enter ShipData.missiles.
    for (const name of ['A2 Hercules Starlifter', 'A2 Hercules Starlifter Wikelo War Special']) {
      const s = findShip(name);
      expect(s.missiles.ammo).toBe(0);
      if (raw) {
        const r = raw.find((x) => x.uuid === s.uuid);
        expect(r).toBeDefined();
        expect(countType(r!.ports, 'BombLauncher')).toBeGreaterThan(0);
        expect(countType(r!.ports, 'MissileLauncher')).toBe(0);
      }
    }
  });

  // CI (fresh clone, probe/out gitignored): skipIf reports the cross-check as skipped,
  // never a vacuous pass on `if (!raw) return`.
  it.skipIf(!probePresent)('every snapshot warload derives only from MissileLauncher ports (probe cross-check)', () => {
    const byUuid = new Map(raw!.map((x) => [x.uuid, x]));
    for (const s of ships) {
      const r = byUuid.get(s.uuid);
      if (!r) continue;
      const racks = countType(r.ports, 'MissileLauncher');
      if (s.missiles.ammo > 0) expect(racks, `${s.name}: ammo with zero MissileLauncher ports`).toBeGreaterThan(0);
      if (racks === 0) expect(s.missiles.ammo, `${s.name}: ammo derived from non-missile ports`).toBe(0);
    }
  });
});

/** Find seeds whose (skips+1)-th draw lands below / above the evade threshold. For a
 *  round-1 missile evade roll that is draws 3 (va, vb) + 1, i.e. skips=2. */
function pickSeeds(skips: number): { evadeSeed: number; fumbleSeed: number } {
  const p = 1 - MISSILE_FUMBLE;
  let evadeSeed = -1;
  let fumbleSeed = -1;
  for (let s = 1; s < 1000 && (evadeSeed < 0 || fumbleSeed < 0); s++) {
    const r = mulberry32(s);
    for (let i = 0; i < skips; i++) r();
    const roll = r();
    if (roll < p && evadeSeed < 0) evadeSeed = s;
    if (roll >= p && fumbleSeed < 0) fumbleSeed = s;
  }
  return { evadeSeed, fumbleSeed };
}

/** Find a seed where the round-1 AND round-2 missile evade rolls (draws 3 and 6: each
 *  round spends va, vb, then the missile roll) both land in the fumble band. */
function fumblePairSeed(): number {
  const p = 1 - MISSILE_FUMBLE;
  for (let s = 1; s < 10000; s++) {
    const r = mulberry32(s);
    r(); r();
    const first = r();
    r(); r();
    const second = r();
    if (first >= p && second >= p) return s;
  }
  throw new Error('no double-fumble seed below 10000');
}

describe('ordnance & countermeasures', () => {
  it('formula: required decoys = ceil(IR / decoy strength); torpedoes count decoys double', () => {
    const s = syn('IR5k', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, ir: 5000 });
    expect(requiredDecoysFor(s, false)).toBe(5);
    expect(requiredDecoysFor(s, true)).toBe(3);
    const zero = syn('IR0', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0 });
    expect(requiredDecoysFor(zero, false)).toBe(1);
  });

  it('decoy stock scales with launchers; evade chance math matches the model', () => {
    const s = syn('CM', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, decoyLaunchers: 2 });
    expect(decoyStockFor(s)).toBe(30);
    expect(decoyStockFor(syn('NoCM', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0 }))).toBe(0);
    expect(decoyEvadeChance(0, 5)).toBe(0);
    expect(decoyEvadeChance(10, 5)).toBeCloseTo(1 - MISSILE_FUMBLE);
    expect(decoyEvadeChance(3, 5)).toBeCloseTo((1 - MISSILE_FUMBLE) * 0.6);
  });

  it('no countermeasures: every missile hits (blast through shields)', () => {
    const attacker = syn('Armed', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 3, missileDmg: 1000 });
    const defender = syn('Bare', { health: 20000, armor: 0, shield: 10000, regen: 0, fixedDps: 0, ir: 5000, physAbsorb: 1 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 3);
    expect(result.summary.sides.a.missilesFired).toBe(3);
    expect(result.summary.sides.a.missilesEvaded).toBe(0);
    expect(result.summary.sides.a.missilesHit).toBe(3);
    const dealt = result.summary.sides.a.totalDamageDealt;
    expect(dealt).toBeGreaterThan(2700);
    expect(dealt).toBeLessThan(3450);
  });

  it('sufficient decoys pull the seeker (evade seed), stock drains by the requirement', () => {
    const attacker = syn('Armed', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 1, missileDmg: 1000 });
    const defender = syn('Flaring', { health: 20000, armor: 0, shield: 10000, regen: 0, fixedDps: 0, ir: 5000, decoyLaunchers: 1, physAbsorb: 1 });
    const { evadeSeed } = pickSeeds(2);
    const result = simulate(fullConfig(attacker), fullConfig(defender), evadeSeed);
    expect(result.summary.sides.a.missilesFired).toBe(1);
    expect(result.summary.sides.a.missilesEvaded).toBe(1);
    expect(result.summary.sides.a.missilesHit).toBe(0);
    expect(result.summary.sides.a.totalDamageDealt).toBe(0);
    expect(result.rounds[0].b.events.some((e) => e.includes('evaded: 5 decoy'))).toBe(true);
  });

  it('pilot fumble: one missile slips through a sufficient barrage on the fumble seed', () => {
    const attacker = syn('Armed', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 1, missileDmg: 1000 });
    const defender = syn('Flaring', { health: 20000, armor: 0, shield: 10000, regen: 0, fixedDps: 0, ir: 5000, decoyLaunchers: 1, physAbsorb: 1 });
    const { fumbleSeed } = pickSeeds(2);
    const result = simulate(fullConfig(attacker), fullConfig(defender), fumbleSeed);
    expect(result.summary.sides.a.missilesEvaded).toBe(0);
    expect(result.summary.sides.a.missilesHit).toBe(1);
    expect(result.summary.sides.a.totalDamageDealt).toBeGreaterThan(0);
    expect(result.rounds[0].b.events.some((e) => e.includes('slipped through'))).toBe(true);
  });

  it('torpedoes fire every 2 rounds', () => {
    const attacker = syn('TorpShip', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 4, missileDmg: 100, torpedo: true });
    const defender = syn('Big', { health: 90000, armor: 0, shield: 0, regen: 0, fixedDps: 0, ir: 5000 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 11);
    expect(result.summary.sides.a.missilesFired).toBe(4);
    expect(result.rounds[0].a.events.some((e) => e.includes('Torpedo fired'))).toBe(true);
    expect(result.rounds[1].a.events.some((e) => e.includes('Torpedo fired'))).toBe(false);
    expect(result.rounds[2].a.events.some((e) => e.includes('Torpedo fired'))).toBe(true);
  });

  it('missile blast bleeds through a zero-absorption shield straight onto armor', () => {
    const attacker = syn('Armed', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 1, missileDmg: 1000 });
    const defender = syn('LeakyShield', { health: 20000, armor: 3000, shield: 10000, regen: 0, fixedDps: 0, physAbsorb: 0, ir: 4000 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 5);
    const r1 = result.rounds[0];
    // seed 5 round-1 va ≈ 1.057 → 1057 blast: zero physical absorption → full bleed onto
    // armor with the shield untouched (the researched AoE shield bleed-through).
    expect(r1.b.shieldAfter).toBe(10000);
    expect(r1.b.armorBefore - r1.b.armorAfter).toBeCloseTo(1057, 0);
    expect(r1.b.events.some((e) => e.includes('100% bleeds past shields'))).toBe(true);
  });

  it('real warloads: Stalker fires missiles at Gladius', () => {
    const result = simulate(fullConfig(findShip('Avenger Stalker')), fullConfig(findShip('Gladius')), 42);
    expect(result.summary.sides.a.missilesFired).toBeGreaterThan(0);
    expect(result.summary.sides.a.missilesFired + result.summary.sides.a.missilesEvaded + result.summary.sides.a.missilesHit)
      .toBeGreaterThanOrEqual(result.summary.sides.a.missilesFired);
  });

  it('per-missile decoys: an impact burns only the committed charges and the stock attrs across salvos (C3/C4)', () => {
    // small ship: 1 launcher × 15 stock; IR 5000 ⇒ 5 required/missile.
    const mk = (): [ShipConfig, ShipConfig] => [
      fullConfig(syn('Armed', { health: 900000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 3, missileDmg: 100 })),
      fullConfig(syn('Flaring', { health: 20000, armor: 0, shield: 10000, regen: 0, fixedDps: 0, ir: 5000, decoyLaunchers: 1, physAbsorb: 1 })),
    ];
    // Old C4 behavior: a hit burned the ENTIRE stock, so after two impacts (and two
    // fumble rolls) the third missile landed unopposed. C3: each impact burns only the
    // 5 charges committed against it — after two fumble hits the defender must still
    // face the full barrage (90% evade), so the old outcome cannot recur on this seed.
    const [attacker, defender] = mk();
    const result = simulate(attacker, defender, fumblePairSeed());
    expect(result.summary.sides.a.missilesFired).toBe(3);
    expect(result.summary.sides.a.missilesHit).toBeGreaterThanOrEqual(2);
    expect(result.summary.sides.a.missilesHit + result.summary.sides.a.missilesEvaded).toBe(3);
    expect(result.rounds[0].b.events.some((e) => e.includes('slipped through 5 decoy(s) (pilot fumble, 10 left)'))).toBe(true);
    expect(result.rounds[1].b.events.some((e) => e.includes('slipped through 5 decoy(s) (pilot fumble, 5 left)'))).toBe(true);
    // Third missile: only 5 charges remain (committed 5 ⇒ "left" reads 0 on any outcome;
    // the old all-stock-burn bug would have produced "no countermeasures" here instead).
    expect(result.rounds[2].b.events.some((e) => e.includes('(0 left)'))).toBe(true);
    expect(result.rounds[2].b.events.some((e) => e.includes('no countermeasures'))).toBe(false);
    expect(result.rounds[2].b.events.some((e) => e.includes('Decoy stock exhausted'))).toBe(true);
  });

  it('determinism: per-missile decoy RNG replays identically for the same seed', () => {
    const attacker = fullConfig(syn('Armed', { health: 900000, armor: 0, shield: 0, regen: 0, fixedDps: 0, missileAmmo: 5, missileDmg: 100 }));
    const defender = fullConfig(syn('Flaring', { health: 20000, armor: 0, shield: 10000, regen: 0, fixedDps: 0, ir: 5000, decoyLaunchers: 1, physAbsorb: 1 }));
    expect(JSON.stringify(simulate(attacker, defender, 77))).toBe(JSON.stringify(simulate(attacker, defender, 77)));
  });
});

describe('gun ammo depletion (W4)', () => {
  it('fire rate = dps/alpha; shots/round is the rounded burst floored at 1; null ammo is infinite', () => {
    const w = (dps: number, alpha: number, ammo: number | null) =>
      ({ name: 'w', type: 'fixed' as const, damageType: 'physical' as const, dps, alpha, power: 1, ammo });
    expect(gunAmmoInfo(w(500, 100, 250), 10)).toEqual({ perRound: 50, rounds: 5 });
    expect(gunAmmoInfo(w(200, 5000, 300), 10)).toEqual({ perRound: 1, rounds: 300 }); // railgun: 0.4/round floored to 1
    expect(gunAmmoInfo(w(1150, 43.7, null), 10)).toEqual({ perRound: 0, rounds: null }); // energy: infinite
  });

  it('ballistic gun runs dry at the expected round and goes silent after', () => {
    // 500 dps / alpha 100 ⇒ 50 shots/round; 250 shots ⇒ last magazine round 5, silent from 6.
    const attacker = syn('Ballistic', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 100, gunAmmo: 250 });
    const defender = syn('Target', { health: 900000, armor: 0, shield: 0, regen: 0, fixedDps: 0 });
    const result = simulate(fullConfig(attacker), fullConfig(defender), 5);
    expect(result.rounds[4].a.events.some((e) => e.includes('ammunition depleted at round 5'))).toBe(true);
    expect(result.rounds[4].b.dpsApplied).toBeGreaterThan(0);
    expect(result.rounds[5].b.dpsApplied).toBe(0);
    expect(result.rounds[5].b.hullAfter).toBe(result.rounds[5].b.hullBefore);
    expect(result.summary.sides.a.gunsDryRounds).toBe(1);
  });

  it('dry weapons are excluded from the gated loadout fired count and mix', () => {
    const base = syn('TwoGun', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 600, alpha: 600 });
    const dryGun = { name: 'Dry gun', type: 'fixed' as const, damageType: 'physical' as const, dps: 400, alpha: 100, power: 1, ammo: 100 };
    const ship: ShipData = { ...base, weapons: [...base.weapons, dryGun] };
    const def = syn('Target', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0 });
    const cfg = { ship, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true };
    expect(gatedLoadout(cfg, def, def.armor, 1).fired).toBe(2);
    const dry = gatedLoadout(cfg, def, def.armor, 1, [Number.POSITIVE_INFINITY, 0]);
    expect(dry.fired).toBe(1);
    expect(dry.dps).toBeCloseTo(600);
  });

  it('gatedLoadout firedIndices covers fired and deflected weapons, excludes dry and zero-dps (Finding 2)', () => {
    const base = syn('Shooter', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 600, alpha: 600 });
    const weak = { name: 'Weak gun', type: 'fixed' as const, damageType: 'physical' as const, dps: 400, alpha: 100, power: 1, ammo: null };
    const zero = { name: 'Zero gun', type: 'fixed' as const, damageType: 'physical' as const, dps: 0, alpha: 100, power: 1, ammo: null };
    const ship: ShipData = { ...base, weapons: [...base.weapons, weak, zero] };
    const def = syn('Armored', { health: 1, armor: 500, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const cfg = { ship, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4, allocs: [], pdcOn: true };
    const full = gatedLoadout(cfg, def, def.armor, 1);
    expect(full.fired).toBe(2);
    expect(full.firedIndices).toEqual([0, 1]); // heavy fires; weak is deflected (the shot left the barrel, spends ammo); 0-dps gun never fires
    const dry = gatedLoadout(cfg, def, def.armor, 1, [Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY]);
    expect(dry.firedIndices).toEqual([0]); // dry weak gun (index 1) and 0-dps gun (index 2) are both excluded
  });

  it('unpowered guns (powerToWeapons 0) fire nothing: zero damage, no depletion events, gunsDryRounds 0 (Finding 2)', () => {
    // 500 dps / alpha 100 ⇒ 50 shots/round of 250 ⇒ this gun WOULD run dry at round 5 if it
    // fired. With 0 weapon pips every weapon's scaled dps is 0 (the gatedLoadout predicate),
    // so it never fires and must not spend ammunition (accepted ~217/228-ship dominant state).
    const attacker = syn('Unpowered', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 100, gunAmmo: 250 });
    const defender = syn('Target', { health: 900000, armor: 0, shield: 0, regen: 0, fixedDps: 0 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 0, powerToShields: 0, allocs: [], pdcOn: true },
      fullConfig(defender),
      5,
    );
    expect(result.summary.sides.a.totalDamageDealt).toBe(0);
    expect(result.summary.sides.a.gunsDryRounds).toBe(0);
    for (const rd of result.rounds) {
      expect(rd.b.dpsApplied).toBe(0);
      expect(rd.a.events.some((e) => e.includes('ammunition depleted'))).toBe(false);
    }
  });

  it('energy and alpha-0 guns never deplete', () => {
    const laser = syn('Laser', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 43.7 });
    const pulse = syn('Pulse', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 0 });
    const defender = syn('Target', { health: 1000000000, armor: 0, shield: 0, regen: 0, fixedDps: 0 });
    for (const gun of [laser, pulse]) {
      const result = simulate(fullConfig(gun), fullConfig(defender), 4);
      expect(result.summary.totalRounds).toBe(100);
      expect(result.summary.sides.a.gunsDryRounds).toBe(0);
      expect(result.rounds[99].b.dpsApplied).toBeGreaterThan(0);
    }
  });

  it('snapshot ammo follows the heuristic and mirrors the build-data table exactly', () => {
    for (const s of ships) {
      for (const w of s.weapons) {
        if (w.damageType !== 'physical' || w.alpha <= 0) {
          expect(w.ammo, `${s.name}/${w.name}: infinite expected`).toBeNull();
          continue;
        }
        const token = w.name.match(/\bS(\d)\b/i);
        const expected = GUN_AMMO_BY_SIZE[token ? Number(token[1]) : GUN_AMMO_SIZE_DEFAULT]
          ?? GUN_AMMO_BY_SIZE[GUN_AMMO_SIZE_DEFAULT];
        expect(w.ammo, `${s.name}/${w.name}`).toBe(expected);
      }
    }
  });
});

describe('shared engine helpers (Findings 8/9)', () => {
  it('armorRatioOf: 0 without an armor pool, floored at 0, unclamped above 1 (identical to the inlined expression)', () => {
    expect(armorRatioOf(1000, 500)).toBe(0.5);
    expect(armorRatioOf(1000, 0)).toBe(0);
    expect(armorRatioOf(1000, -50)).toBe(0);
    expect(armorRatioOf(0, 0)).toBe(0); // no armor pool: gate lifted
    expect(armorRatioOf(1000, 1500)).toBe(1.5); // not clamped above 1 — semantics preserved
  });

  it('ordnanceKindLabel: quantum/torpedo/missile warloads get the canonical event labels', () => {
    const quantum = syn('Q', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, torpedo: true, missileDamageType: 'distortion' }).missiles;
    expect(ordnanceKindLabel(quantum)).toBe('Quantum torpedo');
    const torpedo = syn('T', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0, torpedo: true }).missiles;
    expect(ordnanceKindLabel(torpedo)).toBe('Torpedo');
    const missile = syn('M', { health: 1, armor: 0, shield: 0, regen: 0, fixedDps: 0 }).missiles;
    expect(ordnanceKindLabel(missile)).toBe('Missile');
    const quantumNonTorp = { ...missile, torpedo: false, damageType: 'distortion' as const };
    expect(ordnanceKindLabel(quantumNonTorp)).toBe('Quantum torpedo'); // distortion tag wins
  });
});

/** Per-shield generator on/off (2026-10-23): floor/cap/factor derive from the ON
 *  set; all-off drops shields completely (any ship, Stronghold class included). */
describe('per-shield generator on/off', () => {
  // 2× Shield 4/5 (Carrack-style Barbican pair): all-on floor 8 cap 10.
  const twoShieldShip = (name: string, over?: Partial<ShipData>): ShipData => ({
    ...syn(name, {
      health: 1, armor: 0, shield: 1000, regen: 100, fixedDps: 0,
      components: [comp('Shield', 4, 5), comp('Shield', 4, 5)],
    }),
    shieldPool: 10,
    ...over,
  });
  const cfgOf = (ship: ShipData, s: number, shieldOns: boolean[]): ShipConfig =>
    ({ ship, mannedTurrets: 0, powerToWeapons: 0, powerToShields: s, allocs: [], pdcOn: true, shieldOns });

  it('shield floor/cap/strength: 2×(4/5) → all-on 8/10/1, one-off 4/4 (boost locked)/½, all-off 0/0/0', () => {
    const ship = twoShieldShip('ShieldTog');
    expect(shieldOnsOf(ship, undefined)).toEqual([true, true]); // missing = all ON
    expect(shieldFloorOn(ship, undefined)).toBe(8);
    expect(shieldCapOn(ship, undefined)).toBe(10); // boost ceiling = full pool
    expect(shieldFloorOn(ship, [true, false])).toBe(4);
    expect(shieldCapOn(ship, [true, false])).toBe(4); // BOOST LADDER: any OFF ⇒ cap = floor
    expect(shieldFloorOn(ship, [false, false])).toBe(0);
    expect(shieldCapOn(ship, [false, false])).toBe(0);
    expect(shieldStrengthFactor(ship, undefined)).toBe(1);
    expect(shieldStrengthFactor(ship, [true, false])).toBeCloseTo(0.5); // fullDraw share, NOT the capped value
    expect(shieldStrengthFactor(ship, [false, false])).toBe(0);
    // Non-Shield components are always "ON" (toggles only apply to Shield entries).
    const mixed = twoShieldShip('ShieldTog2', { components: [comp('Shield', 4, 5), comp('Radar', 1, 2), comp('Shield', 4, 5)] });
    expect(shieldOnsOf(mixed, [true, true, false])).toEqual([true, true, false]);
    expect(shieldFloorOn(mixed, [true, true, false])).toBe(4);
  });

  it('regen at the locked floor = strength factor (s/cap = 1 with a generator OFF)', () => {
    const ship = twoShieldShip('ShieldBoost');
    // One generator OFF: cap collapses to the floor (4) — pips at the floor read the
    // ON set's regen at full fraction × 0.5 strength, NOT the old 5/10 double-cut.
    expect(derivedStats(cfgOf(ship, 4, [true, false])).shieldRegen).toBeCloseTo(50);
    expect(derivedStats(cfgOf(ship, 10, [true, true])).shieldRegen).toBe(100); // all-on boost intact
  });

  it('regen = regenPerSec × (pips / ON cap) × strength factor: one of two equal OFF halves it', () => {
    const ship = twoShieldShip('ShieldRegenTog');
    expect(derivedStats(cfgOf(ship, 10, [true, true])).shieldRegen).toBe(100); // full pool
    expect(derivedStats(cfgOf(ship, 5, [true, false])).shieldRegen).toBeCloseTo(50); // 5 > 4 cap (boost locked) saturates × 0.5
    expect(derivedStats(cfgOf(ship, 5, [true, true])).shieldRegen).toBeCloseTo(50); // 5/10 × 1 (unchanged model)
    expect(derivedStats(cfgOf(ship, 0, [false, false])).shieldRegen).toBe(0);
  });

  it('all generators OFF: battle starts shields-down — round 1 damage lands on structure; one OFF halves the pool', () => {
    const ship = twoShieldShip('ShieldOff', { health: 90000, armor: 1000 });
    const target = syn('TargetOff', { health: 900000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const off = simulate(cfgOf(ship, 0, [false, false]), fullConfig(target), 5);
    expect(off.rounds[0].a.phase).toBe('armor');
    expect(off.rounds[0].a.shieldBefore).toBe(0);
    expect(off.rounds[0].a.shieldAfter).toBe(0);
    expect(off.rounds[0].a.armorBefore - off.rounds[0].a.armorAfter).toBeGreaterThan(0);
    const half = simulate(cfgOf(ship, 5, [true, false]), fullConfig(target), 5);
    expect(half.rounds[0].a.phase).toBe('shield');
    expect(half.rounds[0].a.shieldBefore).toBe(500); // strength factor 0.5 of the 1000 pool
    const on = simulate(cfgOf(ship, 10, [true, true]), fullConfig(target), 5);
    expect(on.rounds[0].a.shieldBefore).toBe(1000); // legacy all-on pool untouched
  });

  it('RULE-R escape hatch: the 4 red-at-defaults ships clear overdraw with ONE shield generator OFF', () => {
    for (const name of ['Ironclad', 'Ironclad Assault', 'Prowler Utility Wikelo Work Special', 'MISC Hull B']) {
      const ship = findShip(name);
      const d = defaultAllocation(ship);
      expect(isOverdrawn(ship, toConfig(ship, d)), `${name} red at all-on defaults`).toBe(true);
      const shieldOns = shieldOnsOf(ship, undefined);
      const si = (ship.components ?? []).findIndex((c) => (c.type ?? '') === 'Shield');
      expect(si, `${name} has a shield component`).toBeGreaterThanOrEqual(0);
      shieldOns[si] = false;
      // Drop the shield pips to the REDUCED ON-set floor — the freed minOnline is
      // only reclaimed by sliding the shield level down (defaults open AT the
      // all-on floor; an OFF generator shrinks floor AND cap to the reduced ON-set
      // floor, which is why the slide reclaims the pips).
      const cfg: ShipConfig = {
        ship, mannedTurrets: ship.turretCount, powerToWeapons: d.gunPips,
        powerToShields: Math.min(d.shieldPips, shieldFloorOn(ship, shieldOns)),
        allocs: d.allocs, pdcOn: d.pdcOn, shieldOns,
      };
      expect(netPower(ship, cfg), `${name} net ≥ 0 with one shield OFF`).toBeGreaterThanOrEqual(0);
      expect(isOverdrawn(ship, cfg)).toBe(false);
    }
  });

  it('RULE-R fleet facts unchanged with all shields ON: ladder 224 ships, 4 red, free min 6 / p50 12', () => {
    // defaultAllocation never toggles shields (per-Shield on/off is a user action),
    // so the T20 ladder counts and red-ship set keep the 2026-10-23 (QDrive-off,
    // round-up billing) numbers asserted by the T19 fleet tests — re-asserted here
    // to pin that the toggle feature changed nothing at defaults.
    const frees = ships.map((s) => s.powerSegments - (s.components ?? []).reduce((t, c) => t + defaultAllocOf(c), 0));
    const sorted = [...frees].sort((a, b) => a - b);
    expect(sorted[0]).toBe(6);
    const red = ships
      .map((s) => ({ n: s.name, net: netPower(s, toConfig(s, defaultAllocation(s))) }))
      .filter((x) => x.net < 0);
    expect(red.length).toBe(4);
    expect([...red.map((x) => x.n)].sort()).toEqual(['Ironclad', 'Ironclad Assault', 'MISC Hull B', 'Prowler Utility Wikelo Work Special']);
  });

  it('new defaults (2026-10-23): sample ships open at shields-floor + guns-min-pips, fightable', () => {
    // 600i probe: floor 8 (2×4/5 gens), guns 8 (draw 8 / pool 8 → full cost at
    // every p; min = full pool), reserve 8, net 0. NOTE: the plan example guessed
    // "8 shields / 2 guns" for the 600i — the snapshot's aggregate gunDraw is 8
    // pips (pool 8), so the honest minimum powered figure is 8, not 2.
    const six = findShip('600i');
    const a = defaultAllocation(six);
    expect(a.shieldPips).toBe(8);
    expect(a.gunPips).toBe(8);
    expect(a.pdcOn).toBe(true);
    expect(netPower(six, toConfig(six, a))).toBe(0);
    expect(isOverdrawn(six, toConfig(six, a))).toBe(false);
    const gladius = findShip('Gladius'); // 2×(1/3): floor 2; draw 2.1/pool 4 → cost 3 at p = 4
    const g = defaultAllocation(gladius);
    expect(g.shieldPips).toBe(2);
    expect(g.gunPips).toBe(4);
    expect(netPower(gladius, toConfig(gladius, g))).toBe(5);
    const hammer = findShip('Hammerhead'); // 2×(2/5): floor 4; draw 10/pool 10 → 10
    expect(defaultAllocation(hammer).shieldPips).toBe(4);
    expect(defaultAllocation(hammer).gunPips).toBe(10);
    // Default shields sit exactly at the all-ON floor, and every default pips at
    // the FULL gun draw cost (minGunPipsFull property) — fleet-wide invariant.
    for (const s of ships) {
      const d = defaultAllocation(s);
      expect(d.shieldPips).toBe(shieldFloorOn(s, undefined));
      // Guns open at the full-draw cost whenever the ladder left them powered
      // (PDC on and gunPips > 0); the ladder cut (guns → 0) frees the pool.
      if (d.pdcOn && d.gunPips > 0) expect(gunCostAt(s, d.gunPips, true)).toBe(pipCost(gunDrawFull(s, true)));
    }
  });
});

describe('T25 fixed-gun mount fallback (declared UI heuristic, src/components/turretMounts.ts)', () => {
  // Mirrors LoadoutPanel's guns list: the weapons-pool component rows in order.
  const weaponRows = (s: ShipData) =>
    (s.components ?? []).map((c, i) => ({ c, i })).filter(({ c }) => WEAPONS_POOL_COMPONENT_TYPES.has(c.type ?? ''));
  const pair = (s: ShipData) => fixedGunPairings(s, weaponRows(s), turretMountMatcher(s));

  it('600i: 3 fixed M7A Cannons pair 1:1 onto the 3 gimbal rows; matched remote turrets untouched', () => {
    const six = findShip('600i');
    const p = pair(six);
    expect(p.guns).toBe(3);
    expect(p.mountsTotal).toBe(3);
    const rows = weaponRows(six);
    const gimbals = rows.filter(({ c }) => c.name === 'VariPuck S5 Gimbal Mount');
    expect(gimbals.length).toBe(3);
    for (const { i } of gimbals) {
      expect(p.mounts.get(i)).toBeNull();
      expect(p.byIndex.get(i)).toEqual([{ name: 'M7A Cannon', count: 1, dps: 1536.3, alpha: 921.8 }]);
    }
    const remotes = rows.filter(({ c }) => c.name === 'Remote Turret');
    expect(remotes.length).toBe(2);
    for (const { i } of remotes) {
      expect(p.mounts.get(i)?.kind).toBe('remote'); // T23 join keeps rendering
      expect(p.byIndex.get(i)).toBeUndefined(); // no fallback double-list
    }
    for (const groups of p.byIndex.values()) {
      expect(groups.map((g) => g.name)).not.toContain('CF-337 Panther Repeater'); // matched names excluded
    }
  });

  it('F7A Hornet Mk II (guns > mounts): 6 fixed guns round-robin onto the 4 empty turret rows; Mustang Alpha ×N-aggregates', () => {
    const hornet = findShip('F7A Hornet Mk II');
    expect(hornet.turretMounts ?? []).toHaveLength(0); // T23 gap ship
    const p = pair(hornet);
    expect(p.guns).toBe(6);
    expect(p.mountsTotal).toBe(4);
    const omnisky = { name: 'Omnisky IX Cannon', count: 1, dps: 546.8, alpha: 218.7 };
    const revenant = { name: 'Revenant Gatling', count: 1, dps: 1266, alpha: 63.3 };
    const turretRows = weaponRows(hornet).filter(({ c }) => TURRET_COMPONENT_TYPES.has(c.type ?? ''));
    expect(turretRows.length).toBe(4);
    // fixed list order [Revenant, Omnisky×4, Revenant] over 4 rows → gun k lands on
    // row k % 4: rows 0-1 take the two Revenants interleaved with Omniskys.
    expect(p.byIndex.get(turretRows[0].i)).toEqual([revenant, omnisky]);
    expect(p.byIndex.get(turretRows[1].i)).toEqual([omnisky, revenant]);
    expect(p.byIndex.get(turretRows[2].i)).toEqual([omnisky]);
    expect(p.byIndex.get(turretRows[3].i)).toEqual([omnisky]);
    // 2 guns / 1 mount → the mount row aggregates identical names: ×2, dps summed.
    const mustang = findShip('Mustang Alpha');
    const m = pair(mustang);
    expect(m.guns).toBe(2);
    expect(m.mountsTotal).toBe(1);
    const groups = m.byIndex.get(weaponRows(mustang).filter(({ c }) => TURRET_COMPONENT_TYPES.has(c.type ?? ''))[0].i);
    expect(groups?.length).toBe(1);
    expect(groups?.[0].name).toBe('CF-227 Badger Repeater');
    expect(groups?.[0].count).toBe(2);
    expect(groups?.[0].dps).toBeCloseTo(656.2, 1);
    expect(groups?.[0].alpha).toBe(26.2); // shown once = max per-gun alpha
  });

  it('mounts > guns pairs the first rows only; fixed guns named on a matched mount are excluded', () => {
    const base = syn('FGPair', { health: 100, armor: 0, shield: 0, regen: 0, fixedDps: 0 });
    const turretComp = (name: string): ShipComponent =>
      ({ type: 'Turret', name, className: 'FG_Mount', size: 3, grade: null, power: null, coolant: null, generation: { power: null, coolant: null } });
    const fixedGun = (name: string, dps: number, alpha: number) =>
      ({ name, type: 'fixed' as const, damageType: 'physical' as const, dps, alpha, power: 1, ammo: null });
    // 3 Turret rows share one className; only the first has an API mount entry.
    const ship: ShipData = {
      ...base,
      components: [turretComp('FG T1'), turretComp('FG T2'), turretComp('FG T3')],
      turretMounts: [{
        mount: 'hardpoint_fg', className: 'FG_Mount', kind: 'remote',
        weapons: [{ name: 'CF-337 Panther Repeater', size: 3, dps: 100, alpha: 10, count: 2 }],
      }],
      // CF-337 is rendered on the matched mount → excluded; 2 guns left for 2 rows.
      weapons: [fixedGun('CF-337 Panther Repeater', 400, 50), fixedGun('M6A Cannon', 300, 90), fixedGun('M7A Cannon', 200, 80)],
    };
    const p = pair(ship);
    expect(p.guns).toBe(2); // CF-337 excluded as already rendered
    expect(p.mountsTotal).toBe(2);
    expect(p.mounts.get(0)?.mount).toBe('hardpoint_fg');
    expect(p.byIndex.get(0)).toBeUndefined();
    expect(p.byIndex.get(1)).toEqual([{ name: 'M6A Cannon', count: 1, dps: 300, alpha: 90 }]);
    expect(p.byIndex.get(2)).toEqual([{ name: 'M7A Cannon', count: 1, dps: 200, alpha: 80 }]);
    // mounts > guns: the extra row renders nothing (undefined).
    const ship3: ShipData = {
      ...base,
      components: [turretComp('FG A'), turretComp('FG B'), turretComp('FG C')],
      turretMounts: [],
      weapons: [fixedGun('M5A Cannon', 100, 40), fixedGun('M6A Cannon', 200, 50)],
    };
    const p3 = pair(ship3);
    expect(p3.guns).toBe(2);
    expect(p3.mountsTotal).toBe(3);
    expect(p3.byIndex.get(0)).toEqual([{ name: 'M5A Cannon', count: 1, dps: 100, alpha: 40 }]);
    expect(p3.byIndex.get(1)).toEqual([{ name: 'M6A Cannon', count: 1, dps: 200, alpha: 50 }]);
    expect(p3.byIndex.get(2)).toBeUndefined();
  });
});
