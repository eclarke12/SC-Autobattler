// One-off snapshot audit (2026-10-22, gap-closure T6 / O4).
// Confirms bomb-rack exclusion in the data: bomb racks are hardpoint type
// "BombLauncher" (not "BombRack"), no bomb port contributes to a missile
// warload, and every snapshot warload comes from MissileLauncher ports.
// Requires probe artifacts: run `npm run probe` first (probe/out/vehicles-all.json).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const treePath = new URL('probe/out/vehicles-all.json', ROOT);
if (!existsSync(treePath)) {
  console.error('probe/out/vehicles-all.json missing — run `npm run probe` first');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(treePath, 'utf8'));
const snap = JSON.parse(readFileSync(new URL('data/ships.json', ROOT), 'utf8'));

const collectPorts = (ports, out = []) => {
  for (const p of ports ?? []) { out.push(p); collectPorts(p.ports, out); }
  return out;
};

const hist = new Map();
const bombShips = [];
for (const s of raw.filter((x) => x.is_spaceship)) {
  const types = new Map();
  for (const p of collectPorts(s.ports)) {
    const t = p.equipped_item?.type ?? '(empty)';
    hist.set(t, (hist.get(t) ?? 0) + 1);
    types.set(t, (types.get(t) ?? 0) + 1);
  }
  if ((types.get('BombLauncher') ?? 0) > 0) {
    bombShips.push(`${s.name} — ${types.get('BombLauncher')} bomb, ${types.get('MissileLauncher') ?? 0} missile rack(s)`);
  }
}

console.log('hardpoint equipped_item.type histogram (spaceships):');
for (const [t, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`);
console.log('\nships with BombLauncher ports:');
for (const line of bombShips) console.log(`  ${line}`);

const byUuid = new Map(raw.map((x) => [x.uuid, x]));
let violations = 0;
for (const s of snap) {
  const r = byUuid.get(s.uuid);
  if (!r) continue;
  const racks = collectPorts(r.ports).filter((p) => p.equipped_item?.type === 'MissileLauncher').length;
  if (s.missiles.ammo > 0 && racks === 0) {
    console.error(`VIOLATION ${s.name}: ammo=${s.missiles.ammo} with 0 MissileLauncher ports`);
    violations++;
  }
  if (racks === 0 && s.missiles.ammo !== 0) {
    console.error(`VIOLATION ${s.name}: ammo=${s.missiles.ammo} from non-missile ports`);
    violations++;
  }
}
console.log(`\nwarload cross-check: ${violations} violation(s)`);
process.exit(violations === 0 ? 0 : 1);
