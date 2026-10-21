import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const BASE = 'https://api.star-citizen.wiki/api';
const OUT_DIR = 'data';
const OUT_FILE = `${OUT_DIR}/ships.json`;

const DAMAGE_TYPES = ['physical', 'energy', 'distortion', 'thermal', 'biochemical', 'stun'];

const rangeSchema = z.object({ min: z.number(), max: z.number() });
const damageTypeSchema = z.enum(DAMAGE_TYPES);

const shipSchema = z.object({
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
  })).min(1),
  turretCount: z.number().int().nonnegative(),
  emission: z.object({ ir: z.number().nonnegative() }),
  missiles: z.object({
    size: z.number().nonnegative(),
    ammo: z.number().int().nonnegative(),
    perShot: z.number().nonnegative(),
    torpedo: z.boolean(),
  }),
  countermeasures: z.object({
    decoys: z.number().int().nonnegative(),
  }),
  powerSegments: z.number().int().positive(),
  weaponPool: z.number().int().positive(),
  shieldPool: z.number().int().positive(),
  powerUsedShields: z.number(),
  crossSection: z.object({ length: z.number(), width: z.number(), height: z.number() }),
  speed: z.object({ scm: z.number().nullable(), max: z.number().nullable() }),
  mass: z.number().nonnegative(),
  crew: z.object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
});

const PHYSICAL_NAME = /cannon|gatling|scatter ?gun|mortar|rail ?gun|shredder|projectile|gun|point ?defense/i;
const ENERGY_NAME = /repeater|laser|pulse|beam|particle|photon|disrupt/i;
function damageTypeFor(name) {
  if (PHYSICAL_NAME.test(name)) return 'physical';
  if (ENERGY_NAME.test(name)) return 'energy';
  return 'physical';
}

