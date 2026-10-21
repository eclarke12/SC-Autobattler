import { readFileSync } from 'node:fs';

const items = JSON.parse(readFileSync('probe/out/vehicles-all.json', 'utf8'));
const say = (...a) => console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

say('== size_class numeric -> label ==');
const map = {};
for (const s of items) {
  const k = String(s.size_class);
  const label = s.size?.en_EN ?? '?';
  map[k] ??= {};
  map[k][label] = (map[k][label] ?? 0) + 1;
}
say(JSON.stringify(map, null, 2));

say('== images populated ships ==');
const withImg = items.filter((s) => (s.images?.length ?? 0) > 0);
say('ships with images[] populated:', withImg.length);
if (withImg[0]) say('sample images[0]:', JSON.stringify(withImg[0].images[0]), 'name=', withImg[0].name);

say('== manned turrets per ship ==');
const manned = items.filter((s) => (s.turrets?.manned?.length ?? 0) > 0);
say('ships with manned turrets:', manned.length);
for (const s of manned.slice(0, 12)) {
  const perTurret = s.turrets.manned.map((t) => t.dps_total);
  say(`  ${s.name}: manned=${s.turrets.manned.length} dps_total per turret=${JSON.stringify(perTurret)} weaponry.turret_dps=${s.weaponry?.turret_dps}`);
}

say('== remote turrets sample (Constellation Aquila) ==');
const aq = items.find((s) => s.name === 'Constellation Aquila');
say('Aquila manned:', aq?.turrets?.manned?.length, 'remote:', aq?.turrets?.remote?.length, 'remote dps_total:', JSON.stringify((aq?.turrets?.remote ?? []).map((t) => t.dps_total)));

say('== missile damage types sample ==');
const gl = items.find((s) => s.name === 'Gladius');
say('Gladius weaponry:', JSON.stringify(gl.weaponry, null, 2).slice(0, 1800));

say('== fixed weapon name sample (damage-type heuristic source) ==');
const names = {};
for (const s of items) for (const w of s.weaponry?.fixed_weapons?.weapons ?? []) {
  const key = w.name;
  names[key] = (names[key] ?? 0) + 1;
}
const top = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 30);
say(JSON.stringify(top, null, 0));
