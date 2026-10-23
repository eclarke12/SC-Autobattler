# Data Notes — Frozen Field Mapping (Task 1)

Probe date: 2026-10-21. Source: `https://api.star-citizen.wiki/api` (REST only; `/graphql` 404s).
Artifacts: `scripts/probe.mjs`, `scripts/probe2.mjs`, `scripts/probe3.mjs` → `probe/out/` (gitignored; pretty-printed).

## Endpoint facts

- `GET /api/vehicles` — Laravel paginator `{data, links, meta}`; `meta.from/to/total` numeric, 30/page, 310 items, 11 pages. Follow `links.next` for paging.
- Query params `filter[size_class]`, `filter[is_spaceship]`, `filter[name]` are accepted; **size_class and is_spaceship filters are silently ignored** (all return the same 261 total). Derive size client-side.
- `GET /api/vehicles/{uuid}` — same shape + `components` (coarse, no dps) + `weapon_snapshot`. **Not needed**; the list payload already embeds everything.
- `GET /api/items/{class_name}` — item details (uuid, slug, classification). Not needed for MVP.
- `GET /api/ship-matrix/vehicles` — **404 / dead**. Do not use. Images come from `images[]` embedded on vehicle objects (246/310 populated).

## Resolved risks

1. **Weapons embedding shape** — `weaponry` object on every vehicle:
   - `weaponry.pilot_dps`, `pilot_alpha`, `pilot_sustained_dps` (all fixed weapons as flown by pilot)
   - `weaponry.fixed_weapons.weapons[] = { name, dps, sustained_dps, alpha }` — no per-weapon type/damage-type/power fields.
   - `weaponry.turret_dps`, `turret_alpha`, `turret_sustained_dps` (present on 73 ships; ≈ Σ manned turret dps_total)
   - `weaponry.missiles.damage.{physical|energy|...}` (per-type totals) — out of scope MVP.
   - Turrets: `turrets = { manned: [], remote: [], pdc: [] }`. Each manned entry: `{ display_name, size, dps_total (nullable), sustained_dps_total, mount_count, weapons[] { name, class_name, uuid, dps } }`. `turretCount = turrets.manned.length` (70 ships > 0). `dps_total` is null on empty/unslotted mounts (e.g. Javelin has 13 manned, 9 with dps) → treat null as 0 and keep count = list length for the slider max, sum dps over non-null entries.
2. **Armor** — `armor.health` EXISTS (Avenger Stalker: 1232). Also per-type `armor.damage_multipliers.{type}` (0.65–1), `armor.resistance_multipliers`, `armor.penetration_resistance`, `armor.deflection` (numeric thresholds, e.g. 1000000 = "undeflectable" for physical/energy — NOT a percentage; unusable as deflection %). MVP uses `armor.health` as the armor pool; deflection stays the 10% tunable.
3. **Shield regen units** — `shield.regeneration` is **HP per second**: Avenger 852 × 5.27 s ≈ 4488 = `shield.hp` exactly; Gladius 1204 × 5.26 ≈ 6336. `regeneration_time` = seconds to refill from empty. `face_type` is a string label ("Bubble"); MVP models one pooled shield, face shown in UI.
   - `shield.resistance` / `shield.absorption` subkeys are **`minimum`/`maximum`** (not min/max), each with all 6 damage types: physical, energy, distortion, thermal, biochemical, stun.
   - Effective shield factor for damage type t: `mid(absorption[t]) − mid(resistance[t])`, clamped to [0, 1]. (Avenger: energy 1.0, physical 0.45−0.125=0.325.) **Revised 2026-10-22 (S5 review): factor = `mid(absorption[t])` only — see "Gap-closure probe" finding 7 and primer §5.**
4. **Images** — `images[]` on vehicle list objects: `{ source: "starcitizen.tools", original_url, thumbnail_url, original_width/height, thumbnail_width/height }`. `thumbnail_url` = 600px webp at `media.starcitizen.tools` (stable CDN; hotlink OK for fan project, credit in footer). 246/310 ships have ≥1 image; ships with none get "" → UI placeholder. `ship.images[0]` preferred.

## Frozen `ShipData` mapping (list payload → snapshot)

| ShipData field | API path | Notes |
|---|---|---|
| uuid | `uuid` | |
| name | `name` | |
| displayName | `name` (+ variant from `name`) | |
| manufacturer | `manufacturer.name` | object with `.code` |
| career | `career` | "Combat", "Trade", … |
| role | `role` | "Interceptor", … |
| sizeClass | `size.en_EN` label; fallback numeric `size_class`: 1=snub,2=small,3=medium,4/5=large,6=capital | label has mixed-case ("capital","snub") — lowercase it |
| image | `images[0].thumbnail_url` ?? `""` | |
| health | `health` | hull |
| armor | `armor.health` | |
| shield.hp | `shield.hp` | |
| shield.regenPerSec | `shield.regeneration` | |
| shield.faceType | `shield.face_type` | |
| shield.reconfigurationCooldown | `shield.reconfiguration_cooldown` | seconds |
| shield.resistances | `shield.absorption[t]`,`shield.resistance[t]` → `{min,max}` from `minimum,maximum` | 6 damage types |
| weapons | `weaponry.fixed_weapons.weapons[]` → `{name, type:'fixed', damageType, dps, power}` | damageType by name heuristic (below); power by size tier (below) |
| turret weapons | `turrets.manned[]` → `{name, type:'turret', damageType, dps: dps_total??0, power}` | |
| turretCount | `turrets.manned.length` | slider max 0..N; turret DPS pro-rated `ΣturretDps × manned/N` |
| powerSegments | `power.generation_segments` | |
| weaponPool | `power_pools.WeaponGun.size` (fallback 4) | slider max for weapons |
| shieldPool | `power_pools.Shield.size` (fallback 2) | slider max for shields |
| powerUsedShields | `power.used_segments_shields` | |
| crossSection | `cross_section` (numeric) | |
| speed | `speed.{scm, max}` | |
| mass | `mass` | |
| crew | `crew.{min, max}` | |
| isSpaceship | `is_spaceship` | filter: true AND fixed_weapons+ manned weapons ≥ 1 |

