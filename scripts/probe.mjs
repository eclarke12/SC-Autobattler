import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://api.star-citizen.wiki/api';
const OUT = 'probe/out';
mkdirSync(OUT, { recursive: true });

const report = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  report.push(line);
  console.log(line);
};
const save = (name, obj) => writeFileSync(`${OUT}/${name}`, JSON.stringify(obj, null, 2));

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function fetchAllPages(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  let url = `${BASE}/${path}${qs ? '?' + qs : ''}`;
  const items = [];
  const pageMeta = [];
  let pages = 0;
  while (url && pages < 80) {
    const json = await getJson(url);
    items.push(...json.data);
    pageMeta.push({ from: json.meta?.from, to: json.meta?.to, total: json.meta?.total });
    url = json.links?.next ?? null;
    pages++;
  }
  return { items, pages, pageMeta };
}

function findPaths(obj, pred, path = '', out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  if (pred(obj)) out.push(path);
  for (const [k, v] of Object.entries(obj)) {
    findPaths(v, pred, path ? `${path}.${k}` : k, out, depth + 1);
  }
  return out;
}

function keysOf(o) {
  return o && typeof o === 'object' ? Object.keys(o) : null;
}

say('=== PROBE START ===');

// 1. All vehicles, no filters
const all = await fetchAllPages('vehicles');
say(`[1] /api/vehicles no-filter: ${all.items.length} items in ${all.pages} pages`);
say(`[1] pageMeta sample: ${JSON.stringify(all.pageMeta.slice(0, 3))}`);
save('vehicles-all.json', all.items);

// 2. Size class filter totals
for (const sc of ['small', 'medium', 'large', 'core']) {
  const j = await getJson(`${BASE}/vehicles?filter[size_class]=${sc}&filter[is_spaceship]=1&limit=1`);
  say(`[2] size_class=${sc} is_spaceship=1 => meta.total=${j.meta?.total}`);
}

// 3. Representative ships per size class (spaceships)
const reps = {};
for (const sc of ['small', 'medium', 'large', 'core']) {
  const j = await getJson(`${BASE}/vehicles?filter[size_class]=${sc}&filter[is_spaceship]=1&limit=3`);
  if (j.data.length) reps[sc] = j.data[0];
}
save('vehicles-representative.json', reps);
say(`[3] representatives: ${Object.entries(reps).map(([k, v]) => `${k}=${v.name}`).join(', ')}`);

