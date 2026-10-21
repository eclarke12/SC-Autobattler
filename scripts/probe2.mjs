import { readFileSync } from 'node:fs';

const items = JSON.parse(readFileSync('probe/out/vehicles-all.json', 'utf8'));
const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const avenger = items.find((s) => s.name === 'Avenger Stalker');
const hammer = items.find((s) => s.name === 'Hammerhead' && s.is_spaceship);

say('== size_class values ==');
say('Avenger Stalker size_class =', JSON.stringify(avenger.size_class), '| size =', JSON.stringify(avenger.size), '| dimension =', JSON.stringify(avenger.dimension));
const scHist = {};
for (const s of items) {
  const k = typeof s.size_class === 'object' ? JSON.stringify(s.size_class) : String(s.size_class);
  scHist[k] = (scHist[k] ?? 0) + 1;
}
say('size_class histogram:', JSON.stringify(scHist, null, 0));

say('== images field ==');
say('Avenger images =', JSON.stringify(avenger.images));
say('Avenger shipmatrix_name =', JSON.stringify(avenger.shipmatrix_name), '| web_url =', avenger.web_url);

say('== weaponry shape (Avenger Stalker) ==');
say(JSON.stringify(avenger.weaponry, null, 2).slice(0, 3000));

say('== turrets field (Avenger) ==', JSON.stringify(avenger.turrets));
say('== turrets field (Hammerhead) ==', JSON.stringify(hammer?.turrets).slice(0, 2000));

say('== weaponry (Hammerhead) keys ==', JSON.stringify(Object.keys(hammer?.weaponry ?? {})));
if (hammer?.weaponry?.pit_turrets) say('Hammerhead pit_turrets sample:', JSON.stringify(hammer.weaponry.pit_turrets).slice(0, 1500));

say('== fleet counts ==');
const space = items.filter((s) => s.is_spaceship);
say('is_spaceship truthy:', space.length, '/', items.length);
const armed = space.filter((s) => (s.weaponry?.fixed_weapons?.weapons?.length ?? 0) > 0);
say('is_spaceship && fixed_weapons>=1:', armed.length);

say('== weapon entry fields ==');
const w = avenger.weaponry.fixed_weapons.weapons[0];
say('weapon[0] =', JSON.stringify(w, null, 2));
const wTypes = {};
for (const s of space) for (const x of s.weaponry?.fixed_weapons?.weapons ?? []) wTypes[x.type] = (wTypes[x.type] ?? 0) + 1;
say('weapon type histogram:', JSON.stringify(wTypes, null, 0));

say('== weaponry top-level keys histogram ==');
const wk = {};
for (const s of space) for (const k of Object.keys(s.weaponry ?? {})) wk[k] = (wk[k] ?? 0) + 1;
say(JSON.stringify(wk, null, 0));

say('== shield subkeys ==');
say(JSON.stringify(Object.keys(avenger.shield)));
say('== shield.resistance/absorption ==', JSON.stringify(avenger.shield.resistance), JSON.stringify(avenger.shield.absorption));

say('== power pools ==', JSON.stringify(avenger.power_pools).slice(0, 800));
say('== manufacturer ==', JSON.stringify(avenger.manufacturer));
say('== career/role ==', JSON.stringify(avenger.career), JSON.stringify(avenger.role));
say('== mass ==', JSON.stringify(avenger.mass), avenger.mass_hull, avenger.mass_total);