### Weapon damage-type heuristic (API exposes none for fixed weapons)
`/cannon|gatling|scattergun|mortar|railgun|shredder|gun|projectile/i` → **physical**; `/repeater|laser|pulse|beam|particle/i` → **energy**; default **physical**. (Verified: "CF-337 Panther Repeater"=laser→energy, "M7A Cannon"=ballistic→physical, "Revenant Gatling"=ballistic→physical.)

### Weapon power assumption (API exposes no per-weapon power in `weaponry`)
Fixed weapons have no power fields. Use declared tunable per-ship: total fixed-weapon power draw is **assumed powered at nominal**; the weapons slider scales DPS from 0..1 across `0..weaponPool` segments (`dpsScale = powerToWeapons / max(1, ceil(Σdps/500))`-style ratio — engine-side tunable, documented in constants.ts). Turret power: each manned turret assumed to need 1 segment.

## Fleet counts (as of probe)
- 310 vehicles; 261 `is_spaceship`; 232 spaceship with ≥1 fixed weapon; 70 with manned turrets; 246 with images.

## Armor deflection gate (2026-10-21) — `armor.deflection` + weapon alpha

Source of truth: `armor.deflection.{physical|energy|...}` on the vehicle list payload (no extra calls). Values are per-shot damage thresholds in raw damage units, NOT percentages:

- `deflection.{physical,energy}` map to the ballistic/energy gates; the other four types are 0 across the fleet.
- Fleet range (228 in-snapshot ships): physical 5–554, energy 3–485; median 24. Small fighters ~5–20 (Avenger 11/9, Sabre 20/16), capitals 400–554 (Hammerhead 531/380, Javelin 539/473, Idris 554/485).
- Sentinel: values ≥ 1,000,000 = game's "undeflectable" placeholder → normalized to 0 (no gate) in the snapshot. In-snapshot ships currently all have real small gates; sentinel variants (Skylark, Constellation Mk IV/V) are unarmed/display-excluded.
- Gate is modeled as a hard gate: a weapon with `alpha` (per-shot damage) at or below the defender's deflection for its damage type deals **zero** damage while the defender's armor pool > 0 (game deflects damage ≤ the rating; equality fixed 2026-10-22). `alpha` 0 (missing data — 12/927 weapons in 2026-10-21 data; **0/872+0/406 in the 2026-10-22 probe**) is never deflected. When armor is depleted, the gate lifts and full damage hits hull; passes deal full damage to armor with overflow to hull.
- Weapon alpha: `weaponry.fixed_weapons.weapons[].alpha` for fixed guns; `turrets.manned[].weapons[].alpha` max per turret. Turret alpha = max of mount alphas.

Not modeled (per product decision 2026-10-21):
- Weapon penetration as distance/likelihood to damage internals (`items` endpoint has `max_penetration_thickness` in meters — out of scope).
- `armor.penetration_resistance`: exactly 1.0 for physical/energy across all 310 vehicles (distortion 0) → no multiplier applied.
- `armor.damage_multipliers.{type}` (0.65–1.0 armor damage multipliers) — future tunable candidate, not applied.
- The old global 10% flat deflection (`DEFLECTION`) is removed; per-ship gates fully replace it.

Shield interaction: the gate is applied to a weapon's contribution before shields too (hard "will not damage the target" per spec). Damage-type mix and shield factor are computed from the gated (surviving) output, so deflected weapons also stop influencing the shield type factor.

## Shield absorption leak (2026-10-21)

Incoming damage is split per damage type by the defender's shield factor: `factor = mid(absorption) − mid(resistance)` (clamped [0,1]) reaches the shield; the **remainder `(1 − factor)` phases through the shield and hits armor directly** (hull once armor is gone). This matters most for ballistic weapons: fleet shield `absorption.physical` is typically 0–0.45, so most physical damage bypasses energy shields (e.g. Avenger-line factor 0.10–0.33 → 67–90% leak). Energy against full energy absorption (factor 1.0) leaks ~0.

**Revised 2026-10-22 (S5 review, probe GC7):** `factor = mid(absorption)` (resistance no longer subtracted — the absorption bands match in-game absorption at face value; the physical factor is now fleet-constant 0.225 → 77.5% ballistic leak; energy/distortion unchanged at factor 1.0). See gap-closure probe finding 7.

- Implemented as `shieldSplitFor` in `derived.ts`; `applyHit` applies the shield part to the pool every round and the leak part to armor/hull every round (also on the break round: overflow + leak stack).
- No new API fields needed — uses existing `shield.absorption` / `shield.resistance`.
- Deflection gate remains a hard per-weapon gate (deflected weapons contribute nothing to shield, armor, or hull).


## Gap-closure probe (2026-10-22) — 7 findings, `npm run probe` (scripts/probe.mjs GC1–GC7)

