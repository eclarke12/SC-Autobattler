import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { missileSizeFor, MISSILE_TORPEDO_MIN_SIZE } from '../src/engine/missile-size.mjs';

const BASE = 'https://api.star-citizen.wiki/api';
const OUT_DIR = 'data';
const OUT_FILE = `${OUT_DIR}/ships.json`;
const CACHE_FILE = `${OUT_DIR}/components-cache.json`;
const WEAPON_DMG_FILE = `${OUT_DIR}/weapon-damage-cache.json`;
const GUN_AMMO_SIZES_FILE = `${OUT_DIR}/gun-ammo-sizes.json`;

const DAMAGE_TYPES = ['physical', 'energy', 'distortion', 'thermal', 'biochemical', 'stun'];

const rangeSchema = z.object({ min: z.number(), max: z.number() });
const damageTypeSchema = z.enum(DAMAGE_TYPES);

// Component power join (T18, plan-power-components): every equipped_item on every ship
// becomes a ShipComponent; power/coolant/generation come from the T17 item cache keyed
// by class_name. minOnline/fullDraw naming per confirmed decision (nested per-resource).
// Grade is the wiki LETTER grade (A = best, G1 = A, G3 = C); `cls` is the component
// class (Military/Civilian/Industrial/Stealth/Competition, null = unclassified) — both
// from the T17 cache (2026-10-24), ports-tree numeric grade as letter fallback.
const resourceRangeSchema = z.object({ minOnline: z.number().nonnegative(), fullDraw: z.number().nonnegative() });
const componentSchema = z.object({
  type: z.string().min(1),
  name: z.string(),
  className: z.string().min(1),
  size: z.number().int().nullable(),
  grade: z.enum(['A', 'B', 'C', 'D', 'E']).nullable(),
  cls: z.string().nullable(),
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
  // T23 per-mount weapons (display-only). Join key = the API turret-array entry's
  // `class_name`, which equals the ports-tree Turret/TurretBase component className.
  // T24: weapon entries carry size/dps/alpha for the sub-line rendering.
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
  })),
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

// Damage type comes from the API's per-type dps on the gun item
// (`vehicle_weapon.damage.dps`, imported by scripts/build-weapon-damage.mjs) — the
// name-regex classifier this replaces misclassified energy laser CANNONS as
// ballistic: "M7A Cannon" is BEHR_LaserCannon_S5 (docs/data-notes.md §4). Display
// names can span sizes/types ("M9A Cannon" = S12 mass driver, S7–S9 laser cannons,
// Javelin S7 ballistic), so same-name variants are disambiguated by the per-gun
// dps in the ship payload. Unjoinable labels (internal mount/radar names like
// "port_NameTurret09") fall back to the legacy name heuristic and are reported.
const PHYSICAL_NAME = /cannon|gatling|scatter ?gun|mortar|rail ?gun|shredder|projectile|gun|point ?defense/i;
const ENERGY_NAME = /repeater|laser|pulse|beam|particle|photon|disrupt/i;
const weaponDamageCacheSchema = z.record(z.object({
  name: z.string().min(1),
  variants: z.array(z.object({
    className: z.string().min(1),
    damageType: z.enum(DAMAGE_TYPES).nullable(),
    dps: z.record(damageTypeSchema, z.number()),
  })).min(1),
}));
// Hard-exit when missing: classification silently degrades to the name regex
// (the exact bug that shipped M7A as ballistic), so a stale/absent cache must fail loudly.
let weaponDamage;
try {
  weaponDamage = weaponDamageCacheSchema.parse(JSON.parse(readFileSync(WEAPON_DMG_FILE, 'utf8')));
} catch (e) {
  console.error(`FATAL: cannot read/validate ${WEAPON_DMG_FILE} (regenerate via npm run build:weapon-damage): ${e.message}`);
  process.exit(1);
}
const typeFallbacks = new Map();
const typeAmbiguous = new Map();
function damageTypeFor(name, gunDps) {
  const entry = weaponDamage[name.trim().toLowerCase()];
  if (entry) {
    const types = [...new Set(entry.variants.map((v) => v.damageType).filter((t) => t !== null))];
    if (types.length === 1) return types[0];
    if (types.length > 1) {
      // Variant dps vectors are per-type records; compare the dominant type's own
      // dps value against the ship payload's per-gun dps (exact within 2% when
      // the loadout ships no DPS-modding attachments).
      const dps = num(gunDps, 0);
      const exact = entry.variants.find(
        (v) => v.damageType && Math.abs((v.dps[v.damageType] ?? 0) - dps) <= Math.max(0.5, 0.02 * dps),
      );
      if (exact?.damageType) return exact.damageType;
      typeAmbiguous.set(name, (typeAmbiguous.get(name) ?? 0) + 1);
      return types[0];
    }
  }
  typeFallbacks.set(name, (typeFallbacks.get(name) ?? 0) + 1);
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
// missiles of size >= MISSILE_TORPEDO_MIN_SIZE, and racks named "Torpedo" always
// count. WeaponDefensive/
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
// Grade: the cache carries the wiki letter (G1 = A, G3 = C); the ports-tree numeric
// grade (1–4) is the letter fallback when the cache has none (null-sentinel entries).
const GRADE_LETTER = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' };
function gradeLetter(cacheGrade, portGrade) {
  if (typeof cacheGrade === 'string' && GRADE_LETTER_INV.has(cacheGrade)) return cacheGrade;
  return GRADE_LETTER[portGrade] ?? null;
}
const GRADE_LETTER_INV = new Set(['A', 'B', 'C', 'D', 'E']);

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
      grade: gradeLetter(c?.grade, it.grade),
      cls: typeof c?.cls === 'string' ? c.cls : null,
      power: rangeOrNull(c?.power),
      coolant: rangeOrNull(c?.coolant),
      generation: { power: num(c?.generation?.power, null), coolant: num(c?.generation?.coolant, null) },
    });
  }
  return out;
}

