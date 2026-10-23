import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const BASE = 'https://api.star-citizen.wiki/api';
const OUT_DIR = 'data';
const OUT_FILE = `${OUT_DIR}/ships.json`;
const CACHE_FILE = `${OUT_DIR}/components-cache.json`;
const GUN_AMMO_SIZES_FILE = `${OUT_DIR}/gun-ammo-sizes.json`;

const DAMAGE_TYPES = ['physical', 'energy', 'distortion', 'thermal', 'biochemical', 'stun'];

const rangeSchema = z.object({ min: z.number(), max: z.number() });
const damageTypeSchema = z.enum(DAMAGE_TYPES);

// Component power join (T18, plan-power-components): every equipped_item on every ship
// becomes a ShipComponent; power/coolant/generation come from the T17 item cache keyed
// by class_name. minOnline/fullDraw naming per confirmed decision (nested per-resource).
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
});

const PHYSICAL_NAME = /cannon|gatling|scatter ?gun|mortar|rail ?gun|shredder|projectile|gun|point ?defense/i;
const ENERGY_NAME = /repeater|laser|pulse|beam|particle|photon|disrupt/i;
function damageTypeFor(name) {
  if (PHYSICAL_NAME.test(name)) return 'physical';
  if (ENERGY_NAME.test(name)) return 'energy';
  return 'physical';
}

