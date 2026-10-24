// Authoritative gun damage-type import (replaces the name-regex classifier in
// build-data.mjs, which misclassified "M7A Cannon" as ballistic — it is
// BEHR_LaserCannon_S5, an energy weapon; see docs/data-notes.md §4).
// Walks /api/items?filter[type]=WeaponGun (paginated) and extracts each gun's
// per-type dps from `vehicle_weapon.damage.dps` — the API's ground truth for
// damage type. Writes data/weapon-damage-cache.json keyed by lowercase display
// name; each name carries ALL API variants sharing that name (the display name
// "M9A Cannon" spans an S12 mass driver (physical), S7–S9 laser cannons
// (energy), and a Javelin S7 ballistic cannon (physical)), so build-data.mjs
// disambiguates per weapon with the ship payload's per-gun dps.
// Incremental: cached keys are skipped; run repeatedly with --maxSeconds until "remaining: 0".
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

const BASE = 'https://api.star-citizen.wiki/api';
const OUT = 'data/weapon-damage-cache.json';
const DELAY_MS = 100;
const DAMAGE_TYPES = ['physical', 'energy', 'distortion', 'thermal', 'biochemical', 'stun'];
const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

function maxSeconds() {
  const i = process.argv.indexOf('--maxSeconds');
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, 10), 115) : 100;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const variantSchema = z.object({
  className: z.string().min(1),
  damageType: z.enum(DAMAGE_TYPES).nullable(),
  dps: z.record(z.enum(DAMAGE_TYPES), z.number()),
});
const entrySchema = z.object({
  name: z.string().min(1),
  variants: z.array(variantSchema).min(1),
});
const cacheSchema = z.record(entrySchema);

function dominantType(dps) {
  let best = null;
  let bv = 0;
  for (const t of DAMAGE_TYPES) {
    const v = typeof dps?.[t] === 'number' && Number.isFinite(dps[t]) ? dps[t] : 0;
    if (v > bv) { bv = v; best = t; }
  }
  return best;
}

function entryOf(gun) {
  const vw = gun.vehicle_weapon ?? {};
  const dps = {};
  for (const t of DAMAGE_TYPES) dps[t] = typeof vw.damage?.dps?.[t] === 'number' ? vw.damage.dps[t] : 0;
  return {
    className: gun.class_name ?? gun.slug ?? gun.name,
    damageType: dominantType(dps),
    dps,
  };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function fetchAllGuns() {
  let url = `${BASE}/items?filter%5Btype%5D=WeaponGun`;
  const guns = [];
  let pages = 0;
  while (url && pages < 40) {
    const json = await getJson(url);
    guns.push(...json.data);
    url = json.links?.next ?? null;
    pages++;
    await sleep(DELAY_MS);
  }
  return { guns, pages };
}

const budgetMs = maxSeconds() * 1000;
const t0 = Date.now();

const cache = existsSync(OUT) ? cacheSchema.parse(JSON.parse(readFileSync(OUT, 'utf8'))) : {};

const { guns, pages } = await fetchAllGuns();
say(`fetched ${guns.length} WeaponGun items across ${pages} pages`);
if (guns.length === 0) {
  console.error(`FATAL: 0 WeaponGun items from the API — list shape change? Refusing to write ${OUT}.`);
  process.exit(1);
}

let added = 0;
let updated = 0;
for (const g of guns) {
  if (Date.now() - t0 > budgetMs) { say(`budget exhausted after ${added + updated} merges`); break; }
  const key = (g.name ?? '').trim().toLowerCase();
  if (!key) continue;
  const v = entryOf(g);
  const cur = cache[key];
  if (!cur) {
    cache[key] = { name: g.name, variants: [v] };
    added++;
  } else if (!cur.variants.some((x) => x.className === v.className)) {
    cur.variants.push(v);
    updated++;
  }
}

const typed = Object.values(cache).map((e) => e.variants.map((v) => v.damageType).filter(Boolean));
const multi = Object.values(cache).filter((e) => new Set(e.variants.map((v) => v.damageType).filter(Boolean)).size > 1);
const nullType = Object.values(cache).filter((e) => e.variants.every((v) => v.damageType === null));
say(`cache: ${Object.keys(cache).length} names (+${added} new, +${updated} new variants) | names w/ >1 distinct type: ${multi.length} ${JSON.stringify(multi.map((e) => e.name))} | names w/ all-null dps: ${nullType.length} ${JSON.stringify(nullType.map((e) => e.name))}`);

const out = cacheSchema.parse(cache);
writeFileSync(OUT, JSON.stringify(out, null, 1));
say(`wrote ${OUT}: ${Object.keys(out).length} names, ${Object.values(out).reduce((t, e) => t + e.variants.length, 0)} variants`);