// Missile warhead size uses the shared single source src/engine/missile-size.mjs
// (same classifier the LoadoutPanel per-rack sub-lines use — no UI/builder drift).
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
      maxSize = Math.max(maxSize, missileSizeFor({ className: it.class_name, name: it.name, size: it.size }));
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
      torpedo: torpedoNamed || maxSize >= MISSILE_TORPEDO_MIN_SIZE,
      damageType: isQuantum ? 'distortion' : 'physical',
    },
    countermeasures: { decoys },
  };
}

// Per-mount weapons (T23): the Guns-section "Turret:" rows show the MOUNT component
// (e.g. "VariPuck S3 Gimbal Mount", "Manned Turret"), not the guns on it. The live
// API (probed 2026-10-23) carries real per-mount weapon names on ALL three turret
// arrays — `turrets.manned[i].weapons[].name`, same shape for `remote` and `pdc`
// (Hammerhead: 4× "CF-447 Rhino Repeater"; Idris: 11× "M2C \"Swarm\"" PDCs;
// Reclaimer remote: 2× "CF-337 Panther Repeater"). Entry keys include `class_name`
// = the ports-tree Turret/TurretBase component className (exact join key, 175/191
// manned entries match; the 16 non-matches are null-class entries like the Idris
// tail turret, and Valkyrie door guns) — entries without a class_name cannot be
// joined and are dropped. `display_name` is a machine label ("port_NameTurret04",
// "PDT 1"); no human mount label exists in these entries, so the UI keeps the
// component name as the heading. Entries with zero weapons (empty/unslotted mounts,
// Reclaimer salvage arms) carry no display info and are dropped. Weapons are
// deduped by name with counts — T24 shape `{name, size, dps, alpha, count}`:
// the UI renders one indented sub-line per weapon ("S4 KLWE LaserRepeater S4 —
// alpha 42 / 110 dps", counts aggregated to "CF-447 Rhino Repeater ×4"). dps is
// summed across the repeated entries (per-gun API values), alpha = max. Weapon
// size: API entry-level `weapon_sizes` array (100% populated fleet-wide, 37/274
// name-token mismatches) aligned to the ordered `weapons[]` list; absent/short →
// `S<n>` token in the name, else null (declared heuristic). Deviation from the
// original plan: manned-only →
// manned+remote+pdc, because the user-facing example ships (Avenger line) have
// EMPTY turret arrays entirely (their gimbal-mount guns ride in
// weaponry.fixed_weapons with NO per-mount mapping in the API — unjoinable, UI
// keeps the plain row there; declared gap).
function weaponEntrySize(name, idx, sizes) {
  if (Number.isInteger(sizes?.[idx])) return sizes[idx];
  const token = name.match(/\bS(\d{1,2})\b/i);
  return token ? Number(token[1]) : null;
}

