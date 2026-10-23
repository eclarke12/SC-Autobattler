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

// 7. Ship matrix for images (endpoint is dead 404 per docs/data-notes.md — non-fatal)
try {
  const matrix = await getJson(`${BASE}/ship-matrix/vehicles`);
  save('ship-matrix.json', matrix);
  say(`[7] /api/ship-matrix/vehicles: topKeys=${JSON.stringify(keysOf(matrix))}`);
  const mArr = Array.isArray(matrix) ? matrix : matrix.data;
  say(`[7] matrix count=${mArr?.length} firstKeys=${JSON.stringify(keysOf(mArr?.[0]))}`);
  say(`[7] matrix sample[0]=${JSON.stringify(mArr?.[0]).slice(0, 1200)}`);
  const imgPaths = findPaths(mArr?.[0] ?? {}, (o) => Object.keys(o).some((k) => /img|image|photo|thumb|screenshot/i.test(k))).slice(0, 8);
  say(`[7] image-ish paths in matrix[0]: ${JSON.stringify(imgPaths)}`);
} catch (e) {
  say(`[7] /api/ship-matrix/vehicles: ${e.message} (known dead endpoint, continuing)`);
}

// ============ GAP-CLOSURE PROBES (2026-10-22) ============
// Findings land in docs/data-notes.md "Gap-closure probe" section.
const spaceships = all.items.filter((s) => s.is_spaceship);

function collectPorts(ports, out = []) {
  for (const p of ports || []) {
    out.push(p);
    collectPorts(p.ports, out);
  }
  return out;
}
function ammoLikeKeys(o) {
  return o && typeof o === 'object'
    ? Object.keys(o).filter((k) => /ammo|charge|clip|capacity|magazine/i.test(k)).map((k) => `${k}=${JSON.stringify(o[k])}`)
    : [];
}
const dist = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], p25: s[Math.floor(s.length * 0.25)], median: s[Math.floor(s.length / 2)], p75: s[Math.floor(s.length * 0.75)], max: s[s.length - 1] };
};

// [GC1] alpha coverage (A3 input): fixed weapons + manned turret mounts with alpha 0/missing
{
  let fixedTotal = 0, fixedMissing = 0, turretTotal = 0, turretMissing = 0;
  const samples = [];
  for (const s of spaceships) {
    for (const w of s.weaponry?.fixed_weapons?.weapons ?? []) {
      fixedTotal++;
      if (w.alpha == null || w.alpha === 0) {
        fixedMissing++;
        if (samples.length < 12) samples.push({ ship: s.name, weapon: w.name, alpha: w.alpha ?? null, dps: w.dps });
      }
    }
    for (const t of s.turrets?.manned ?? []) {
      for (const w of t.weapons ?? []) {
        turretTotal++;
        if (w.alpha == null || w.alpha === 0) turretMissing++;
      }
    }
  }
  say(`[GC1] alpha coverage (spaceships): fixed ${fixedMissing}/${fixedTotal} alpha 0-or-missing; turret-mount ${turretMissing}/${turretTotal}`);
  save('gc1-alpha.json', { fixedTotal, fixedMissing, turretTotal, turretMissing, samples });
}

// [GC2] per-weapon ammo (W4 input): ammo_capacity/ammo_type presence on fixed + manned turret weapons
{
  const fixedWithAmmo = [], turretWithAmmo = [];
  const fixedKeys = new Map(), turretKeys = new Map();
  let fixedTotal = 0, turretTotal = 0;
  for (const s of spaceships) {
    for (const w of s.weaponry?.fixed_weapons?.weapons ?? []) {
      fixedTotal++;
      for (const k of Object.keys(w)) fixedKeys.set(k, (fixedKeys.get(k) ?? 0) + 1);
      const am = ammoLikeKeys(w);
      if (am.length) fixedWithAmmo.push({ ship: s.name, weapon: w.name, fields: am });
    }
    for (const t of s.turrets?.manned ?? []) {
      for (const w of t.weapons ?? []) {
        turretTotal++;
        for (const k of Object.keys(w)) turretKeys.set(k, (turretKeys.get(k) ?? 0) + 1);
        const am = ammoLikeKeys(w);
        if (am.length) turretWithAmmo.push({ ship: s.name, weapon: w.name, fields: am });
      }
    }
  }
  say(`[GC2] per-weapon ammo: fixed ${fixedWithAmmo.length}/${fixedTotal} entries carry ammo-like fields; turret ${turretWithAmmo.length}/${turretTotal}`);
  say(`[GC2] fixed weapon entry key histogram: ${JSON.stringify(Object.fromEntries(fixedKeys))}`);
  say(`[GC2] turret weapon entry key histogram: ${JSON.stringify(Object.fromEntries(turretKeys))}`);
  say(`[GC2] fixed ammo samples: ${JSON.stringify(fixedWithAmmo.slice(0, 8))}`);
  save('gc2-ammo.json', { fixedTotal, turretTotal, fixedWithAmmo, turretWithAmmo, fixedKeys: Object.fromEntries(fixedKeys), turretKeys: Object.fromEntries(turretKeys) });
}

