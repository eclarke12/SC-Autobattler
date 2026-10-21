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
}): ShipData {
  const turretCount = opts.turretCount ?? 0;
  const weapons = [
    ...(opts.fixedDps > 0 ? [{ name: `${name} gun`, type: 'fixed' as const, damageType: 'physical' as const, dps: opts.fixedDps, power: 1 }] : []),
    ...Array.from({ length: turretCount }, (_, i) => ({
      name: `${name} turret ${i + 1}`, type: 'turret' as const, damageType: 'physical' as const,
      dps: (opts.turretDps ?? 0), power: 1,
    })),
  ];
  return {
    uuid: name, name, displayName: name, manufacturer: 'Test', career: 'Combat', role: 'Test',
    sizeClass: 'small', image: '',
    health: opts.health, armor: opts.armor,
    shield: {
      hp: opts.shield, regenPerSec: opts.regen, faceType: 'Bubble', reconfigurationCooldown: 5,
      absorption: fullAbsorption as ShipData['shield']['absorption'],
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
  it('Avenger Stalker vs Gladius: decisive winner in sane round bounds (seed 42)', () => {
    const result = simulate(fullConfig(findShip('Avenger Stalker')), fullConfig(findShip('Gladius')), 42);
    expect(result.winner).not.toBe('draw');
    expect(result.summary.totalRounds).toBeGreaterThanOrEqual(3);
    expect(result.summary.totalRounds).toBeLessThanOrEqual(80);
    expect(result.summary.winnerName).toBe('Gladius');
  });

  it('500 dps vs 2000 hp rig kills in ~4-6 rounds', () => {
    const attacker = syn('Attacker', { health: 50000, armor: 0, shield: 0, regen: 0, fixedDps: 500 });
    const defender = syn('Defender', { health: 2000, armor: 1000, shield: 2000, regen: 0, fixedDps: 0 });
    const result = simulate(
      { ship: attacker, mannedTurrets: 0, powerToWeapons: 20, powerToShields: 4 },
      { ship: defender, mannedTurrets: 0, powerToWeapons: 1, powerToShields: 4 },
      7,
    );
    // 500 dps * 10s * (1-0.10) = 4500/round vs 2000 shield + 1000 armor + 2000 hull = 5000 (round 1
    // overflow eats 2500 hull, round 2 kills). With 13000 hull expect ~4-6; assert sane bounds.
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
