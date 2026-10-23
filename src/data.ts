import shipsJson from '../data/ships.json';
import { z } from 'zod';
import { DAMAGE_TYPES } from './engine/types';
import type { ShipData } from './engine/types';

// SYNC OBLIGATION: mirror of src/engine/types.ts ShipData and of shipSchema in
// scripts/build-data.mjs — update all three together. Committed-snapshot fields validate
// as required (data/code skew must fail loudly); a genuinely NEW field is `.optional()`
// here and on ShipData so an un-regenerated ships.json keeps booting (UI degrades —
// T23 turretMounts convention).
const damageTypeSchema = z.enum(DAMAGE_TYPES);
const rangeSchema = z.object({ min: z.number(), max: z.number() });
const resourceRangeSchema = z.object({ minOnline: z.number().nonnegative(), fullDraw: z.number().nonnegative() });
const componentSchema = z.object({
  type: z.string().min(1),
  name: z.string(),
  className: z.string().min(1),
  size: z.number().int().nullable(),
  grade: z.number().int().nullable(),
  power: resourceRangeSchema.nullable(),
  coolant: resourceRangeSchema.nullable(),
  generation: z.object({ power: z.number().nullable(), coolant: z.number().nullable() }),
});

// Data/code skew (e.g. ships.json built before Weapon.ammo existed) must fail loudly at
// startup: the engine reads undefined ammo as infinite, silently disabling W4 depletion.
const shipSnapshotSchema = z.array(z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  manufacturer: z.string().min(1),
  career: z.string().nullable(),
  role: z.string().nullable(),
  sizeClass: z.enum(['snub', 'small', 'medium', 'large', 'capital', 'special', 'unknown']),
  image: z.string(),
  health: z.number().positive(),
  armor: z.number().nonnegative(),
  armorDeflection: z.record(damageTypeSchema, z.number().nonnegative()),
  armorMultipliers: z.record(damageTypeSchema, z.number().nonnegative()),
  shield: z.object({
    hp: z.number().positive(),
    regenPerSec: z.number().nonnegative(),
    faceType: z.string(),
    reconfigurationCooldown: z.number().nonnegative(),
    absorption: z.record(damageTypeSchema, rangeSchema),
    resistance: z.record(damageTypeSchema, rangeSchema),
  }),
  weapons: z.array(z.object({
    name: z.string(),
    type: z.enum(['fixed', 'turret']),
    damageType: damageTypeSchema,
    dps: z.number().nonnegative(),
    alpha: z.number().nonnegative(),
    power: z.number().positive(),
    ammo: z.number().int().positive().nullable(),
  })).min(1),
  turretCount: z.number().int().nonnegative(),
  // T23 per-mount weapons. `.optional()` (new-field convention): a ships.json
  // snapshot built before this field keeps validating, and the UI degrades to the
  // plain guns-pool rows; the builder always emits it (required on that side).
  turretMounts: z.array(z.object({
    mount: z.string(),
    className: z.string().min(1),
    kind: z.enum(['manned', 'remote', 'pdc']),
    weapons: z.array(z.object({
      name: z.string().min(1),
      size: z.number().int().nullable(),
      dps: z.number().nonnegative(),
      alpha: z.number().nonnegative(),
      count: z.number().int().positive(),
    })).min(1),
  })).optional(),
  emission: z.object({ ir: z.number().nonnegative() }),
  missiles: z.object({
    size: z.number().nonnegative(),
    ammo: z.number().int().nonnegative(),
    perShot: z.number().nonnegative(),
    torpedo: z.boolean(),
    damageType: z.enum(['physical', 'distortion']),
  }),
  countermeasures: z.object({
    decoys: z.number().int().nonnegative(),
  }),
  powerSegments: z.number().int().positive(),
  weaponPool: z.number().int().positive(),
  shieldPool: z.number().int().positive(),
  components: z.array(componentSchema),
  gunDraw: z.number().nonnegative(),
  shieldMin: z.number().nonnegative(),
  pdcCount: z.number().int().nonnegative(),
  crossSection: z.object({ length: z.number(), width: z.number(), height: z.number() }),
  speed: z.object({ scm: z.number().nullable(), max: z.number().nullable() }),
  mass: z.number().nonnegative(),
  crew: z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
}));

const parsed = shipSnapshotSchema.safeParse(shipsJson);
if (!parsed.success) {
  const issue = parsed.error.issues[0];
  throw new Error(
    `ships.json snapshot failed runtime schema validation${issue ? ` at ${issue.path.join('.')}: ${issue.message}` : ''} — data/code skew; regenerate with npm run build:data`,
  );
}

export const SHIPS = parsed.data as unknown as ShipData[];

export const shipByUuid = new Map(SHIPS.map((s) => [s.uuid, s]));

export const MANUFACTURERS = [...new Set(SHIPS.map((s) => s.manufacturer))].sort();
export const SIZES = ['snub', 'small', 'medium', 'large', 'capital', 'special', 'unknown'];
export const CAREERS = [...new Set(SHIPS.map((s) => s.career ?? 'Unclassified'))].sort();

export function shipTotalDps(s: ShipData): number {
  return s.weapons.reduce((t, w) => t + (w.type === 'fixed' ? w.dps : 0), 0);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