Raw samples: `probe/out/gc1-alpha.json` … `gc7-shield.json` + `probe/out/report.txt`. Scope: 261 `is_spaceship` vehicles (310 total). The legacy `[7] ship-matrix` call is a known-dead 404 and is now non-fatal.

1. **Alpha coverage (A3 input, GC1)** — fixed weapons **0/872** and manned-turret mounts **0/406** have alpha 0/missing; every weapon entry carries a real `alpha`. The 2026-10-21 note "12/927 weapons alpha=0" is obsolete: alpha-0 pass-through in `isDeflectedByGate` currently protects **zero** fleet weapons. ⇒ A3 parked: keep the alpha-0 never-deflect rule as a data-absence guard; estimating 4.x burst values needs game data the API doesn't expose.
2. **Per-weapon ammo (W4 input, GC2)** — fixed weapon entries expose exactly `{name, dps, sustained_dps, alpha}`; turret mounts `{uuid, class_name, name, link, web_url, dps, sustained_dps, alpha, is_pilot_slaveable}`. **No ammo_capacity/ammo_type/clip/charge fields anywhere** (0/872 fixed, 0/406 turret). ⇒ T13 must use the declared size-class ammo heuristic table; per-gun ammo is an API gap.
3. **Decoy charges (C5 input, GC3)** — 618 `WeaponDefensive` items across 261 ships; item keys are exactly `{uuid, name, class_name, type, sub_type, size, grade, manufacturer, link, web_url}`. **Zero ammo/charge-count fields** (0/618). Decoy vs Noise split by name (e.g. "Aegis Gladius - Decoy Launcher" 130, "Joker Defcon Flares Ammo" 60, "Joker Defcon - Noise Launcher" 165). ⇒ T14 keeps the declared size-class stock table × launcher count; real per-model charges are an API gap.
4. **Bomb racks (O4 input, GC4)** — hardpoint `equipped_item.type` histogram (all ports, spaceships) includes: MissileLauncher 636, Turret 1007, WeaponDefensive 618, Shield 503, Cooler 486, PowerPlant 360, Radar 267, FlightController 261, Armor 260, TurretBase 177, WeaponGun 17, ToolArm 24, EMP 6, QIG 7, UtilityTurret 9, **BombLauncher 5**, DockingCollar 14. The bomb-rack type is **`BombLauncher`** (not "BombRack"), 5 ports on **3 ships: A1 Spirit, A2 Hercules Starlifter, A2 Hercules Starlifter Wikelo War Special** — display names are "MSD-313 Missile Rack" (misleading) with `class_name BMBRCK_*`. `ordnanceOf` counts only `type === 'MissileLauncher'`, so bomb ports are excluded by construction; a display-name matcher would wrongly include them.
5. **Distortion (O3 input, GC5)** — `shield.absorption.distortion` is `{minimum:1, maximum:1}` on **261/261** ships (fleet-constant full absorption); `shield.resistance.distortion` is `{0.75, 0.95}` fleet-wide. **Zero** `MissileLauncher` racks name-match "Quantum" fleet-wide. Polaris racks are "RSI Polaris Torpedo Rack" / `MRCK_S10_RSI_Polaris_Torpedo_*` (size-10 parse artifacts); no "quantum" token exists in any rack name. ⇒ T10's "rack name contains Quantum" detector matches 0 ships by design; the implemented detector is name-token `quantum` (future-proof) OR the known in-game quantum-ordnance ship (RSI Polaris) — declared heuristic, recorded as a gap.
6. **Power semantics (W5 input, GC6)** — `power.used_segments_grouped` keys: Radar (261/261), Cooler 261, Shield 261, WeaponGun 253, FlightController 261, LifeSupportGenerator 259, TractorBeam 32, WeaponMining 8, QIG 7, SalvageHead 7, TowingBeam 1. **The grouped sum equals `used_segments_shields` exactly** (Avenger Stalker: grouped {Radar:5, Cooler:6, Shield:2, WeaponGun:3.1, FlightController:4, LifeSupportGenerator:1} = 21.1 = `used_segments_shields`). Fleet sum 13.2–62 (median 25.6) vs `generation_segments` (fleet median 18): sum > generation on **244/261** ships; sum/generation ratio median 1.41, max 2.0. ⇒ the grouped sum is **not pip-equivalent** — it is the same >generation unit-quirk quantity as `used_segments_shields`. W5's baseline (= grouped sum, per binding decision) saturates ⇒ `available = max(0, generation − baseline)` = 0 on 93.5% of ships; remaining pips (ratio floor 0.49, p25 1.23 ⇒ ~45% of ships have any) go to weapons/shields. Consequence: real-ship battles become low-pip wars of attrition (partial-DPS weapons, slow shields, ordnance+decoys decide). Golden battles and share links shift accordingly — reviewed, accepted; synthetic-test ships with no baseline keep full pips (undefined baseline ≡ 0).
7. **Absorption/resistance semantics (S5 input, GC7)** — fleet bands are **constant** per type (min=max across all 261 ships): physical absorption `{0, 0.45}` (mid 0.225), physical resistance `{0, 0.25}` (mid 0.125); energy absorption `{1, 1}`, energy resistance `{0, 0}`; distortion absorption `{1, 1}`, distortion resistance `{0.75, 0.95}` (mid 0.85). Resistance never exceeds absorption (0 ships of 261, all 6 types). The absorption bands reproduce the documented in-game absorption at face value (energy fully absorbed; ballistic "~0–45% absorbed"; distortion fully absorbed), while resistance reads as a separate reduction band — the S5 review verdict is `factor = mid(absorption)` (see primer §5).

