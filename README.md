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

The app ships with a pre-built snapshot at `data/ships.json` (249 spaceships), so no network
access is needed at runtime.

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

1. `npm run build:data` — paginates `/api/vehicles` (REST), filters to equipped spaceships,
   validates every record with zod, and rewrites `data/ships.json`.
2. `npm test` — the engine tests use the snapshot, so a data change surfaces as a test change.
3. Commit both `data/ships.json` and any stats-golden updates.

Field mapping and API quirks (ignored filters, `minimum`/`maximum` subkeys, weapon shape,
`ship-matrix` being dead) are documented in `docs/data-notes.md`.

## How the sim works

Headless TypeScript engine in `src/engine/` — no React, no DOM:

- 10-second rounds; each side fires fixed weapons + manned turrets.
- Shields absorb first (with a power-segment bonus of +25%/segment and mid-absorption minus
  mid-resistance mitigation), then armor, then hull. Damage a shield absorbs poorly — most
  ballistic hits — phases through it and strikes armor/hull directly.
- Armor deflection is a hard gate: a weapon whose per-shot damage (alpha) is below the defender's
  armor deflection for that damage type (ballistic/energy) deals no damage while the defender's
  armor holds; passes strip armor and overflow to hull. Gates come from the wiki API
  `armor.deflection` + per-weapon alpha (see `docs/data-notes.md`).
- Seeded PRNG (mulberry32) with ±15% variance ⇒ the same seed always replays the same battle.
- Power allocation: weapons need `ceil(DPS / 500)` supply segments; shortfalls cut DPS
  proportionally (shown as notes in the summary).
- Tunables live in `src/engine/constants.ts`.

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