// [GC3] decoy charges (C5 input): WeaponDefensive launcher items — model names + charge-count fields
{
  const byModel = new Map();
  const itemKeys = new Map();
  let total = 0, withAmmo = 0;
  for (const s of spaceships) {
    for (const p of collectPorts(s.ports)) {
      const it = p.equipped_item;
      if (it?.type !== 'WeaponDefensive') continue;
      total++;
      for (const k of Object.keys(it)) itemKeys.set(k, (itemKeys.get(k) ?? 0) + 1);
      const hay = `${it.name ?? ''} ${it.class_name ?? ''}`.toLowerCase();
      const kind = /decoy|flare/.test(hay) ? 'decoy' : /noise|chaff/.test(hay) ? 'noise' : 'other';
      const model = it.name ?? 'unknown';
      const am = ammoLikeKeys(it);
      if (am.length) withAmmo++;
      if (!byModel.has(model)) byModel.set(model, { kind, count: 0, sample: it, ammoFieldSamples: [] });
      const e = byModel.get(model);
      e.count++;
      if (am.length && e.ammoFieldSamples.length < 3) e.ammoFieldSamples.push({ ship: s.name, fields: am });
    }
  }
  say(`[GC3] WeaponDefensive items: ${total} across ${spaceships.length} ships; ${withAmmo} carry ammo/charge-like fields`);
  say(`[GC3] item key histogram: ${JSON.stringify(Object.fromEntries(itemKeys))}`);
  for (const [model, e] of byModel) say(`[GC3] model "${model}" (${e.kind}): n=${e.count} ammoSamples=${JSON.stringify(e.ammoFieldSamples.slice(0, 2))}`);
  save('gc3-decoys.json', { total, withAmmo, itemKeys: Object.fromEntries(itemKeys), models: Object.fromEntries(byModel) });
}

// [GC4] bomb racks (O4 input): hardpoint equipped_item.type histogram + ships with bomb-like ports
{
  const typeHist = new Map();
  const bombShips = [];
  for (const s of spaceships) {
    for (const p of collectPorts(s.ports)) {
      const it = p.equipped_item;
      const t = it?.type ?? '(empty port)';
      typeHist.set(t, (typeHist.get(t) ?? 0) + 1);
      const hay = `${it?.name ?? ''} ${it?.class_name ?? ''} ${it?.type ?? ''}`.toLowerCase();
      if (/bomb/.test(hay)) bombShips.push({ ship: s.name, type: it?.type, name: it?.name, class_name: it?.class_name, size: it?.size });
    }
  }
  say(`[GC4] hardpoint equipped_item.type histogram (spaceships, all ports): ${JSON.stringify(Object.fromEntries(typeHist))}`);
  say(`[GC4] bomb-like ports found: ${bombShips.length} on ${new Set(bombShips.map((b) => b.ship)).size} ships`);
  say(`[GC4] bomb samples: ${JSON.stringify(bombShips.slice(0, 10))}`);
  save('gc4-bombs.json', { typeHist: Object.fromEntries(typeHist), bombShips });
}

