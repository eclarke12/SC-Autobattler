import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { derivedStats, simulate } from './index';
import type { ShipConfig, ShipData } from './types';
import { DAMAGE_TYPES } from './types';

const ships = JSON.parse(readFileSync(new URL('../../data/ships.json', import.meta.url), 'utf8')) as ShipData[];

function findShip(name: string): ShipData {
  const s = ships.find((x) => x.name === name);
  if (!s) throw new Error(`ship ${name} not in snapshot`);
  return s;
}

function fullConfig(ship: ShipData): ShipConfig {
  return { ship, mannedTurrets: ship.turretCount, powerToWeapons: ship.weaponPool, powerToShields: ship.shieldPool };
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
}): ShipData {
  const turretCount = opts.turretCount ?? 0;
  const alpha = opts.alpha ?? 1000;
  const weapons = [
    ...(opts.fixedDps > 0 ? [{ name: `${name} gun`, type: 'fixed' as const, damageType: 'physical' as const, dps: opts.fixedDps, alpha, power: 1 }] : []),
    ...Array.from({ length: turretCount }, (_, i) => ({
      name: `${name} turret ${i + 1}`, type: 'turret' as const, damageType: 'physical' as const,
      dps: (opts.turretDps ?? 0), alpha, power: 1,
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
    shield: {
      hp: opts.shield, regenPerSec: opts.regen, faceType: 'Bubble', reconfigurationCooldown: 5,
      absorption: { ...(fullAbsorption as ShipData['shield']['absorption']), physical: { min: opts.physAbsorb ?? 1, max: opts.physAbsorb ?? 1 } },
      resistance: zeroResistance as ShipData['shield']['resistance'],
    },
    weapons,
    turretCount,
    powerSegments: 20, weaponPool: 20, shieldPool: 4, powerUsedShields: 4,
    crossSection: { length: 1, width: 1, height: 1 },
    speed: { scm: 200, max: 1000 }, mass: 1000, crew: { min: 1, max: 1 },
  };
}

describe('golden battles', () => {
  it('Hammerhead vs Gladius: armor gate zeroes the small guns, Hammerhead wins (seed 42)', () => {
    const result = simulate(fullConfig(findShip('Hammerhead')), fullConfig(findShip('Gladius')), 42);
    expect(result.winner).toBe('a');
    expect(result.summary.sides.b.totalDamageDealt).toBe(0);
    expect(result.summary.totalRounds).toBeLessThanOrEqual(80);
  });

  it('Stalker ballistic melts Gladius armor straight through its shield (seed 42)', () => {
    const result = simulate(fullConfig(findShip('Avenger Stalker')), fullConfig(findShip('Gladius')), 42);
    const r1 = result.rounds[0];
    // ~90% of physical phases through the Gladius shield: armor stripped while shield nearly full
    expect(r1.b.armorAfter).toBe(0);
    expect(r1.b.shieldAfter).toBeGreaterThan(r1.b.shieldBefore * 0.5);
    expect(result.summary.totalRounds).toBeLessThanOrEqual(3);
  });

  it('500 dps vs 2000 hp rig kills in ~2-3 rounds', () => {
    const attacker = syn('Attacker', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const defender = syn('Defender', { health: 2000, armor: 1000, shield: 2000, regen: 0, fixedDps: 0 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
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
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
      7,
    );
    expect(result.winner).toBe('a');
    expect(result.summary.totalRounds).toBeGreaterThanOrEqual(4);
    expect(result.summary.totalRounds).toBeLessThanOrEqual(6);
  });

  it('0 turrets loses to max turrets on time (monotonicity)', () => {
    const mk = (manned: number): ShipConfig => ({
      ship: syn('TurretShip', { health: 20000, armor: 0, shield: 0, regen: 0, fixedDps: 0, turretDps: 500, turretCount: 2 }),
      mannedTurrets: manned, powerToWeapons: 20, powerToShields: 4,
    });
    const passive: ShipConfig = {
      ship: syn('Target', { health: 9000, armor: 0, shield: 0, regen: 0, fixedDps: 100 }),
      mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4,
    };
    const zero = simulate(mk(0), passive, 3);
    const max = simulate(mk(2), passive, 3);
    expect(max.winner).toBe('a');
    expect(zero.winner).toBe('b');
    expect(max.summary.totalRounds).toBeLessThan(zero.summary.totalRounds);
  });

  it('under-powered weapons reduce derived DPS', () => {
    const ship = syn('PowerTest', { health: 1000, armor: 0, shield: 0, regen: 0, fixedDps: 2000 });
    const full = derivedStats({ ship, mannedTurrets: 0, powerToWeapons: 4, powerToShields: 1 });
    const half = derivedStats({ ship, mannedTurrets: 0, powerToWeapons: 2, powerToShields: 1 });
    expect(full.dpsScale).toBe(1);
    expect(half.dpsScale).toBeCloseTo(0.5);
    expect(half.weaponDps).toBeCloseTo(full.weaponDps * 0.5);
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

describe('armor deflection gate', () => {
  it('weapons below the gate deal zero damage while armor holds', () => {
    const attacker = syn('Weak', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 100 });
    const defender = syn('Armored', { health: 9000, armor: 500, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
      5,
    );
    expect(result.winner).toBe('draw');
    expect(result.summary.totalRounds).toBe(100);
    expect(result.summary.sides.a.totalDamageDealt).toBe(0);
    expect(result.rounds.every((rd) => rd.b.armorAfter === 500 && rd.b.hullAfter === 9000)).toBe(true);
    expect(result.rounds.every((rd) => rd.b.events.some((e) => e.includes('Armor deflects')))).toBe(true);
  });

  it('weapons at/above the gate strip armor and overflow carries to hull', () => {
    const attacker = syn('Strong', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500, alpha: 600 });
    const defender = syn('Armored', { health: 13000, armor: 1000, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
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
    const weak = { name: 'Weak gun', type: 'fixed' as const, damageType: 'physical' as const, dps: 400, alpha: 100, power: 1 };
    const attacker: ShipData = { ...base, weapons: [...base.weapons, weak] };
    const defender = syn('Armored', { health: 30000, armor: 1000, shield: 0, regen: 0, fixedDps: 0, deflectPhys: 500 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
      9,
    );
    expect(result.rounds[0].b.armorAfter).toBe(0);
    // seed 9 round-2 variance ≈ 1.105: heavy+weak = 13000 dps-round*va ≈ 14365 hull damage;
    // heavy alone (9000 * va) tops out at 10350, so > 10500 proves the weak gun resumed.
    const r2 = result.rounds[1];
    expect(r2.b.hullBefore - r2.b.hullAfter).toBeGreaterThan(10500);
  });

  it('snapshot data carries deflection gates and alpha, sentinels normalized', () => {
    for (const s of ships) {
      for (const t of DAMAGE_TYPES) expect(s.armorDeflection[t]).toBeLessThan(1e6);
      for (const w of s.weapons) expect(w.alpha).toBeGreaterThanOrEqual(0);
    }
    const hammer = findShip('Hammerhead');
    expect(hammer.armorDeflection.physical).toBeGreaterThan(500);
    expect(hammer.weapons.every((w) => w.alpha < hammer.armorDeflection.physical)).toBe(true);
  });
});

describe('shield absorption leak', () => {
  it('ballistic against zero physical absorption phases through shields onto armor/hull', () => {
    const attacker = syn('Ballistic', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const defender = syn('Leaky', { health: 9000, armor: 1000, shield: 2000, regen: 0, fixedDps: 0, physAbsorb: 0 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
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
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
      5,
    );
    expect(result.rounds[0].b.armorAfter).toBe(1000);
    expect(result.rounds[0].b.hullAfter).toBe(9000);
    expect(result.rounds[0].b.shieldAfter).toBeLessThan(20000);
  });
});