## Sample payloads (excerpted)

Avenger Stalker: `health=11900`, `armor.health=1232`, `shield={hp:4488, regeneration:852, regeneration_time:5.27, face_type:"Bubble", reconfiguration_cooldown}`, resistance.physical={min:0,max:0.25} absorption.physical={min:0,max:0.45} absorption.energy={min:1,max:1}, `power={generation_segments:14, used_segments_shields:21.1}`, `power_pools={Shield:{size:2},WeaponGun:{size:4}}`, `weaponry.fixed_weapons.weapons=[{Revenant Gatling dps:1266},{Omnisky IX Cannon dps:546.8}×2]`, pilot_dps 2359.6, `turrets={manned:[],remote:[],pdc:[]}`, images[0].thumbnail_url=`media.starcitizen.tools/thumb/3/34/Avenger_Stalker_...600px...webp`.

Hammerhead (GS): 6 manned turrets, each dps_total=3271.6 (KLWE_LaserRepeater_S4 ×4 mounts), weaponry.turret_dps=19629.6, shield.hp=211200, regeneration=40128/s.

Javelin: 13 manned turret entries (4 with `dps_total:null`), turret_dps=48433.


## W5 power baseline implemented (2026-10-22, T11)

The GC6 grouped sum is mapped as ShipData.baselineSegments (rounded) and the discretionary pip budget is vailable = max(0, powerSegments − baselineSegments) (vailablePipsFor in derived.ts, enforced at the App config boundary via clampPowerSplit: per-system pools cap first, the shared budget second, weapons claim first on overflow; sliders + share-link knobs pass through the same clamp).

Measured on the 228-ship snapshot (post W5 regeneration): **217/228 ships (95%) saturate** — available = 0 — so in the UI their weapons run at 0% DPS, shields never recharge, and battles reduce to missile/ordnance attrition. Only 11 ships (baseline < generation) keep a working slider (e.g. none of Hammerhead 51/30, Gladius 24/16, Avenger Stalker 21/14, Polaris 48/27). This is sharper than the probe-era “~45% of ships have some pips” expectation — that figure miscounted ratio<1 ships (the true fleet fraction with sum < generation is 17/261 pre-filter, 11/228 post-filter). Golden battles are unaffected because the engine trusts the config; the test harness allocates weaponPool pips directly, bypassing the UI-boundary clamp. Surfaced for T16 summary; revisit (scale-normalized pips / park) is a user call, not relitigated here.

## W5 retirement + component join (T18, 2026-10-22)

`npm run build:data` now joins `ship.ports` × the T17 item cache into per-ship `components[]` and retires the W5 grouped-sum fields.

**Retired from ShipData + zod (build-data.mjs and data.ts mirror):**
- `baselineSegments` (W5 grouped sum, unit-quirk per GC6) — removed.
- `powerUsedShields` (`power.used_segments_shields`, same quirk quantity) — removed.

**New/changed ShipData fields (T18 join, contract = plan-power-components.md):**
- `components: ShipComponent[]` — every `equipped_item` with a `class_name` on the ports tree, in traversal order: `{type, name, className, size, grade, power:{minOnline,fullDraw}|null, coolant:{minOnline,fullDraw}|null, generation:{power,coolant}}`. Join key = `class_name` against **`data/components-cache.json`** (T17, 1137 entries, committed; build hard-exits if the cache is unreadable). Unknown class_name → null ranges with the port's type. The cache emits `{minOnline:null, fullDraw:null}` placeholder ranges where a usage key is absent — build normalizes those to a whole-null range.
- `gunDraw` — `power.used_segments_grouped.WeaponGun`, kept **fractional** (e.g. 3.1; no rounding). Aggregate fixed-gun draw only; manned-turret ×1-segment and PDC contributions are engine-side heuristics (T19).
- `shieldPool` — keeps its name, new meaning: Σ shield-component `fullDraw` (replaces `power_pools.Shield.size` constant 2); fallback `power_pools.Shield.size` → 2 when a ship has no shield-component power data. Fleet distribution now **1..24** (was 2-for-all).
- `shieldMin` — Σ shield-component `minOnline` over the same set (fallback 0); the per-ship shield floor (T19/T20 sliders cannot go below it).
- `pdcCount` — `turrets.pdc.length` (PDC power draw has no API field; `pdcCount × TURRET_POWER_PIPS` is the declared T19 heuristic).

**Hard-exit gates (added, on top of empty-snapshot + >20%-unarmed):** (a) every built ship ≥1 component; (b) every component of type Shield/Cooler/Radar/FlightController/LifeSupportGenerator/QuantumDrive has non-null `power` (enforced over joined components = populated ports; unpopulated ports emit no component); (c) every component with power satisfies `minOnline ≤ fullDraw`.

**Fleet stats (228-ship snapshot, post-join):**

| metric | value |
|---|---|
| ships | 228 (unarmed-filtered 12, display-excluded 4, dedup 17) |
| components total | 4493 (19.7/ship) |
| per-ship ΣminOnline | p50 31, p75 46, p90 56, max 153 (Javelin) |
| per-ship ΣfullDraw | p50 45, p75 64, p90 83, max 186 |
| ships ΣminOnline > powerSegments | **228/228** |
| shieldPool distribution | 1:4, 2:35, 3:14, 4:52, 5:9, 6:44, 8:15, 9:11, 10:16, 12:10, 15:7, 16:6, 20:2, 24:3 |
| ships.json size | 434,625 → 1,312,311 bytes |

