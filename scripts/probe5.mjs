const BASE = 'https://api.star-citizen.wiki/api';
const get = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
};

// Ships with sentinel deflection
let url = `${BASE}/vehicles`;
const items = [];
while (url) {
  const j = await get(url);
  items.push(...j.data);
  url = j.links?.next ?? null;
}
for (const s of items) {
  const d = s.armor?.deflection;
  if (!d) continue;
  if (d.physical >= 1000000 || d.energy >= 1000000) {
    console.log(`sentinel: ${s.name} | size=${s.size?.en_EN} | phys=${d.physical} en=${d.energy} | armor.hp=${s.armor?.health}`);
  }
}

// Items endpoint: a known turret weapon from Hammerhead
const hammer = items.find((s) => s.name === 'Hammerhead');
const w = hammer?.turrets?.manned?.[0]?.weapons?.[0];
console.log('hammerhead turret weapon:', JSON.stringify(w));

for (const cn of [w?.class_name, 'CL-410_Multi-Cannon', 'M51gun-MAH'].filter(Boolean)) {
  try {
    const j = await get(`${BASE}/items/${encodeURIComponent(cn)}`);
    console.log(`\n=== /items/${cn} top keys: ${JSON.stringify(Object.keys(j))}`);
    console.log(JSON.stringify(j, null, 1).slice(0, 4000));
  } catch (e) {
    console.log(`\n/items/${cn} -> ${e.message}`);
  }
}

// Items list endpoint: search weapons, check stats fields
try {
  const jl = await get(`${BASE}/items?filter%5Bcategory%5D=Weapon&limit=5`);
  console.log(`\nitems list keys: ${JSON.stringify(Object.keys(jl))} meta=${JSON.stringify(jl.meta)}`);
  console.log(JSON.stringify(jl.data?.[0], null, 1)?.slice(0, 2500));
} catch (e) {
  console.log(`items list -> ${e.message}`);
}

// Vehicle detail components: do fixed weapons have class_name?
const gladius = items.find((s) => /^gladius$/i.test(s.name));
const det = await get(`${BASE}/vehicles/${gladius.uuid}`);
const comps = det.components ?? det.data?.components;
console.log(`\ngladius components: type=${typeof comps} len=${Array.isArray(comps) ? comps.length : 'n/a'}`);
const ex = Array.isArray(comps) ? comps.slice(0, 8) : comps;
console.log(JSON.stringify(ex, null, 1)?.slice(0, 3000));