// [GC5] distortion (O3 input): shield.absorption.distortion range fleet-wide + Quantum-named racks
{
  const absMax = [], absMin = [], resMax = [], resMin = [];
  const nonzero = [];
  for (const s of spaceships) {
    const a = s.shield?.absorption?.distortion;
    const r = s.shield?.resistance?.distortion;
    absMin.push(a?.minimum ?? 0); absMax.push(a?.maximum ?? 0);
    resMin.push(r?.minimum ?? 0); resMax.push(r?.maximum ?? 0);
    if ((a?.maximum ?? 0) > 0) nonzero.push({ ship: s.name, absorption: a, resistance: r });
  }
  const quantum = [];
  for (const s of spaceships) {
    for (const p of collectPorts(s.ports)) {
      const it = p.equipped_item;
      if (!it) continue;
      const hay = `${it.name ?? ''} ${it.class_name ?? ''}`.toLowerCase();
      if (it.type === 'MissileLauncher' && /quantum/.test(hay)) quantum.push({ ship: s.name, name: it.name, class_name: it.class_name, size: it.size });
    }
  }
  say(`[GC5] shield.absorption.distortion ${JSON.stringify(dist(absMax))} mins ${JSON.stringify(dist(absMin))}`);
  say(`[GC5] shield.resistance.distortion max ${JSON.stringify(dist(resMax))} mins ${JSON.stringify(dist(resMin))}`);
  say(`[GC5] ships with nonzero distortion absorption: ${nonzero.length} ${JSON.stringify(nonzero.slice(0, 10))}`);
  say(`[GC5] Quantum-named MissileLauncher racks: ${quantum.length} ${JSON.stringify(quantum)}`);
  save('gc5-distortion.json', { absMax: dist(absMax), absMin: dist(absMin), resMax: dist(resMax), resMin: dist(resMin), nonzero, quantum });
}

// [GC6] power semantics (W5 input): used_segments_grouped keys/units vs generation_segments
{
  const keyHist = new Map();
  const sums = [], ratios = [];
  let over = 0, missing = 0;
  const samples = [];
  for (const s of spaceships) {
    const g = s.power?.used_segments_grouped;
    const gen = s.power?.generation_segments;
    if (!g || typeof g !== 'object') { missing++; continue; }
    let sum = 0;
    for (const [k, v] of Object.entries(g)) {
      keyHist.set(k, (keyHist.get(k) ?? 0) + 1);
      if (typeof v === 'number') sum += v;
    }
    sums.push(sum);
    if (typeof gen === 'number' && gen > 0) {
      ratios.push(sum / gen);
      if (sum > gen) over++;
    }
    if (samples.length < 8) samples.push({ ship: s.name, generation_segments: gen, used_segments_grouped: g, used_segments_shields: s.power?.used_segments_shields, sum: Math.round(sum * 100) / 100 });
  }
  say(`[GC6] used_segments_grouped key histogram: ${JSON.stringify(Object.fromEntries(keyHist))}`);
  say(`[GC6] grouped-sum stats ${JSON.stringify(dist(sums))} | ships missing grouped: ${missing} | grouped-sum > generation_segments: ${over}/${ratios.length}`);
  say(`[GC6] sum/generation ratio ${JSON.stringify(dist(ratios))}`);
  say(`[GC6] samples: ${JSON.stringify(samples)}`);
  save('gc6-power.json', { keyHist: Object.fromEntries(keyHist), sums: dist(sums), ratios: dist(ratios), over, missing, samples });
}

// [GC7] absorption/resistance semantics (S5 input): mid(abs) vs mid(res) for physical/energy
{
  const stats = {};
  for (const t of ['physical', 'energy', 'distortion']) {
    const midAbs = [], midRes = [], resOverAbs = [];
    let resExceeds = 0;
    for (const s of spaceships) {
      const a = s.shield?.absorption?.[t], r = s.shield?.resistance?.[t];
      const ma = ((a?.minimum ?? 0) + (a?.maximum ?? 0)) / 2;
      const mr = ((r?.minimum ?? 0) + (r?.maximum ?? 0)) / 2;
      midAbs.push(ma); midRes.push(mr);
      if (mr > ma) resExceeds++;
      if (resOverAbs.length < 6 && mr > ma) resOverAbs.push({ ship: s.name, absorption: a, resistance: r });
    }
    stats[t] = { midAbs: dist(midAbs), midRes: dist(midRes), resExceeds, samples: resOverAbs };
    say(`[GC7] ${t}: mid(absorption) ${JSON.stringify(stats[t].midAbs)} | mid(resistance) ${JSON.stringify(stats[t].midRes)} | ships res>abs: ${resExceeds}`);
  }
  save('gc7-shield.json', stats);
}
// ============ END GAP-CLOSURE PROBES ============

writeFileSync(`${OUT}/report.txt`, report.join('\n'));
say('=== PROBE DONE: artifacts in probe/out/ (pretty-printed) ===');