**Deviation from plan expectation (material):** the plan/probe-6 "Σmin > generation on 7/261 ships" does **not** reproduce. ΣminOnline over ALL joined components exceeds `powerSegments` on **every** ship (p50 31 vs median gen ~18) and also exceeds Σ PowerPlant `generation.power` on 228/228. Explanation: the per-component `minOnline` sum is the same >generation unit-quirk quantity that GC6 measured for `used_segments_grouped` (sum > generation on 244/261) — the plan's "7" figure predates full-fleet joining. Consequences for T19/T20: all-defaults (all systems minOnline + shields max + guns full) starts overdrawn on every ship; "clamp guns to 0, shields floor" is **still** over budget fleet-wide, so a defaults policy decision is needed (e.g. default shields to floor, not max, when overdrawn). Cross-check note: Σ PowerPlant `generation.power` ≠ `powerSegments` on **78/228** ships (e.g. Hammerhead 48 vs 30) — plan assumed a match; `powerSegments` (APU) stays the supply `S`, generator-component `generation.power` is per-plant data.

**Resolved by RULE-R (2026-10-23, T19/T21):** the "every ship overdrawn" figure is a **double-count** — it summed PowerPlant (the generation source, whose minOnline = fullDraw = its own generation, fleet Σ 5662), the Shield components (modeled by the shield slider), and the weapons-category components (covered by the aggregate gun draw) as if all were system draw. The system reserve (`systemReserve` in `engine/power.ts`) now counts **only** system components; see the RULE-R section at the end of this file for the corrected fleet numbers.


## GC8 component power graph (2026-10-22)

Feasibility probe `scripts/probe6.mjs` (`probe/out/gc8-components.json`, probe cache 397 items) + T17 import pipeline `scripts/build-components.mjs` → **`data/components-cache.json` (committed, git-tracked)**: all equipped items on all 261 spaceships (5181 `equipped_item` ports, **1137 unique class_names**, 100% fetched, 0 HTTP failures) keyed by `class_name` with `{type, power:{minOnline,fullDraw}, coolant:{minOnline,fullDraw}, generation:{power,coolant}}`. Incremental: cached keys are skipped; runs are budgeted via `--maxSeconds` (loop until "remaining: 0"). Retry policy (L1, 2026-10-23): a failed fetch is stored as an `{"error":…, "attempts":n}` sentinel (never bare `null`), counted as "remaining" and retried until `attempts >= 3` (then settled; T18 hard gate still fires in build-data when a power-relevant component joins through a sentinel/null/missing entry).

- **Per-component `resource_network.usage.power {min,max}` = the wiki's "Power Usage X–Y Segments"** (rate × `minimum_fraction` = min: Ecouter radar rate 5 × mf 0.4 → 2–5). The per-state Consumption/Conversion rates **reproduce `used_segments_grouped` exactly** at full draw: Avenger Stalker FC 4 + Radar 5 + Cooler 3+3 + Shield 1+1 + LS 1, Σmax 18 + guns 3.1 = 21.1 = `used_segments_shields`.
- **QuantumDrive draw is absent from `used_segments_grouped`** — per-ship Σmax exceeds grouped−WeaponGun with median residual 3 (= QDrive draw, e.g. the 1–3 pip "Quantum Fuel Tank" usage).
- **Σmin > generation_segments on 7/261 ships** — a ship cannot keep every component online at its minimum; matches the plan's overdraw handling (defaults clamp guns; net can stay red).
- Free pips (generation − Σmin) on the 228-ship snapshot: **p50 = 6, p25 = 4, 10 ships ≤ 0** — the per-component min-based budget is far healthier than the W5 grouped-sum baseline (95% saturation): the plan's T19 allocation model replaces W5.
- **`usage.power` missing only on ToolArm (24 ports), Module (15), WeaponGun (2) = 41 ports** — none power-relevant (fixed-gun power is an API gap; per-gun draw stays the grouped `WeaponGun` aggregate). Turret/Armor/WeaponDefensive/TurretBase/DockingCollar/MissileLauncher carry no `resource_network` at all by design (not powered components).
- Coolers generate coolant via `resource_network.generation.coolant` ≡ `cooler.coolant_segment_generation` (e.g. Bracer S1: 34); PowerPlants carry generation.power = ship `generation_segments` and equal power/coolant usage (PowerBolt 14/14) — cross-check gate for T18.
- Known gap from the probe-cache migration: the 397 power-type entries kept `coolant: null` (the probe cache predated coolant capture; 237 newly fetched items do carry `usage.coolant`). Coolant is schema-reserved only (T-future heat model); deleting those keys re-fetches them with coolant data.

## RULE-R — system-reserve exclusions (2026-10-23, T19/T21)

The component join (above) sums `minOnline` over **every** equipped component, which made
Σmin exceed `powerSegments` on 228/228 ships. That sum is not the system reserve: three
component categories draw power by a **separate** mechanism and must be excluded from
`systemReserve` (`NON_SYSTEM_COMPONENT_TYPES` in `engine/power.ts`), else they double-count
the APU budget:

- **PowerPlant** — `minOnline = fullDraw = the plant's own generation` (fleet Σ 5662). It **is**
  the generation source (supply `S = powerSegments`), not a draw. Displayed read-only.
