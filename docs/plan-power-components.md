# Plan: Component power model (T17–T22)

> **Status: COMPLETE (2026-10-23).** T17–T22 all landed; typecheck/tests/build green. RULE-R + corrected fleet stats in `docs/data-notes.md` (RULE-R section).

Goal: import the ship→component power graph into the data pipeline, show every component with an allocation control, let the user tune guns/shields within the generator budget (moving pips in/out of other systems), and forbid entering battle overdrawn.

Evidence base: GC8 probe (`scripts/probe6.mjs`, `probe/out/gc8-components.json`, `probe/out/component-power-cache.json` 397 items). Per-component `resource_network.usage.power {min,max}` = the wiki's "Power Usage 2–5 Segments"; covers all powered components (only ToolArm/Module/WeaponGun ports lack it — none power-relevant); rates reproduce `used_segments_grouped` exactly; QuantumDrive draw is absent from grouped; 7/261 ships have Σmin > generation.

## Data model (broad join, per-resource nesting)

Every equipped item on every ship becomes a component record — no power-relevance filter, so a future heat/cooling model needs no new import:

```ts
// ShipData.components — indexed, order = ports-tree traversal
interface ShipComponent {
  type: string;          // Shield, Cooler, Radar, FlightController, Turret, QuantumDrive, ...
  name: string;
  className: string;     // join key to the item cache
  size: number | null;
  grade: number | null;
  power: { minOnline: number; fullDraw: number } | null;    // usage.power {min,max}
  coolant: { minOnline: number; fullDraw: number } | null;  // usage.coolant — reserved (T-future: heat)
  generation: { power: number | null; coolant: number | null }; // power_plant.power_segment_generation / cooler.coolant_segment_generation
}
```

`minOnline`/`fullDraw` naming per resource object: "min/max" is ambiguous once coolant/heat joins; `minOnline` = lowest segment count that keeps the component online, `fullDraw` = draw at full allocation (segments). Derived per ship:
- `gunDraw` = grouped `WeaponGun` (aggregate fixed-gun draw, fractional; per-weapon power does not exist in the API) + `manned × TURRET_POWER_SEGMENTS` (existing heuristic) + PDC contribution when the PDC toggle is on.
- `pdcCount` = `turrets.pdc.length` (API list; PDC draw has no API field — `pdcCount × TURRET_POWER_SEGMENTS` declared heuristic, togglable).
- `shieldPool` = Σ shield `fullDraw` (replaces `power_pools.Shield.size` constant 2; Shimmer 1×2=2 agrees with the API where data exists); `shieldMin` = Σ shield `minOnline` (Stronghold 4–5 ⇒ shields can never be set below 4).
- Retire: `baselineSegments` (W5), `powerUsedShields`; keep `powerSegments` (= APU segments; matches PowerPlant `generation.power` — cross-check at build).

## Power allocation model

- Supply `S` = `powerSegments`.
- Allocation: each component slider 0..fullDraw, default `minOnline` — **everything on by default** (no off-defaults, per decision 2026-10-22).
- Guns: slider 0..`weaponPool` pips; draw = `gunDraw × (w/weaponPool)` (fractional, displayed 1 dp). `gunDraw` = grouped `WeaponGun` + `manned × TURRET_POWER_SEGMENTS` + (PDC on ? `pdcCount × TURRET_POWER_SEGMENTS` : 0) — declared heuristics (API exposes no per-turret/PDC power; GC: turret item usage is 0–0).
- PDCs: not individually managed — a single "PDC: N" toggle row in the Guns section; on ⇒ draw counts inside the weapons pool, off ⇒ 0 (user-callable per your spec).
- Shields: slider `shieldMin..shieldMax` (aggregate over shield components); draw = allocated segments (1:1).
- `allocated` = Σ component allocations + shield + gun draw. `net = S − allocated`.
- **Overdraw rule:** the UI allows it (red net); Fight is disabled while net < 0 on either side. Defaults: all components minOnline, shields **max**, guns full; on overdraw clamp guns to fit; if guns 0 + shields floor is still over, net stays red until the user powers systems down ("remove pips elsewhere"). No silent clamping of user allocations; only shared-link knobs are clamped to legal ranges at the `toConfig` boundary (trust-boundary convention).
- Engine effects: `dpsScale = w/weaponPool` (replaces the DPS/500 `powerDemand` heuristic); shield regen = `regenPerSec × shieldAlloc/shieldMax` (over-pool bonus model retired). Non-combat allocations are budget accounting only — no simulated effect (documented; heat/radar/flight models are future work).

## Tasks

