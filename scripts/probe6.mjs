// [GC8] Component power graph feasibility (probe 6):
// ship.ports tree -> equipped_item class_names -> /items/{class_name}.usage.power {min,max}
// Validate: per-ship Σmax vs used_segments_grouped, Σmin vs generation_segments, coverage.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://api.star-citizen.wiki/api';
const OUT = 'probe/out/gc8-components.json';
const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const snap = JSON.parse(readFileSync('probe/out/vehicles-all.json', 'utf8'));
const ships = snap.filter((s) => s.is_spaceship);

const POWER_TYPES = new Set(['Shield', 'Cooler', 'Radar', 'FlightController', 'LifeSupportGenerator', 'TractorBeam', 'WeaponMining', 'SalvageHead', 'TowingBeam', 'WeaponGun', 'QuantumInterdictionGenerator', 'EMP', 'UtilityTurret', 'ToolArm', 'QuantumDrive', 'Module']);
const cacheFile = 'probe/out/component-power-cache.json';
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};

function collectPorts(n, out = []) {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const x of n) collectPorts(x, out); return out; }
  if (n.equipped_item && typeof n.equipped_item === 'object') out.push(n.equipped_item);
  for (const v of Object.values(n)) collectPorts(v, out);
  return out;
}

const perShip = new Map();
const uniq = new Set();
for (const s of ships) {
  const items = collectPorts(s.ports).filter((it) => POWER_TYPES.has(it.type) && it.class_name);
  perShip.set(s.uuid, items.map((it) => ({ type: it.type, cn: it.class_name, name: it.name })));
  for (const it of items) uniq.add(it.cn);
}
say(`[GC8] ${ships.length} spaceships; component ports (power-type): ${[...perShip.values()].reduce((a, v) => a + v.length, 0)}; unique class_names: ${uniq.size}`);

const sample = ships.filter((s) => (perShip.get(s.uuid) || []).length >= 5);
const pick = [sample[0], sample[Math.floor(sample.length * 0.13)], sample[Math.floor(sample.length * 0.3)], sample[Math.floor(sample.length * 0.5)], sample[Math.floor(sample.length * 0.7)], sample[Math.floor(sample.length * 0.9)]];
say(`[GC8] sample ships: ${pick.map((s) => s.name).join(', ')}`);

async function getItem(cn) {
  if (cache[cn] !== undefined) return cache[cn];
  const r = await fetch(`${BASE}/items/${encodeURIComponent(cn)}`);
  if (!r.ok) { cache[cn] = null; return null; }
  const j = await r.json();
  const it = j.data ?? j;
  const rn = it.resource_network ?? {};
  const usage = rn.usage?.power ?? null;
  const gen = rn.generation?.power ?? null;
  const deltas = (rn.states ?? []).flatMap((st) => (st.deltas ?? []).filter((d) => d.resource === 'Power').map((d) => ({ type: d.type, rate: d.rate, mf: d.minimum_fraction, gen: d.generated_resource, grate: d.generated_rate })));
  cache[cn] = { usage, gen, deltas, type: it.type, networked: rn.is_networked ?? null };
  return cache[cn];
}

for (const s of pick) {
  const comps = perShip.get(s.uuid);
  const rows = [];
  for (const c of comps) {
    const d = await getItem(c.cn);
    rows.push({ type: c.type, name: c.name, usage: d?.usage ?? null, deltas: d?.deltas ?? null, gen: d?.gen ?? null });
  }
  const sumMax = rows.reduce((a, r) => a + (r.usage?.max ?? 0), 0);
  const sumMin = rows.reduce((a, r) => a + (r.usage?.min ?? 0), 0);
  const g = s.power?.used_segments_grouped ?? {};
  const gSum = Object.values(g).reduce((a, v) => a + v, 0);
  const gNoShield = gSum - (g.Shield ?? 0);
  say(`[GC8] ${s.name}: gen=${s.power?.generation_segments} Σmax=${sumMax} Σmin=${sumMin} groupedSum=${Math.round(gSum * 10) / 10} (grouped−Shield=${Math.round(gNoShield * 10) / 10}) used_shields=${s.power?.used_segments_shields}`);
  say(`[GC8]   comps: ${JSON.stringify(rows)}`);
}

// Fleet-wide aggregate over all spaceships: min vs generation, max vs grouped.
let done = 0;
const noUsage = new Map();
let sumMinOverGen = 0, maxSumMatch = 0, maxVsGrouped = [], shipRows = [];
for (const s of ships) {
  const comps = perShip.get(s.uuid);
  let sumMin = 0, sumMax = 0, missing = 0;
  for (const c of comps) {
    const d = await getItem(c.cn);
    if (d?.usage?.max != null) { sumMax += d.usage.max; sumMin += d.usage.min; }
    else { missing++; noUsage.set(c.type, (noUsage.get(c.type) ?? 0) + 1); }
  }
  const g = s.power?.used_segments_grouped ?? {};
  const gSum = Object.values(g).reduce((a, v) => a + v, 0);
  const gNoGun = gSum - (g.WeaponGun ?? 0);
  if (Math.abs(sumMax - gNoGun) < 0.05) maxSumMatch++;
  if (sumMin > s.power?.generation_segments) sumMinOverGen++;
  maxVsGrouped.push(sumMax - gNoGun);
  shipRows.push({ name: s.name, gen: s.power?.generation_segments, min: sumMin, max: sumMax, gNoGun: Math.round(gNoGun * 10) / 10, missing });
  if (++done % 60 === 0) say(`[GC8] aggregate progress ${done}/${ships.length} (unique items ${Object.keys(cache).length})`);
}
say(`[GC8] FLEET: Σmax==grouped−WeaponGun on ${maxSumMatch}/${ships.length} ships; Σmin>generation on ${sumMinOverGen}/${ships.length} ships`);
say(`[GC8] items without usage.power by type: ${JSON.stringify([...noUsage.entries()])}`);
const fr = maxVsGrouped.map((v) => Math.abs(v));
fr.sort((a, b) => a - b);
say(`[GC8] |Σmax−(grouped−gun)| p50=${fr[Math.floor(fr.length / 2)]} p90=${fr[Math.floor(fr.length * 0.9)]} max=${fr[fr.length - 1]}`);
writeFileSync(OUT, JSON.stringify(shipRows, null, 1));
say(`[GC8] wrote ${OUT} (${shipRows.length} ships)`);

writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
say(`[GC8] cache written: ${Object.keys(cache).length} items`);