- **Shield** — the shield components' draw is the **shield slider** (`[shieldMin..shieldPool]`,
  where `shieldPool` = Σ shield `fullDraw`, `shieldMin` = Σ shield `minOnline`), not a system line.
- **Weapons category** (`Turret`, `TurretBase`, `UtilityTurret`, `WeaponGun`, `WeaponDefensive`,
  `MissileLauncher`, `BombLauncher`) — covered by `gunDrawFull` (`gunDraw` + `pdcCount × 1` when
  the PDC toggle is on); display-only in the UI.

Excluded set = `{PowerPlant, Shield, Turret, TurretBase, UtilityTurret, WeaponGun, WeaponDefensive, MissileLauncher, BombLauncher}`;
everything else (Radar, Cooler, LifeSupportGenerator, FlightController, QuantumDrive, TractorBeam,
…) is a system riding a slider. The UI guns list is exactly the weapons subset of the excluded
set (`WEAPONS_POOL_COMPONENT_TYPES` = excluded minus `PowerPlant` and `Shield`); Shield components
render read-only rows under the shield slider.

**QuantumDrive/jump modules are unpowered (2026-10-23):** the app simulates the SCF/NAV
(non-quantum) power state, so `QuantumDrive` — the type jump modules ship as — defaults to
allocation 0 (`DEFAULT_UNPOWERED_TYPES` / `isPoweredByDefault` / `defaultAllocOf` in
`engine/power.ts`). It stays a system for display (user can power it manually via a non-array
allocs value), and the fleet numbers below are computed with it unpowered — the QDrive
`minOnline` (~2–5/ship) is freed.

**Corrected fleet numbers (228-ship snapshot; recomputed 2026-10-23 with QDrive/jump unpowered):**

- Free power (`powerSegments − Σ defaultAllocOf`, i.e. powered-system minOnline):
  **min 6, p25 9, p50 12, p90 19, max 57** — every ship has ≥ 6 free pips, so the model is
  far healthier than the retired W5 grouped-sum baseline (95% saturation).
- Default ladder (`defaultAllocation`: powered systems at their billed minOnline (see
  round-up addendum below), QDrive/jump at 0, PDC
  on, shields at the ALL-ON floor, guns at the MINIMUM powered pips (see below); on
  overdraw PDC→off, then guns→0; shields STAY at the floor; systems never forced
  below minOnline):
  - **Shields/guns opening (2026-10-23):** shield pips open at the floor
    `shieldFloorOn` (Σ pipCost(minOnline), all generators ON — boost headroom left
    to the user); gun pips open at `minGunPipsFull` = the fewest pips whose billed
    cost equals `pipCost(gunDrawFull(…, true))` (full gun draw, fewest pips).
    Sample ships at the new defaults: 600i 8 shield / 8 gun pips (net 0), Gladius
    2/4 (net +5), Hammerhead 4/10 (net +7), Avenger Stalker 2/4 (net +2). The
    planning example guessed "600i: 8 shields / 2 guns" — the snapshot's 600i
    aggregate `gunDraw` is 8 pips at an 8-pip pool, so the honest minimum powered
    figure is **8 gun pips**, not 2 (no per-gun power data to go lower, T17 gap).
  - opening net ≥ 0 on **224/228** ships — the opening (guns full-cost + PDC-on)
    matches the old ladder's end state in cost terms, so the counts stand:
  - PDC-off rung, then guns→0 clears the last ships whose floor fits; full ladder
    clears all but **4/228** (unchanged) — these stay red
    (Fight disabled) because even guns-0 + PDC-off + shields-floor +
    systems-at-defaults exceeds
    their APU: Ironclad (−1), Ironclad Assault (−1), Prowler Utility Wikelo Work Special
    (−3), MISC Hull B (−2). Caterpillar, Caterpillar Pirate and Zeus Mk II ES Wikelo Work
    Special cleared once the QDrive draw was freed. **Escape hatch (per-shield on/off,
    2026-10-23):** the ladder floors at the ALL-ON floor, so these 4 are red only
    at defaults — switching a shield generator OFF frees its `minOnline` (4 pips per
    Stronghold on the Ironclads, 3 per Citadel on the Prowler/MISC) and sliding the
    shield pips down to the reduced ON-set floor clears the overdraw (Ironclad −1 → +3,
    Prowler WWS −3 → 0 net); see the per-shield toggle section below.

**Per-shield generator on/off (2026-10-23).** Every shield generator is individually
toggleable (`ShipConfig.shieldOns`, index-parallel to `components[]`; all on =
default). The shield slider floor derives from the **ON set** — floor = Σ
`pipCost(minOnline)` over ON generators — and the cap follows the **boost ladder**
(2026-10-23): with every generator ON the cap is Σ `pipCost(fullDraw)` (full boost
headroom); with **any generator OFF the cap collapses to the floor** — partial
boost is not modeled, so pips above the reduced floor are unreachable and the
LoadoutPanel shows a "boost locked" note (`shieldFloorOn`/`shieldCapOn` in
`engine/power.ts`). With every generator OFF the floor and cap are 0: **any ship
can run zero shields** (the old "Stronghold ships can never drop shields to 0"
slider note is retired). Fleet facts
(228-ship snapshot): **157 ships carry ≥2 shield components** (117×2, 22×3, 16×4,
2×6; 71×1). Example — Carrack: 2× Barbican `minOnline` 4 / `fullDraw` 5 →
all-on floor 8 = 2×4, cap 10; one OFF → floor 4, cap 4 (locked).

