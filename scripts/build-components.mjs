// [T17] Component power import pipeline (generalizes scripts/probe6.mjs):
// walk every spaceship's ports tree -> ALL equipped_item class_names -> /items/{class_name}
// -> data/components-cache.json {type, power{minOnline,fullDraw}, coolant{…}, generation{power,coolant}}.
// Incremental: cached keys are skipped; run repeatedly with --maxSeconds budget until "remaining: 0".
// Retry policy (L1): a failed fetch is cached as a `{error, attempts}` sentinel, never bare `null`;
// sentinels and legacy nulls count as "remaining" and are retried until attempts >= 3 (then settled,
// counted as null in the COMPLETE report). build-data.mjs (T18) hard-exits when a power-relevant
// component (Shield/Cooler/Radar/FlightController/LifeSupportGenerator/QuantumDrive) joins through
// a sentinel, null, or missing cache entry.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://api.star-citizen.wiki/api';
const SNAPSHOT = 'probe/out/vehicles-all.json';
const CACHE = 'data/components-cache.json';
const SEED = 'probe/out/component-power-cache.json';
const DELAY_MS = 100;
const CONC = 4; // concurrent item fetches per wave (~rate-limits to the API's polite band)
const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

function maxSeconds() {
  const i = process.argv.indexOf('--maxSeconds');
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.min(Math.max(v, 10), 115) : 100;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collectPorts(n, out = []) {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const x of n) collectPorts(x, out); return out; }
  if (n.equipped_item && typeof n.equipped_item === 'object') out.push(n.equipped_item);
  for (const v of Object.values(n)) collectPorts(v, out);
  return out;
}

const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const ships = snap.filter((s) => s.is_spaceship);

const uniq = new Map();
let portCount = 0;
for (const s of ships) {
  for (const it of collectPorts(s.ports)) {
    if (!it.class_name) continue;
    portCount++;
    if (!uniq.has(it.class_name)) uniq.set(it.class_name, it.type ?? null);
  }
}
say(`[T17] ${ships.length} spaceships; ${portCount} equipped_item ports; ${uniq.size} unique class_names`);

function migrate(old) {
  if (old === null) return null;
  return {
    type: old.type ?? null,
    power: old.usage ? { minOnline: old.usage.min, fullDraw: old.usage.max } : null,
    coolant: null,
    generation: { power: old.gen ?? null, coolant: null },
  };
}

const MAX_FETCH_ATTEMPTS = 3;
const isFailed = (e) => e !== null && typeof e === 'object' && typeof e.error === 'string';
const priorAttempts = (e) => (isFailed(e) ? e.attempts : e === null ? 1 : 0);
// Cache entries predating the grade/class join (2026-10-24) lack the `cls` key —
// treated as needing a re-fetch to enrich them (like legacy nulls).
const lacksEnrichment = (e) => e !== null && typeof e === 'object' && !isFailed(e) && !('cls' in e);
function needsWork(e) {
  if (e === undefined) return true;
  if (e === null) return true;
  if (lacksEnrichment(e)) return true;
  return isFailed(e) && e.attempts < MAX_FETCH_ATTEMPTS;
}

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
if (!existsSync(CACHE) && existsSync(SEED)) {
  const seed = JSON.parse(readFileSync(SEED, 'utf8'));
  for (const [cn, e] of Object.entries(seed)) if (needsWork(cache[cn])) cache[cn] = migrate(e);
  say(`[T17] migrated ${Object.keys(seed).length} probe cache entries from ${SEED}`);
}

function entryOf(it) {
  const rn = it.resource_network ?? {};
  return {
    type: it.type ?? null,
    grade: typeof it.grade === 'string' ? it.grade : null,
    cls: typeof it.class === 'string' ? it.class : null,
    power: rn.usage?.power ? { minOnline: rn.usage.power.min, fullDraw: rn.usage.power.max } : null,
    coolant: rn.usage?.coolant ? { minOnline: rn.usage.coolant.min, fullDraw: rn.usage.coolant.max } : null,
    generation: {
      power: rn.generation?.power ?? it.power_plant?.power_segment_generation ?? null,
      coolant: rn.generation?.coolant ?? it.cooler?.coolant_segment_generation ?? null,
    },
  };
}

async function fetchItem(cn) {
  const url = `${BASE}/items/${encodeURIComponent(cn)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return entryOf(await r.json().then((j) => j.data ?? j));
    } catch {}
    if (attempt === 0) await sleep(500);
  }
  return null;
}

const budgetMs = maxSeconds() * 1000;
const t0 = Date.now();
const todo = [...uniq.keys()].filter((cn) => needsWork(cache[cn]));
say(`[T17] cached ${Object.keys(cache).length}; to fetch ${todo.length} (budget ${budgetMs / 1000}s)`);

let fetched = 0, failed = 0;
// Fetch in waves of CONC (the 2026-10-24 full-cache enrichment pass made the serial
// ~1.6 req/s loop a 10-minute multi-run job; waves cut it ~4x). Per-key bookkeeping,
// budget check, and periodic writes are unchanged.
for (let k = 0; k < todo.length; k += CONC) {
  if (Date.now() - t0 > budgetMs) { say(`[T17] budget exhausted`); break; }
  const batch = todo.slice(k, k + CONC);
  const results = await Promise.all(batch.map(fetchItem));
  for (const [j, cn] of batch.entries()) {
    const e = results[j];
    if (e === null) {
      failed++;
      cache[cn] = { error: 'fetch_failed', attempts: Math.min(priorAttempts(cache[cn]) + 1, MAX_FETCH_ATTEMPTS) };
    } else {
      cache[cn] = e;
    }
    fetched++;
  }
  if (fetched % 25 < CONC) {
    writeFileSync(CACHE, JSON.stringify(cache, null, 1));
    say(`[T17] progress ${fetched}/${todo.length} (failed ${failed})`);
  }
  await sleep(DELAY_MS);
}
writeFileSync(CACHE, JSON.stringify(cache, null, 1));

const remaining = [...uniq.keys()].filter((cn) => needsWork(cache[cn])).length;
say(`[T17] this run: fetched ${fetched} (failed->sentinel ${failed}); cache ${Object.keys(cache).length} items; remaining ${remaining}`);

if (remaining === 0) {
  const byTypePorts = new Map();
  const byTypeItems = new Map();
  for (const [cn, type] of uniq) {
    const e = cache[cn];
    const t = type ?? 'unknown';
    if (!e || e.power == null) byTypeItems.set(t, (byTypeItems.get(t) ?? 0) + 1);
  }
  for (const s of ships) {
    for (const it of collectPorts(s.ports)) {
      if (!it.class_name) continue;
      const e = cache[it.class_name];
      const t = it.type ?? 'unknown';
      if (!e || e.power == null) byTypePorts.set(t, (byTypePorts.get(t) ?? 0) + 1);
    }
  }
  const nulls = Object.values(cache).filter((e) => e === null || isFailed(e)).length;
  say(`[T17] COMPLETE: unique ${uniq.size}; fetched (cumulative non-null) ${Object.keys(cache).length - nulls}; null entries (null/failed-settled) ${nulls}`);
  say(`[T17] ports missing power by type: ${JSON.stringify([...byTypePorts.entries()])}`);
  say(`[T17] items missing power by type: ${JSON.stringify([...byTypeItems.entries()])}`);
} else {
  say(`[T17] INCOMPLETE: re-run "node scripts/build-components.mjs" (remaining ${remaining})`);
}
