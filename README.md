# SC Autobattler

Pick two real Star Citizen ships, tune turret counts and power allocation, and watch a seeded,
round-based autobattle play out with a post-battle analytics breakdown. Share any matchup by URL.

Unofficial fan project — not affiliated with Cloud Imperium Games. Ship data and images via the
[Star Citizen Wiki API](https://api.star-citizen.wiki) / Roberts Space Industries.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

The app ships with a pre-built snapshot at `data/ships.json` (228 spaceships), so no network
access is needed at runtime. The snapshot is inlined into the JS bundle: production build is
~1.67 MB raw / **188 kB gzip** (ships.json ~1.3 MB + zod runtime).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Vitest engine tests (golden battles, seed determinism, monotonicity) |
| `npm run typecheck` | `tsc --noEmit` only |
| `npm run build:data` | Re-fetch the wiki API and regenerate `data/ships.json` (zod-validated; exits non-zero on schema drift) |
| `npm run probe` | API reconnaissance: writes raw samples to `probe/out/` (see `docs/data-notes.md`) |

## Refreshing ship data

The wiki's game-data patch cadence is the source of truth. To pick up a patch:

1. `node scripts/build-components.mjs` — walks every ship's ports, fetches each unique
   `class_name` from `/items/{class_name}` into the committed component cache
   `data/components-cache.json` (per-component power/coolant ranges). Incremental: cached
   keys are skipped; run repeatedly with a `--maxSeconds <budget>` (e.g. `--maxSeconds 100`,
   capped at 115) until it reports "remaining: 0".
2. `npm run build:data` — paginates `/api/vehicles`, filters to equipped spaceships, joins
   `ship.ports` × the component cache into per-ship `components[]`, validates every record
   with zod, and rewrites `data/ships.json` (exits non-zero on schema drift).
3. `npm test` — the engine tests use the snapshot, so a data change surfaces as a test change.
4. Commit `data/ships.json`, `data/components-cache.json`, and any stats-golden updates.

Field mapping and API quirks (ignored filters, `minimum`/`maximum` subkeys, weapon shape,
`ship-matrix` being dead) are documented in `docs/data-notes.md`.

## How the app works

Headless TypeScript engine in `src/engine/` — no React, no DOM:

- 10-second rounds; each side fires fixed weapons + manned turrets.
- Shields absorb first (mitigated by mid-absorption), then armor, then hull. Damage a
  shield absorbs poorly — most ballistic hits (~77%) — phases through it and strikes
  armor/hull directly. Shield recharge scales with the power allocated to the shields
  slider (see "Power model"): zero at shields-off, full at full allocation.
- Armor deflection is a hard gate scaled by armor integrity: a weapon whose per-shot
  damage (alpha) is at or below the defender's effective gate (deflection ×
  armor/armorMax) deals no damage while the defender's armor holds; the gate shrinks as
  the armor pool depletes and lifts at 0. Passing hits consume armor HP at
  dmg × per-type damage multipliers; the hull takes raw overflow. Gates come from the
  wiki API `armor.deflection` + per-weapon alpha (see `docs/data-notes.md`).
- Missiles/torpedoes bypass deflection entirely (explosives are undeflectable in-game);
  decoys are the defense. Each incoming missile faces a per-missile decoy commit:
  `min(required, stock)` charges and its own seeded evade roll; the committed charges
  burn on hit *and* on evade, so decoy stock attrs across salvos until the defender is
  unopposed. Quantum torpedoes (Polaris) hit as distortion: fully absorbed
  by shields — they grind the pool, then hit structure once shields drop.
- Gun ammo: ballistic guns feed from finite size-class ammo loads (the API carries no
  ammo fields, so the loads are a declared `GUN_AMMO_BY_SIZE` heuristic). Fire rate is
  derived exactly from the API pair (`dps / alpha` shots per second); a gun goes silent
  mid-battle when it runs dry. Lasers draw ship power and never deplete.
- Seeded PRNG (mulberry32) with ±15% variance ⇒ the same seed always replays the same battle.
- Power allocation: a component-level model over the ship's APU budget — see "Power model" below.
- The manned-turret slider shows the game-legal ceiling (`crew.max − 1`, pilot seat
  reserved) as an annotation.
- Tunables live in `src/engine/constants.ts`.

## Power model

Each ship's generator (APU) supplies `powerSegments` pips; every equipped component
carries a wiki **online-min / full-draw** pip range (`power.minOnline` / `power.fullDraw`,
from the API `resource_network.usage.power`). The loadout panel groups the allocation into
four sections: **Guns** (aggregate gun-pip slider + a PDC on/off toggle row), **Shields**
(a per-ship slider floored at the sum of the shield components' online-min, with the shield
components listed read-only beneath it), **Systems** (radar, coolers, life support, … — locked
power blocks at each component's online-min; Quantum Drive / Jump Drive show **unpowered**: the
app simulates the SCF/NAV (non-quantum) power state, so QDrives default to 0); the PowerPlant
generation source appears as the Output display's **MAX** value.

The loadout header shows a game-style **Output** display: a big live **available** number
(`powerSegments − (Σ system allocations + shield pips + gun draw)`, red when negative) with the
total PowerPlant generation beneath it as **MAX**; the **Fight** button is disabled while either side is overdrawn. Defaults put
every powered system at its online-min, QDrives/jump modules off, PDCs on, shields max and guns
full; on overdraw the ladder clamps guns → 0, then shields → their floor. This starts red on
44/228 ships and leaves 4 ship-wide red even after the ladder (**Ironclad**, **Ironclad Assault**,
**Prowler Utility Wikelo Work Special**, **MISC Hull B**)
whose minimum feasible draw still exceeds their APU.

RULE-R: the system reserve counts **only** system components — PowerPlant is the generation
source (its own min = its generation), Shield components ride the shield slider, and
weapons-category components are covered by the gun draw — so none double-count the budget.

Engine scaling from the allocation:
- **Gun DPS** `dpsScale = min(1, gunPips / weaponPool)`; at full pips a ship fires its full
  fixed DPS. The guns' power draw is `gunDraw + (PDCs on ? pdcCount × 1 : 0)`, charged at the
  gun-pip fraction.
- **Shield regen** `= regenPerSec × min(1, shieldPips / shieldPool)` — per 10 s round that is
  `regenPerSec × 10 × fraction`; zero at shields-off.

Share-link params (URL hash): `a`/`b` ship uuids, `aw`/`bw` weapon pips, `as`/`bs` shield
pips, `seed`, `aa`/`ba` per-component allocation CSV, and `pd`/`ps` PDC on/off toggles.

## Deploy

Static SPA, relative asset paths (`base: "./"` in `vite.config.ts`), so any static host works.

### GitHub Pages (included)

`.github/workflows/deploy.yml` builds and publishes `dist/` on every push to `main`.
In repo settings set **Settings → Pages → Build and deployment → Source: GitHub Actions**,
then push.

### Netlify

```bash
npm run build
npx netlify deploy --prod --dir=dist
```

## License / credits

Ship stats and imagery © their respective rights holders (CIG / RSI / Star Citizen Wiki).
This project is a non-commercial fan tool; the derived-stat model is an approximation, not a
gameplay simulation.