**Online validation** (RSI Ship Owner's Guide, Comm-Link 20263 via
`api.star-citizen.wiki/api/comm-links/20263`): "Each power-consuming component has
properties for **minimum and maximum power units**" with dedicated per-component
power throttles ("most components are managed through dedicated power throttles"),
and high-minOnline components "require a significant amount of power just to
activate" — below `minOnline` the generator is offline and contributes no shield;
with all generators offline the ship has no shields and structure is exposed
(star-citizen.wiki page fetches 404; RSI/Spectrum network-blocked — the Comm-Link
via the wiki API is the primary source, same as the RULE-R citations above).

**Declared sim heuristic:** the API exposes ONE ship-level shield pool
(`shield.hp`/`regenPerSec`, single faceType) with no per-generator hp split, so the
sim scales the pool by `shieldStrengthFactor = shieldFullDrawOn / Σ pipCost(fullDraw
ALL)` — the **fullDraw** ON-sum, deliberately NOT `shieldCapOn`, so the boost
ladder's cap collapse never rescales pool strength (one of two equal
generators OFF → 0.5; all OFF → 0 → the battle starts shields-down and damage hits
structure from round 1). Ship-level absorption (`shieldSplitFor`) is not scaled — no
per-face data exists. The RULE-R fleet numbers above are untouched: the new
`defaultAllocation` opens at the all-ON floor (not max), and the ladder floors
there for every ship, so the 224-clear / 4-red shape and the free min 6/p50 12
figures stand — re-verified by the fleet tests after the defaults change.

**Round-up pip billing (2026-10-23 addendum):** in Star Citizen, power is allocated in
**whole discrete segments** while the API reports **fractional usage** — RSI Ship Owner's
Guide "Components, Power, Signatures" (official Comm-Link 20263, retrieved via
`api.star-citizen.wiki/api/comm-links/20263`): "Power is allocated in segments to
components, which consume these universal units based on their demands" and "Some
components have a minimum power consumption that **displays as combined power
segments**" (the 0.1-minOnline BEHR gatling occupies 1 segment). Data facts in our
snapshot: the only fractional `minOnline`/`fullDraw` fields in `components-cache.json`
are 11 **WeaponGun** fields (0.1, 0.25, 1.13, 1.4, 2.1, 2.93, 4.8) — weapons ride the
guns pool, so no system `minOnline` is fractional; `gunDraw` is fractional on
**147/228** ships; `generation_segments` (supply) is integer on all 228. The engine
therefore bills every pip cost through `pipCost = Math.ceil` (`engine/power.ts`):
system allocations (minOnline and per-alloc), shield pips, and the grouped gun draw at
full power and at the pip fraction (declared heuristic — per-gun data unavailable,
T17). Impact on the RULE-R fleet numbers above: **none** — `ceil` adds < 1 pip, nets
were already integers, and Σ`pipCost(gunDraw)` raises full-power gun cost by only 77.0
pips fleet-wide (spread over fractional-gun ships), all absorbed by the guns→0 ladder
rung: free min 6/p50 12, 44 raw-over, 220 guns-0, 224 ladder, same 4 red ships with
identical nets, verified post-change by the fleet-shape tests.

Golden battles are unaffected: the test harness `fullConfig` sets `powerToWeapons = weaponPool`
(dpsScale 1.0) and `powerToShields = shieldPool` (regen fraction 1.0) with `allocs: []`
(systems at 0), bypassing the default ladder and the Fight gate.

## T23 per-mount weapons (`turretMounts`) (2026-10-23)