// Gun ammunition (W4, T13): the API ships no ammo counts and no gun size (probe GC2:
// fixed entries are exactly {name, dps, sustained_dps, alpha}). Declared heuristic
// (deviation, primer §12.17): size from `S<n>` name tokens (e.g. "KLWE LaserRepeater
// S4"), untagged guns default to S2 (fleet's most common class); the table lives in
// data/gun-ammo-sizes.json (single source shared with src/engine/constants.ts).
// Energy weapons (lasers) draw ship power ⇒ infinite (null); alpha-0 guns have unknown
// fire rate ⇒ no depletion.
const GUN_AMMO_BY_SIZE = JSON.parse(readFileSync(GUN_AMMO_SIZES_FILE, 'utf8'));
const GUN_AMMO_SIZE_DEFAULT = 2;
const GUN_AMMO_SIZE_MAX = 12;
function gunAmmoFor(label, damageType, alpha) {
  if (damageType !== 'physical' || alpha <= 0) return null;
  const m = label.match(/\bS(\d{1,2})\b/i);
  const size = m && Number(m[1]) >= 1 && Number(m[1]) <= GUN_AMMO_SIZE_MAX ? Number(m[1]) : GUN_AMMO_SIZE_DEFAULT;
  return GUN_AMMO_BY_SIZE[size] ?? GUN_AMMO_BY_SIZE[GUN_AMMO_SIZE_DEFAULT];
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

// armor.damage_multipliers.{type}: how efficiently each damage type eats armor HP
// (observed 0.65-1.0; missing = 1 = no reduction). The hull takes raw damage.
function toMultipliers(obj) {
  const out = {};
  for (const t of DAMAGE_TYPES) out[t] = num(obj?.[t], 1);
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

// T17 item cache (data/components-cache.json): { class_name -> { type, power, coolant,
// generation } }. Hard-exit when missing: the join degrades silently to all-null
// components, so a stale/absent cache must fail loudly like the other gates.
let componentCache;
try {
  componentCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
} catch (e) {
  console.error(`FATAL: cannot read ${CACHE_FILE} (regenerate via scripts/build-components.mjs, T17): ${e.message}`);
  process.exit(1);
}

// Port types that MUST carry power data (hard gate): these are the systems the
// allocation UI exposes. Turret/WeaponGun/Module/ToolArm etc. are joined with nulls.
const POWER_PORT_TYPES = new Set(['Shield', 'Cooler', 'Radar', 'FlightController', 'LifeSupportGenerator', 'QuantumDrive']);

// The T17 cache emits `{minOnline: null, fullDraw: null}` placeholder ranges when a
// resource usage key is absent; the ShipComponent contract wants a whole-null range.
function rangeOrNull(r) {
  return r && typeof r.minOnline === 'number' && typeof r.fullDraw === 'number'
    ? { minOnline: r.minOnline, fullDraw: r.fullDraw }
    : null;
}

// ports-tree traversal order; unknown class_name -> nulls with the port's type.
function componentsOf(ship) {
  const out = [];
  for (const p of collectPorts(ship.ports)) {
    const it = p.equipped_item;
    if (!it?.class_name) continue;
    const c = componentCache[it.class_name];
    out.push({
      type: it.type,
      name: it.name ?? '',
      className: it.class_name,
      size: it.size ?? null,
      grade: it.grade ?? null,
      power: rangeOrNull(c?.power),
      coolant: rangeOrNull(c?.coolant),
      generation: { power: num(c?.generation?.power, null), coolant: num(c?.generation?.coolant, null) },
    });
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
  let quantumNamed = false;
  let decoys = 0;
  for (const p of collectPorts(ship.ports)) {
    const it = p.equipped_item;
    if (!it) continue;
    if (it.type === 'MissileLauncher') {
      racks++;
      maxSize = Math.max(maxSize, missileSizeFor(it));
      const hay = `${it.name ?? ''} ${it.class_name ?? ''}`.toLowerCase();
      if (/torpedo/.test(hay)) torpedoNamed = true;
      if (/quantum/.test(hay)) quantumNamed = true;
    }
    if (it.type === 'WeaponDefensive') {
      const hay = `${it.name ?? ''} ${it.class_name ?? ''}`.toLowerCase();
      if (/decoy|flare/.test(hay)) decoys++;
    }
  }
  // Declared heuristic (probe GC5, recorded gap): zero racks in the API tree carry a
  // "Quantum" name token; Polaris is the only S6-torpedo-class ship with quantum torpedoes.
  const isQuantum = quantumNamed || /polaris/i.test(ship.name ?? '');
  const agg = ship.weaponry?.missiles;
  const ammo = racks > 0 ? (num(agg?.count, 0) || racks * 2) : 0; // dual-rack default when unlisted
  const dmg = num(agg?.damage?.physical, 0) + num(agg?.damage?.energy, 0) + num(agg?.damage?.distortion, 0);
  const perShot = ammo > 0 ? Math.round(dmg / ammo) : 0;
  return {
    missiles: {
      size: maxSize,
      ammo: perShot > 0 ? ammo : 0,
      perShot,
      torpedo: torpedoNamed || maxSize >= 5,
      damageType: isQuantum ? 'distortion' : 'physical',
    },
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
    .map((w) => {
      const label = w.name ?? 'Unknown weapon';
      const damageType = damageTypeFor(label);
      const alpha = num(w.alpha, 0);
      return {
        name: label,
        type: 'fixed',
        damageType,
        dps: w.dps,
        alpha,
        power: 1,
        ammo: gunAmmoFor(label, damageType, alpha),
      };
    });
  const manned = (ship.turrets?.manned ?? []).map((t, i) => {
    const label = t.weapons?.[0]?.name ?? t.class_name ?? t.display_name ?? `Turret ${i + 1}`;
    const maxAlpha = Math.max(0, ...(t.weapons ?? []).map((w) => num(w.alpha, 0)));
    const damageType = damageTypeFor(label);
    return {
      name: label,
      type: 'turret',
      damageType,
      dps: num(t.dps_total, 0),
      alpha: maxAlpha,
      power: 1,
      ammo: gunAmmoFor(label, damageType, maxAlpha),
    };
  });
  const shield = ship.shield ?? {};
  // Component join (T18): per-ship components in ports-tree order; shield pool/floor
  // derived from shield components (replaces the power_pools.Shield.size constant).
  const components = componentsOf(ship);
  const shieldComps = components.filter((c) => c.type === 'Shield' && c.power);
  const shieldPool = shieldComps.length
    ? Math.round(shieldComps.reduce((sum, c) => sum + c.power.fullDraw, 0))
    : Math.round(num(ship.power_pools?.Shield?.size, 2));
  const shieldMin = shieldComps.reduce((sum, c) => sum + c.power.minOnline, 0);
  const pdcCount = (ship.turrets?.pdc ?? []).length;
  // Aggregate fixed-gun draw, kept FRACTIONAL (e.g. 3.1) — no per-weapon power exists.
  const gunDraw = num(ship.power?.used_segments_grouped?.WeaponGun, 0);
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
    armorMultipliers: toMultipliers(ship.armor?.damage_multipliers),
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
    shieldPool,
    components,
    gunDraw,
    shieldMin,
    pdcCount,
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

// Fleet-shape sanity: every weapon field is read via optional chaining with `?? []`
// fallbacks, so an API weapons-path change maps EVERY ship to zero weapons; those
// ships are `continue`d as unarmed, problems stays empty, and an empty/shrunken
// snapshot would exit 0 and crash the SPA at load (defaultKnobs(SHIPS[0])). Fail loudly.
if (ships.length === 0) {
  console.error(`FATAL: 0 valid ships written from ${unique.length} candidates (unarmed-filtered=${unarmed}) — API shape change? Refusing to write ${OUT_FILE}.`);
  process.exit(1);
}
if (unarmed > unique.length * 0.2) {
  console.error(`FATAL: ${unarmed}/${unique.length} ships (${((unarmed / unique.length) * 100).toFixed(1)}%) mapped with zero weapons (> 20%) — API weapons path changed? Refusing to write ${OUT_FILE}.`);
  process.exit(1);
}

// T18 component-join hard gates (repo convention: fail loudly, never write a degraded snapshot).
const noComps = ships.filter((s) => s.components.length < 1).map((s) => `${s.name} (${s.uuid})`);
if (noComps.length) {
  console.error(`FATAL: ${noComps.length} ships with ZERO components — ports join broken? Refusing to write ${OUT_FILE}:`);
  for (const s of noComps.slice(0, 30)) console.error('  - ' + s);
  process.exit(1);
}
const missingPower = [];
const badRange = [];
for (const s of ships) {
  for (const c of s.components) {
    if (POWER_PORT_TYPES.has(c.type) && c.power === null) missingPower.push(`${s.name} [${s.uuid}]: ${c.type} ${c.className}`);
    if (c.power && c.power.minOnline > c.power.fullDraw) badRange.push(`${s.name} [${s.uuid}]: ${c.type} ${c.className} minOnline=${c.power.minOnline} > fullDraw=${c.power.fullDraw}`);
  }
}
if (missingPower.length) {
  console.error(`FATAL: ${missingPower.length} powered-system components (Shield/Cooler/Radar/FlightController/LifeSupportGenerator/QuantumDrive) lack power data — cache gap? Refusing to write ${OUT_FILE}:`);
  for (const m of missingPower.slice(0, 30)) console.error('  - ' + m);
  process.exit(1);
}
if (badRange.length) {
  console.error(`FATAL: ${badRange.length} components with minOnline > fullDraw — cache corruption? Refusing to write ${OUT_FILE}:`);
  for (const b of badRange.slice(0, 30)) console.error('  - ' + b);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(ships));
const withImages = ships.filter((s) => s.image).length;
const withTurrets = ships.filter((s) => s.turretCount > 0).length;
const bySize = {};
for (const s of ships) bySize[s.sizeClass] = (bySize[s.sizeClass] ?? 0) + 1;
console.log(`wrote ${OUT_FILE}: ${ships.length} ships | unarmed-filtered=${unarmed} | images=${withImages} | manned-turret ships=${withTurrets} | sizes=${JSON.stringify(bySize)}`);

// T18 component-join fleet stats (report to docs/data-notes.md).
const pctl = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.max(0, Math.ceil((p / 100) * a.length) - 1)] : 0;
};
const sumOf = (s, k) => s.components.reduce((t, c) => t + (c.power?.[k] ?? 0), 0);
const compTotal = ships.reduce((t, s) => t + s.components.length, 0);
const sumMin = ships.map((s) => sumOf(s, 'minOnline'));
const sumMax = ships.map((s) => sumOf(s, 'fullDraw'));
console.log(`components=${compTotal} across ${ships.length} ships (${(compTotal / ships.length).toFixed(1)}/ship)`);
console.log(`per-ship ΣminOnline: p50=${pctl(sumMin, 50)} p75=${pctl(sumMin, 75)} p90=${pctl(sumMin, 90)} max=${pctl(sumMin, 100)}`);
console.log(`per-ship ΣfullDraw:  p50=${pctl(sumMax, 50)} p75=${pctl(sumMax, 75)} p90=${pctl(sumMax, 90)} max=${pctl(sumMax, 100)}`);
const overMin = ships.map((s, i) => ({ s, m: sumMin[i] })).filter((x) => x.m > x.s.powerSegments);
console.log(`ships with ΣminOnline > powerSegments: ${overMin.length}`);
const OVER_MIN_LIST = 25;
for (const { s, m } of overMin.slice(0, OVER_MIN_LIST)) console.log(`  - ${s.name} [${s.uuid}]: Σmin=${m} > gen=${s.powerSegments}`);
if (overMin.length > OVER_MIN_LIST) console.log(`  …and ${overMin.length - OVER_MIN_LIST} more`);
const poolDist = {};
for (const s of ships) poolDist[s.shieldPool] = (poolDist[s.shieldPool] ?? 0) + 1;
console.log(`shieldPool distribution: ${JSON.stringify(poolDist)}`);