for (const [sc, ship] of Object.entries(reps)) {
  say(`--- REP ${sc}: ${ship.name} (uuid=${ship.uuid}) ---`);
  say(`[3.${sc}] list-item keys: ${JSON.stringify(keysOf(ship))}`);
  say(`[3.${sc}] armor subkeys: ${JSON.stringify(keysOf(ship.armor))}`);
  say(`[3.${sc}] armor value: ${JSON.stringify(ship.armor)}`);
  say(`[3.${sc}] health=${ship.health} shield.hp=${ship.shield?.hp} shield.regeneration=${ship.shield?.regeneration} shield.regeneration_time=${ship.shield?.regeneration_time} face_type=${ship.shield?.face_type}`);
  say(`[3.${sc}] class_name=${JSON.stringify(ship.class_name)} sizes=${JSON.stringify(ship.sizes)}`);
  say(`[3.${sc}] crew=${JSON.stringify(ship.crew)}`);
  say(`[3.${sc}] power=${JSON.stringify(ship.power)}`);
  say(`[3.${sc}] cooling=${JSON.stringify(ship.cooling)}`);
  say(`[3.${sc}] cross_section=${JSON.stringify(ship.cross_section)}`);
  say(`[3.${sc}] speed=${JSON.stringify(ship.speed)}`);

  const dpsPaths = findPaths(ship, (o) => 'dps' in o).slice(0, 12);
  say(`[3.${sc}] paths containing 'dps': ${JSON.stringify(dpsPaths)}`);

  // Where do components live?
  const compPaths = findPaths(ship, (o) => 'type' in o && 'dps' in o).slice(0, 4);
  for (const p of compPaths) {
    const val = p.split('.').reduce((o, k) => o?.[k], ship);
    say(`[3.${sc}] component@${p} = ${JSON.stringify(val)}`);
  }

  // Detail endpoint (uuid) — does it embed full components?
  try {
    const det = await getJson(`${BASE}/vehicles/${ship.uuid}`);
    const d = det.data ?? det;
    say(`[3.${sc}] detail keys: ${JSON.stringify(keysOf(d))}`);
    save(`vehicle-detail-${sc}.json`, d);
    const compKey = keysOf(d)?.find((k) => k.includes('component'));
    if (compKey) {
      const comps = d[compKey];
      const arr = Array.isArray(comps) ? comps : keysOf(comps)?.map((k) => comps[k]);
      say(`[3.${sc}] detail.${compKey}: count=${Array.isArray(arr) ? arr.length : 'n/a'} firstKeys=${JSON.stringify(keysOf(arr?.[0]))}`);
      const weapons = (Array.isArray(arr) ? arr : []).filter((c) => c?.type && c.type !== 'Utility');
      const typeHist = {};
      for (const w of weapons) typeHist[w.type] = (typeHist[w.type] ?? 0) + 1;
      say(`[3.${sc}] detail component type histogram: ${JSON.stringify(typeHist)}`);
      const sampleWeapon = weapons.find((w) => 'dps' in w) ?? weapons[0];
      say(`[3.${sc}] sample weapon component: ${JSON.stringify(sampleWeapon)}`);
    }
  } catch (e) {
    say(`[3.${sc}] detail endpoint error: ${e.message}`);
  }
}

// 4. Fleet-wide regen sanity: regeneration vs regeneration_time distribution
const regens = all.items
  .filter((s) => s.shield?.regeneration != null && s.shield?.regeneration_time != null)
  .map((s) => ({ name: s.name, regen: s.shield.regeneration, rt: s.shield.regeneration_time, shp: s.shield.hp }))
  .slice(0, 15);
say(`[4] regen samples (name, regen, regen_time, shieldHp): ${JSON.stringify(regens, null, 0)}`);

// 5. Fleet-wide: where are weapons embedded in LIST payload?
const withDps = all.items.filter((s) => findPaths(s, (o) => 'dps' in o).length > 0).length;
say(`[5] list ships with any 'dps' anywhere: ${withDps}/${all.items.length}`);
const listPaths = all.items.slice(0, 5).map((s) => findPaths(s, (o) => 'dps' in o).slice(0, 3));
say(`[5] example dps paths in list items: ${JSON.stringify(listPaths)}`);

// 6. class_name distinct values (for size derivation fallback)
const classNames = {};
for (const s of all.items) classNames[s.class_name?.name ?? s.class_name ?? 'null'] = (classNames[s.class_name?.name ?? s.class_name ?? 'null'] ?? 0) + 1;
say(`[6] class_name histogram: ${JSON.stringify(classNames)}`);

// 7. Ship matrix for images
const matrix = await getJson(`${BASE}/ship-matrix/vehicles`);
save('ship-matrix.json', matrix);
say(`[7] /api/ship-matrix/vehicles: topKeys=${JSON.stringify(keysOf(matrix))}`);
const mArr = Array.isArray(matrix) ? matrix : matrix.data;
say(`[7] matrix count=${mArr?.length} firstKeys=${JSON.stringify(keysOf(mArr?.[0]))}`);
say(`[7] matrix sample[0]=${JSON.stringify(mArr?.[0]).slice(0, 1200)}`);
const imgPaths = findPaths(mArr?.[0] ?? {}, (o) => Object.keys(o).some((k) => /img|image|photo|thumb|screenshot/i.test(k))).slice(0, 8);
say(`[7] image-ish paths in matrix[0]: ${JSON.stringify(imgPaths)}`);

writeFileSync(`${OUT}/report.txt`, report.join('\n'));
say('=== PROBE DONE: artifacts in probe/out/ (pretty-printed) ===');
