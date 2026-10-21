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
   - Effective shield factor for damage type t: `mid(absorption[t]) − mid(resistance[t])`, clamped to [0, 1]. (Avenger: energy 1.0, physical 0.45−0.125=0.325.)
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
- Gate is modeled as a hard gate: a weapon with `alpha` (per-shot damage) below the defender's deflection for its damage type deals **zero** damage while the defender's armor pool > 0. `alpha` 0 (missing data, 12/927 weapons) is never deflected. When armor is depleted, the gate lifts and full damage hits hull; passes deal full damage to armor with overflow to hull.
- Weapon alpha: `weaponry.fixed_weapons.weapons[].alpha` for fixed guns; `turrets.manned[].weapons[].alpha` max per turret. Turret alpha = max of mount alphas.

Not modeled (per product decision 2026-10-21):
- Weapon penetration as distance/likelihood to damage internals (`items` endpoint has `max_penetration_thickness` in meters — out of scope).
- `armor.penetration_resistance`: exactly 1.0 for physical/energy across all 310 vehicles (distortion 0) → no multiplier applied.
- `armor.damage_multipliers.{type}` (0.65–1.0 armor damage multipliers) — future tunable candidate, not applied.
- The old global 10% flat deflection (`DEFLECTION`) is removed; per-ship gates fully replace it.

Shield interaction: the gate is applied to a weapon's contribution before shields too (hard "will not damage the target" per spec). Damage-type mix and shield factor are computed from the gated (surviving) output, so deflected weapons also stop influencing the shield type factor.

## Shield absorption leak (2026-10-21)

Incoming damage is split per damage type by the defender's shield factor: `factor = mid(absorption) − mid(resistance)` (clamped [0,1]) reaches the shield; the **remainder `(1 − factor)` phases through the shield and hits armor directly** (hull once armor is gone). This matters most for ballistic weapons: fleet shield `absorption.physical` is typically 0–0.45, so most physical damage bypasses energy shields (e.g. Avenger-line factor 0.10–0.33 → 67–90% leak). Energy against full energy absorption (factor 1.0) leaks ~0.

- Implemented as `shieldSplitFor` in `derived.ts`; `applyHit` applies the shield part to the pool every round and the leak part to armor/hull every round (also on the break round: overflow + leak stack).
- No new API fields needed — uses existing `shield.absorption` / `shield.resistance`.
- Deflection gate remains a hard per-weapon gate (deflected weapons contribute nothing to shield, armor, or hull).


## Sample payloads (excerpted)

Avenger Stalker: `health=11900`, `armor.health=1232`, `shield={hp:4488, regeneration:852, regeneration_time:5.27, face_type:"Bubble", reconfiguration_cooldown}`, resistance.physical={min:0,max:0.25} absorption.physical={min:0,max:0.45} absorption.energy={min:1,max:1}, `power={generation_segments:14, used_segments_shields:21.1}`, `power_pools={Shield:{size:2},WeaponGun:{size:4}}`, `weaponry.fixed_weapons.weapons=[{Revenant Gatling dps:1266},{Omnisky IX Cannon dps:546.8}×2]`, pilot_dps 2359.6, `turrets={manned:[],remote:[],pdc:[]}`, images[0].thumbnail_url=`media.starcitizen.tools/thumb/3/34/Avenger_Stalker_...600px...webp`.

Hammerhead (GS): 6 manned turrets, each dps_total=3271.6 (KLWE_LaserRepeater_S4 ×4 mounts), weaponry.turret_dps=19629.6, shield.hp=211200, regeneration=40128/s.

Javelin: 13 manned turret entries (4 with `dps_total:null`), turret_dps=48433.