function toRanges(obj) {
  const out = {};
  for (const t of DAMAGE_TYPES) {
    const r = obj?.[t];
    out[t] = { min: num(r?.minimum, 0), max: num(r?.maximum, 0) };
  }
  return out;
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// armor.deflection values are per-shot damage thresholds; >= 1,000,000 is the game's
// "undeflectable" sentinel (no gate), 0 means no armor gate for that type.
const UNDEFLECTABLE = 1e6;
function toDeflection(obj) {
  const out = {};
  for (const t of DAMAGE_TYPES) {
    const v = num(obj?.[t], 0);
    out[t] = v >= UNDEFLECTABLE ? 0 : v;
  }
  return out;
}

const NUMERIC_SIZE = { 1: 'snub', 2: 'small', 3: 'medium', 4: 'large', 5: 'large', 6: 'capital', 10: 'special' };
function sizeClassFor(ship) {
  const label = (ship.size?.en_EN ?? '').toLowerCase();
  if (['snub', 'small', 'medium', 'large', 'capital'].includes(label)) return label;
  return NUMERIC_SIZE[ship.size_class] ?? 'unknown';
}

// Ordnance & countermeasures come from the hardpoint tree (ship.ports, recursively
// equipped_item). Missile racks give launcher count and the size of the MISSILES they
// fire (not the hardpoint size: a 6x hardpoint can carry a 12xS3 rack); torpedoes are
// missiles of size >= 5, and racks named "Torpedo" always count. WeaponDefensive/
// CountermeasureLauncher ports are Decoy (flare) vs Noise (chaff).
// Warload count + per-tube damage come from weaponry.missiles (standard loadout aggregate).
function collectPorts(ports, out = []) {
  for (const p of ports || []) {
    out.push(p);
    collectPorts(p.ports, out);
  }
  return out;
}

// Size of the missiles a rack fires, from the API naming conventions:
//  - class_name trailing missile-size token: MRCK_S06_..._AEGS_Sabre_Firebird_S03 → 3
//    (leading MRCK_S0N is the hardpoint; a trailing token overrides it)
//  - explicit "12xS3" / "2xS2" / "Quad S5" in the display name
//  - MSD-abc racks: digits are hardpoint/count/missile-size (MSD-543 = S5 rack, 4×S3)
//  - otherwise missile size == hardpoint size (rack fills its hardpoint, e.g. S6 torpedoes)
function missileSizeFor(item) {
  const cn = item.class_name ?? '';
  const name = item.name ?? '';
  const trail = cn.match(/_S(\d{1,2})$/i);
  if (trail) return Number(trail[1]);
  const named = name.match(/\d+\s*x\s*S(\d)/i) ?? name.match(/\bQuad\s+S(\d)\b/i) ?? name.match(/\bS(\d)\b/i);
  if (named) return Number(named[1]);
  const msd = name.match(/MSD-(\d)(\d)(\d)/i);
  if (msd) return Number(msd[3]);
  const prefix = cn.match(/^MRCK_S(\d{1,2})/i);
  if (prefix) return Number(prefix[1]);
  return num(item.size, 0);
}

function ordnanceOf(ship) {
  let racks = 0;
  let maxSize = 0;
  let torpedoNamed = false;
  let decoys = 0;
  for (const p of collectPorts(ship.ports)) {
    const it = p.equipped_item;
    if (!it) continue;
    if (it.type === 'MissileLauncher') {
      racks++;
      maxSize = Math.max(maxSize, missileSizeFor(it));
      const hay = `${it.name ?? ''} ${it.class_name ?? ''}`.toLowerCase();
      if (/torpedo/.test(hay)) torpedoNamed = true;
    }
    if (it.type === 'WeaponDefensive') {
      const hay = `${it.name ?? ''} ${it.class_name ?? ''}`.toLowerCase();
      if (/decoy|flare/.test(hay)) decoys++;
    }
  }
  const agg = ship.weaponry?.missiles;
  const ammo = racks > 0 ? (num(agg?.count, 0) || racks * 2) : 0; // dual-rack default when unlisted
  const dmg = num(agg?.damage?.physical, 0) + num(agg?.damage?.energy, 0);
  const perShot = ammo > 0 ? Math.round(dmg / ammo) : 0;
  return {
    missiles: { size: maxSize, ammo: perShot > 0 ? ammo : 0, perShot, torpedo: torpedoNamed || maxSize >= 5 },
    countermeasures: { decoys },
  };
}

function isDisplayModel(ship) {
  return /_display$/i.test(ship.class_name ?? '') || /-display$/i.test(ship.slug ?? '');
}

function dedupeByName(ships) {
  const rank = (s) => (num(s.msrp, 0) > 0 ? 0 : 1);
  const best = new Map();
  for (const s of ships) {
    const key = `${s.manufacturer?.name ?? ''}|${s.name}|${s.chassis_id ?? s.class_name ?? ''}`.toLowerCase();
    const cur = best.get(key);
    if (!cur || rank(s) < rank(cur)) best.set(key, s);
  }
  return [...best.values()];
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function fetchAllVehicles() {
  let url = `${BASE}/vehicles`;
  const items = [];
  let pages = 0;
  while (url && pages < 80) {
    const json = await getJson(url);
    items.push(...json.data);
    url = json.links?.next ?? null;
    pages++;
  }
  return { items, pages };
}

function normalize(ship) {
  const fixed = (ship.weaponry?.fixed_weapons?.weapons ?? [])
    .filter((w) => num(w.dps, 0) > 0)
    .map((w) => ({
      name: w.name ?? 'Unknown weapon',
      type: 'fixed',
      damageType: damageTypeFor(w.name ?? ''),
      dps: w.dps,
      alpha: num(w.alpha, 0),
      power: 1,
    }));
  const manned = (ship.turrets?.manned ?? []).map((t, i) => {
    const label = t.weapons?.[0]?.name ?? t.class_name ?? t.display_name ?? `Turret ${i + 1}`;
    const maxAlpha = Math.max(0, ...(t.weapons ?? []).map((w) => num(w.alpha, 0)));
    return {
      name: label,
      type: 'turret',
      damageType: damageTypeFor(label),
      dps: num(t.dps_total, 0),
      alpha: maxAlpha,
      power: 1,
    };
  });
  const shield = ship.shield ?? {};
  return {
    uuid: ship.uuid,
    name: ship.name,
    displayName: ship.name,
    manufacturer: ship.manufacturer?.name ?? 'Unknown',
    career: ship.career ?? null,
    role: ship.role ?? null,
    sizeClass: sizeClassFor(ship),
    image: ship.images?.[0]?.thumbnail_url ?? '',
    health: ship.health,
    armor: num(ship.armor?.health, 0),
    armorDeflection: toDeflection(ship.armor?.deflection),
    shield: {
      hp: shield.hp,
      regenPerSec: num(shield.regeneration, 0),
      faceType: shield.face_type ?? 'Bubble',
      reconfigurationCooldown: num(shield.reconfiguration_cooldown, 5),
      absorption: toRanges(shield.absorption),
      resistance: toRanges(shield.resistance),
    },
    weapons: [...fixed, ...manned],
    turretCount: (ship.turrets?.manned ?? []).length,
    emission: { ir: num(ship.emission?.ir, 0) },
    ...ordnanceOf(ship),
    powerSegments: Math.round(num(ship.power?.generation_segments, 1)),
    weaponPool: Math.round(num(ship.power_pools?.WeaponGun?.size, 4)),
    shieldPool: Math.round(num(ship.power_pools?.Shield?.size, 2)),
    powerUsedShields: num(ship.power?.used_segments_shields, 0),
    crossSection: {
      length: num(ship.cross_section?.length, 1),
      width: num(ship.cross_section?.width, 1),
      height: num(ship.cross_section?.height, 1),
    },
    speed: { scm: num(ship.speed?.scm, null), max: num(ship.speed?.max, null) },
    mass: num(ship.mass, 0),
    crew: { min: num(ship.crew?.min, 1), max: num(ship.crew?.max, 1) },
  };
}

const { items, pages } = await fetchAllVehicles();
console.log(`fetched ${items.length} vehicles across ${pages} pages`);

const spaceships = items.filter((s) => s.is_spaceship);
console.log(`is_spaceship: ${spaceships.length}`);

const flyable = spaceships.filter((s) => !isDisplayModel(s));
console.log(`display models excluded: ${spaceships.length - flyable.length}`);

const unique = dedupeByName(flyable);
console.log(`deduped: ${unique.length} (removed ${flyable.length - unique.length} identical livery/chassis twins)`);

const ships = [];
const problems = [];
let unarmed = 0;
for (const raw of unique) {
  let ship;
  try {
    ship = normalize(raw);
    if (ship.weapons.length < 1) {
      unarmed++;
      continue;
    }
    ship = shipSchema.parse(ship);
    ships.push(ship);
  } catch (e) {
    const issue = e.issues?.[0] ? ` at ${e.issues[0].path.join('.')}: ${e.issues[0].message}` : `: ${e.message}`;
    problems.push(`${raw.name} (${raw.uuid})${issue}`);
  }
}

if (problems.length) {
  console.error(`\nVALIDATION FAILURES (${problems.length}):`);
  for (const p of problems.slice(0, 30)) console.error('  - ' + p);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(ships));
const withImages = ships.filter((s) => s.image).length;
const withTurrets = ships.filter((s) => s.turretCount > 0).length;
const bySize = {};
for (const s of ships) bySize[s.sizeClass] = (bySize[s.sizeClass] ?? 0) + 1;
console.log(`wrote ${OUT_FILE}: ${ships.length} ships | unarmed-filtered=${unarmed} | images=${withImages} | manned-turret ships=${withTurrets} | sizes=${JSON.stringify(bySize)}`);