The Guns list shows Turret/TurretBase components by **mount** name only (e.g. "Turret:
VariPuck S3 Gimbal Mount", "TurretBase: Manned Turret"). `turretMounts` adds the real
weapons per mount hardpoint (display-only; power still rides in the aggregate guns pool).

**Live API shape (probed 2026-10-23):** all three `turrets` arrays share one entry shape —
`{ category, display_name, hardpoint_name, part_name, turret_type, class_name, size,
mount_count, weapon_sizes, payload_*, mounts, dps_total, sustained_dps_total, alpha_total,
is_pilot_slaveable, weapons[] {uuid, class_name, name, link, web_url, dps, sustained_dps,
alpha, is_pilot_slaveable}, version }`. Weapon entries carry the **gun name** (Hammerhead
manned: 4× "CF-447 Rhino Repeater"; Javelin: 2× "M9A Cannon"; Idris PDC: "M2C \"Swarm\"";
Reclaimer remote: 2× "CF-337 Panther Repeater"). `display_name` is a machine label
("port_NameTurret04", "PDT 1"), `part_name` the hardpoint name — no human mount label
exists, so `mount` is kept for tooltips and the UI heading stays the component name.
**Join key:** the turret entry's `class_name` equals the ports-tree Turret/TurretBase
component `className` (exact string match; 175/191 fleet-wide manned entries join;
non-joins = null-`class_name` entries (Idris tail turret, Javelin upper turrets) and
Valkyrie door guns).

**Emitted field (T23):** `turretMounts: { mount, className, kind: 'manned'|'remote'|'pdc',
weapons: string[] }[]` — entries with null `class_name` or zero weapons (empty mounts,
Reclaimer salvage arms) are dropped; `weapons` are name-deduped with ×N counts
("CF-447 Rhino Repeater ×4"). Builder zod requires the field (always emitted, `[]` when
nothing joins); data.ts validates it `.optional()` (new-field convention: un-regenerated
snapshots boot, UI degrades to plain rows). `weapons[]`/`turretCount` mapping unchanged.

**Deviation from plan (declared):** the plan mapped `turrets.manned` only, but the
user-facing example ships (Avenger line — "VariPuck S3 Gimbal Mount", turretCount 0) have
**all three turret arrays empty**: their gimbal-mount guns exist only as
`weaponry.fixed_weapons` entries, and the API exposes **no mapping from a fixed gun to a
specific mount hardpoint** (the ports tree carries no child weapon under the Turret port;
probe 2026-10-23) — unjoinable, recorded gap. Extending to `remote` + `pdc` covers the
ships where per-mount data exists at all (37 remote + 14 PDC ships).

**UI fallback for the gap (T25, 2026-10-23, declared heuristic):** the Avenger-line/600i
class now lists their fixed guns on the gimbal-mount rows via
`fixedGunPairings` (`src/components/turretMounts.ts`, UI layer, no ships.json change):
after the multiset join consumes its matches, the remaining `ship.weapons[]`
`type === 'fixed'` entries (names already rendered on a matched mount excluded — no
double-listing) pair to the unmatched Turret-family rows in component order — 1:1 by
list order when counts match, round-robin with ×N aggregation (dps summed, alpha shown
once) when guns outnumber mounts, first-G-only when mounts outnumber guns. The API
**still has no per-mount gun truth** for these hardpoints — the pairing is list-order
assumption, declared in the row tooltips. 600i: 3× "M7A Cannon" on the 3 VariPuck S5
gimbals (its 2 remote-turret rows keep the T23 join).

**UI join (LoadoutPanel):** multiset pairing by `className` — the k-th Turret-family
component (types `Turret`, `TurretBase`, `UtilityTurret`) with className K takes the k-th
turretMounts entry of className K (mount classes repeat: 3× "Mount_Gimbal_S3", 11×
"Turret_PDC_BEHR_A"); no match → current "guns pool" detail kept. Verified 1:1 multiset
alignment on Hammerhead (6/6), Javelin (7 mounts ↔ 7 TurretBase components of 13 API
entries — the 6 null-`class_name` entries drop), Idris-M (7 manned + 11 PDC), Reclaimer
(1 manned + 6 remote + 7 PDC).

**Fleet stats (228-ship snapshot, post-join):** 69 ships carry `turretMounts`, 274 entries
(manned 133 / remote 72 / pdc 69); 55 ships have `turretCount > 0`.

## T24 per-weapon stats (`turretMounts.weapons` enrichment) (2026-10-23)

T23 emitted `weapons: string[]` (name ×N). T24 promotes each weapon to an **object** so
the UI can show a real per-weapon line under a mount:
`weapons: { name, size: number|null, dps, alpha, count }[]`. `dps` is the **sum** across
the repeated hardpoint entries, `alpha` is the **max** per-gun alpha, `count` is the
deduped repeat count (Hammerhead Rhino: `dps 3271.6 = 817.9×4`, `count 4`, `alpha 65.4`).

**Size source (probed 2026-10-23):** the turret entry's `weapon_sizes` is an integer array
aligned 1:1 to the raw `weapons[]` (positional join; nameless entries are skipped **without
shifting** the size index). Fallback is a trailing `\bS(\d{1,2})\b` name token; otherwise
`size: null`. Fleet-wide **all 276 mount weapons resolve a non-null size** (0 nulls) after
the positional join — the name-token fallback alone leaves gaps, so the positional
`weapon_sizes` join is load-bearing.

**Schema mirrors (3-way sync):** builder `shipSchema` requires the enriched objects;
`data.ts` keeps `turretMounts` `.optional()` (new-field convention — un-regenerated
snapshots boot and the UI degrades); `engine/types.ts` adds `TurretMountWeapon`. `npm run
build:data` re-run and verified. The Avenger-line VariPuck mounts stay `[]` (no
gun→mount mapping in the API — the T23 gap above stands; the T25 UI fallback now lists
the ships' fixed guns on those rows by order pairing).

## Review fixes 2026-10-23 (quick review of the T23–T25 + per-Shield work)

- **Shared missile-size source** — the per-rack warhead classifier (API naming
  conventions) + the torpedo threshold (size ≥ 5) now live in ONE module,
  `src/engine/missile-size.mjs` (`missileSizeFor`, `MISSILE_TORPEDO_MIN_SIZE`), imported
  by `scripts/build-data.mjs` (ship-level `missiles.size` + `torpedo` flag) and the
  LoadoutPanel rack sub-lines. The T24 UI-layer regex mirror is retired: the displayed
  missile/torpedo class can no longer drift from the simulated flag. `.mjs` so plain
  node (the builder) can import it; `tsconfig allowJs` added.
- **Shield floor bound at the App trust boundary** — `normalizeKnobs`/`toConfig` clamp
  shield pips to **[ON-set floor, ON-set cap]**, not `[0, cap]`. Reachable hole fixed:
  toggling every generator OFF drives cap (and `s`) to 0; toggling one back ON raised
  the floor while `s = 0` survived as a legal sub-floor allocation (generator "ON"
  billing 0 pips — below minOnline is offline per Comm-Link 20263; the all-off case is
  shields-down). Floor is 0 exactly when all generators are off, so shields-off stays
  reachable. Test: `engine.test.ts` "per-Shield floor at the App trust boundary".
