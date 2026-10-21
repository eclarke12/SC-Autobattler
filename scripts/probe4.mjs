const BASE = 'https://api.star-citizen.wiki/api';
const get = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
};

// 1) Armor deflection/pen-resistance ranges across the fleet
let url = `${BASE}/vehicles`;
const items = [];
while (url) {
  const j = await get(url);
  items.push(...j.data);
  url = j.links?.next ?? null;
}
console.log(`vehicles=${items.length}`);
const deflects = { physical: [], energy: [], distortion: [] };
const penRes = { physical: [], energy: [] };
const samples = {};
for (const s of items) {
  const a = s.armor;
  if (!a) continue;
  for (const t of Object.keys(deflects)) {
    const v = a.deflection?.[t];
    if (typeof v === 'number') deflects[t].push(v);
  }
  for (const t of Object.keys(penRes)) {
    const v = a.penetration_resistance?.[t];
    if (typeof v === 'number') penRes[t].push(v);
  }
}
const stats = (arr) => {
  const uniq = [...new Set(arr)].sort((x, y) => x - y);
  return { count: arr.length, distinct: uniq.length, min: uniq[0], max: uniq[uniq.length - 1], values: uniq.slice(0, 30) };
};
for (const t of Object.keys(deflects)) console.log(`deflection.${t}`, JSON.stringify(stats(deflects[t])));
for (const t of Object.keys(penRes)) console.log(`penResist.${t}`, JSON.stringify(stats(penRes[t])));

// 2) Sample ships of each size with non-sentinel deflection
for (const s of items) {
  const a = s.armor;
  if (!a) continue;
  const d = a.deflection?.physical;
  if (typeof d === 'number' && d > 0 && d < 1000000) {
    samples[s.name] = { size: s.size?.en_EN, phys: a.deflection.physical, en: a.deflection.energy, penPhys: a.penetration_resistance?.physical, penEn: a.penetration_resistance?.energy };
  }
}
const names = Object.keys(samples);
console.log(`ships with gated deflection (0<x<1e6): ${names.length}`);
for (const n of names.slice(0, 25)) console.log(' ', n, JSON.stringify(samples[n]));

// 3) Weapon item endpoint: find a weapon class_name from a ship's turrets
const gladius = items.find((s) => /gladius/i.test(s.name));
const m7a = items.find((s) => /f7a? hornet|m7a/i.test(s.name)) ?? gladius;
const t0 = m7a?.turrets?.manned?.[0]?.weapons?.[0];
console.log('sample turret weapon:', JSON.stringify(t0));
const fixed0 = m7a?.weaponry?.fixed_weapons?.weapons?.[0];
console.log('sample fixed weapon keys:', JSON.stringify(Object.keys(fixed0 ?? {})), JSON.stringify(fixed0));

if (t0?.class_name) {
  const item = await get(`${BASE}/items/${encodeURIComponent(t0.class_name)}`);
  console.log(`ITEM ${t0.class_name}: top keys =`, JSON.stringify(Object.keys(item)));
  const d = item.data ?? item;
  console.log('item data keys =', JSON.stringify(Object.keys(d)));
  const stats2 = d.stats ?? d.weapon_stats ?? d.attributes;
  console.log('stats =', JSON.stringify(stats2, null, 1)?.slice(0, 3000));
  console.log('full item excerpt =', JSON.stringify(d, null, 1).slice(0, 3500));
}

// 4) Vehicle detail weapon_snapshot shape
if (m7a?.uuid) {
  const detail = await get(`${BASE}/vehicles/${m7a.uuid}`);
  const ws = detail.weapon_snapshot ?? detail.data?.weapon_snapshot;
  console.log('weapon_snapshot type:', typeof ws, Array.isArray(ws) ? `len=${ws.length}` : JSON.stringify(Object.keys(ws ?? {})));
  const excerpt = JSON.stringify(ws, null, 1);
  console.log('weapon_snapshot excerpt:', (excerpt ?? '').slice(0, 2500));
}