function turretMountsOf(ship) {
  const out = [];
  for (const [kind, arr] of [['manned', ship.turrets?.manned], ['remote', ship.turrets?.remote], ['pdc', ship.turrets?.pdc]]) {
    for (const t of arr ?? []) {
      if (!t.class_name) continue;
      const sizes = Array.isArray(t.weapon_sizes) ? t.weapon_sizes : null;
      const byName = new Map();
      // Index into the RAW weapons[] (weapon_sizes aligns to it 1:1, probed
      // 2026-10-23), skipping nameless entries without shifting the size index.
      for (const [i, w] of (t.weapons ?? []).entries()) {
        const name = w?.name;
        if (!name) continue;
        const cur = byName.get(name);
        if (cur) {
          cur.count += 1;
          cur.dps += num(w.dps, 0);
          cur.alpha = Math.max(cur.alpha, num(w.alpha, 0));
        } else {
          byName.set(name, {
            name,
            size: weaponEntrySize(name, i, sizes),
            dps: num(w.dps, 0),
            alpha: num(w.alpha, 0),
            count: 1,
          });
        }
      }
      if (byName.size === 0) continue;
      out.push({
        mount: t.display_name ?? t.class_name,
        className: t.class_name,
        kind,
        weapons: [...byName.values()],
      });
    }
  }
  return out;
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
      const damageType = damageTypeFor(label, w.dps);
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
    const damageType = damageTypeFor(label, num(t.weapons?.[0]?.dps, 0));
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
    turretMounts: turretMountsOf(ship),
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
const withMounts = ships.filter((s) => s.turretMounts.length > 0).length;
const mountsByKind = {};
for (const s of ships) for (const m of s.turretMounts) mountsByKind[m.kind] = (mountsByKind[m.kind] ?? 0) + 1;
const bySize = {};
for (const s of ships) bySize[s.sizeClass] = (bySize[s.sizeClass] ?? 0) + 1;
console.log(`wrote ${OUT_FILE}: ${ships.length} ships | unarmed-filtered=${unarmed} | images=${withImages} | manned-turret ships=${withTurrets} | turretMounts ships=${withMounts} entries=${JSON.stringify(mountsByKind)} | sizes=${JSON.stringify(bySize)}`);

// Damage-type join report (authoritative cache → name-regex fallback for unjoinable labels).
const typeCounts = {};
for (const s of ships) for (const w of s.weapons) typeCounts[w.damageType] = (typeCounts[w.damageType] ?? 0) + 1;
console.log(`weapon damageTypes: ${JSON.stringify(typeCounts)}`);
console.log(`damage-type regex fallbacks (unjoinable labels): ${typeFallbacks.size} names / ${[...typeFallbacks.values()].reduce((t, n) => t + n, 0)} weapons${typeFallbacks.size ? ': ' + [...typeFallbacks.keys()].join(', ') : ''}`);
if (typeAmbiguous.size) console.log(`WARN ambiguous display names (multi-type, dps join missed, took first variant): ${[...typeAmbiguous.entries()].map(([n, c]) => `${n}×${c}`).join(', ')}`);

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
const gradeDist = {};
const clsDist = {};
for (const s of ships) for (const c of s.components) {
  gradeDist[c.grade ?? '?'] = (gradeDist[c.grade ?? '?'] ?? 0) + 1;
  clsDist[c.cls ?? '?'] = (clsDist[c.cls ?? '?'] ?? 0) + 1;
}
console.log(`component grades: ${JSON.stringify(gradeDist)}`);
console.log(`component classes: ${JSON.stringify(clsDist)}`);
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