- **T17 ✅ COMPLETE — component import**: `scripts/build-components.mjs` (generalize probe6): walk all 261 snapshots' `ports` trees, dedupe class_names across **all** equipped types (~900 unique), fetch `/items/{class_name}` → `{usage, generation, resource_network power/coolant deltas}` cache at `probe/out/component-power-cache.json`; incremental (skip cached); commit the cache to git (probe/out currently untracked — move cache to `data/components-cache.json` if not committable). Record GC8 in docs/data-notes.md (full-fleet Σmin/Σmax stats, QDrive/grouped finding, 7 over-min ships).
- **T18 ✅ COMPLETE — build join + schema**: build-data.mjs joins `ship.ports` × cache into `components[]`, derives `gunDraw`, `shieldPool`/`shieldMin` from shield components (fallback to `power_pools` when components missing), drops `baselineSegments`/`powerUsedShields`; zod schema in build-data + data.ts; hard-exit gates: every ship has ≥1 component, every Shield/Cooler/Radar/FC/LS/QDrive port has `power` data, `minOnline ≤ fullDraw`; regenerate ships.json (~+300 kB).
- **T19 ✅ COMPLETE — engine power model**: new `engine/power.ts`: `allocatedPower(ship, alloc, gunPips, shieldSegs, pdcOn)`, `netPower(...)`, defaults builder (every component at `minOnline`, PDC on, guns full, shields max; clamp guns down on overdraw — weapons-claim-first preserved; net stays red if guns 0 + shields floor is over budget); `derivedStats`: pool-fraction dpsScale (gun draw incl. PDC contribution when on) + shield-fraction regen; extend `ShipConfig` (`gunPips`, `shieldSegs`, `allocs: number[]`, `pdcOn: boolean`); wire simulate + `powerNotes` (overdraw, under-powered guns, shields floor, offline systems); remove `availablePipsFor`/`clampPowerSplit`/`baselineSegments` paths.
- **T20 ✅ COMPLETE — knobs + URL + App boundary**: `SideKnobs` += `alloc: number[]` (index-aligned, compact CSV in hash params `aa=`/`ba=`) and `pd: 0|1` (PDC on/off); decode bounds-checks (Number.isFinite + count ≤ components), `toConfig` clamps allocs to [0, fullDraw], shields to **[0, shieldPool]**, guns to [0, weaponPool] — resolved note 2026-10-23: shields clamp to [0, shieldPool] (not [shieldMin, shieldPool]); 0 is legal = shields off, the engine enforces no floor and `defaultAllocation` restores full shields on ship change; the `shieldMin` floor applies to the UI block-picker display, not the config; `defaultKnobs` = engine defaults (all systems on at minOnline, PDC on, shields max, guns clamped to fit); Fight button `disabled={netA < 0 || netB < 0}` with per-side net chip in header + setup columns.
- **T21 ✅ COMPLETE — UI**: LoadoutPanel power meter (generation / allocated / net, red overdraw) + component sliders grouped Flight / Shields / Guns / Systems (radar, coolers, life support, QDrive, beams, tools, modules) / PowerPlant read-only (generation) using PowerBlocks; Guns section carries the aggregate gun slider + PDC on/off toggle row ("PDC × N — draws into the weapons pool when on", user can turn PDC off to free pips); per-component tooltip (name, size, grade, minOnline–fullDraw, "no effect in app sim" tag for non-combat); BattleView tooltips + Summary net-power line; retire old baseline notes.
- **T22 ✅ COMPLETE — tests, goldens, docs**: unit tests (allocation math, shield floor e.g. Stronghold 4–5, gun-draw fraction, overdraw net, defaults, url alloc round-trip); data tests (components present fleet-wide, shieldPool = Σ shield fullDraw, minOnline ≤ fullDraw); regenerate golden battles (dpsScale + regen model changed — review deltas); `npm run build:data && typecheck && test && build`; README/data-notes updates.

## Decisions (confirmed 2026-10-22)

1. Field naming: nested per-resource `power: {minOnline, fullDraw}` (+ reserved `coolant: {…}`, `generation: {…}`) — future heat model slots in without renaming.
2. **Everything on by default** at `minOnline` — no off-defaults. PDCs are not individually managed: lumped into the weapons pool, default on, single toggle to turn off (frees `pdcCount × TURRET_POWER_SEGMENTS`).
3. Default shield allocation = **max**; on overdraw clamp guns down (weapons-claim-first preserved); shield floor enforced by Σ `minOnline` per ship (can't go to 0 on Stronghold ships).

## Out of scope (parked)

- Heat/coolant simulation (data reserved in schema; coolant `usage` fields captured at T17).
- Flight/radar/life-support simulation effects — allocation UI is bookkeeping; engine effects need subsystem models.
- Per-weapon gun power (API gap: `weaponry` has no power fields; aggregate `gunDraw` stands).
