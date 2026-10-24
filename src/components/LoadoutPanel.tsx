import { fmtInt } from '../data';
import {
  DECOY_STRENGTH,
  MISSILE_FUMBLE,
  PHYSICAL_MIX,
  TORPEDO_CM_EFFICIENCY,
  TORPEDO_FIRE_EVERY_ROUNDS,
  TURRET_POWER_PIPS,
  WEAPONS_POOL_COMPONENT_TYPES,
  allocatedPower,
  attackSplitFor,
  crewTurretCap,
  decoyStockFor,
  defaultAllocOf,
  derivedStats,
  fmtPip,
  fullDrawOf,
  gatedLoadout,
  gunCostAt,
  gunDrawFull,
  isSystemComponent,
  missileSizeFor,
  MISSILE_TORPEDO_MIN_SIZE,
  minOnlineOf,
  pipCost,
  powerNotes,
  requiredDecoysFor,
  shieldCapOn,
  shieldFloorOn,
  shieldOnsOf,
  shieldSplitFor,
  shieldStrengthFactor,
} from '../engine';
import type { ShipComponent, ShipConfig, ShipData } from '../engine/types';
import type { SideKnobs } from '../url';
import { ComponentBlocks, ComponentRow, PowerBlocks } from './PowerBlocks';
import { fixedGunPairings, turretMountMatcher } from './turretMounts';

/** T24 rack aggregation key: rack model name with the loadout tokens stripped
 *  ("12xS3", "Quad S5", "Quad", "S4") so identical racks group into "xN" lines
 *  (e.g. 4× "MSD-543 Missile Rack" → "MSD-543 Missile Rack ×4"). */
function missileRackBase(name: string): string {
  return name
    .replace(/\d+\s*x\s*S\d+/gi, ' ')
    .replace(/\bQuad\s+S\d+\b/gi, ' ')
    .replace(/\bQuad\b/gi, ' ')
    .replace(/\bS\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RackGroup {
  base: string;
  size: number;
  count: number;
  firstIndex: number;
}

/** Group the ship's MissileLauncher rack components by (base name, warhead size);
 *  the group renders as ONE aggregated sub-line under its first rack row. The
 *  warhead size comes from the shared single source `missileSizeFor`
 *  (src/engine/missile-size.mjs) — the SAME classifier scripts/build-data.mjs uses
 *  for the ship-level `missiles.size` + torpedo flag, so the rack sub-line's
 *  missile/torpedo label can never drift from the simulated behaviour. */
function missileRackGroups(entries: { c: ShipComponent; i: number }[]): Map<number, RackGroup> {
  const groups = new Map<string, RackGroup>();
  for (const { c, i } of entries) {
    if ((c.type ?? '') !== 'MissileLauncher') continue;
    const size = missileSizeFor({ className: c.className, name: c.name, size: c.size });
    const key = `${missileRackBase(c.name ?? '')}|${size}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { base: missileRackBase(c.name ?? ''), size, count: 1, firstIndex: i });
  }
  const byFirst = new Map<number, RackGroup>();
  for (const g of groups.values()) byFirst.set(g.firstIndex, g);
  return byFirst;
}

/** Per-side loadout editor (plan-power-components T21). Section order: overall-stats
 *  readouts grid directly under the ship name, then the Star Citizen power-tab-style
 *  **Output** display: big live available number
 *  (net = pips − allocated, red when overdrawn) over the total PowerPlant
 *  generation marked **MAX** (PowerPlants are the generation source — no allocatable
  *  Power section). Sections: Guns (pip slider + PDC toggle + read-only
 *  weapon-component list), Shields (ON-set floor-bounded blocks + per-generator
 *  on/off checkboxes — an OFF generator frees its minOnline pips and its share of
 *  shield strength; all OFF = shields fully off), Systems (read-only locked
 *  power blocks via `isSystemComponent` — each system sits at its minOnline default;
 *  the engine `defaultAllocation` is the only allocation source; QuantumDrive/jump
 *  rows show unpowered 0/max). The `.power-notes` lists stay at the bottom.
 *  Non-combat allocations are budget accounting only
 *  (no simulated effect) — every system row carries the "Locked to min. power" tag,
 *  with the full explanation in the title tooltip. */
export function LoadoutPanel({ config, opponent, onChange, onPdcToggle }: {
  config: ShipConfig;
  opponent: ShipData | null;
  onChange: (knobs: SideKnobs) => void;
  onPdcToggle: (on: boolean) => void;
}) {
  const { ship } = config;
  const derived = derivedStats(config);
  const notes = powerNotes(config);
  const gated = opponent ? gatedLoadout(config, opponent, opponent.armor, derived.dpsScale) : null;
  const split = gated ? attackSplitFor(gated) : null;
  const splitTotal = split ? split.shield + split.structure : 0;
  const firing = gated ? gated.fired : 0;
  const deflectedCount = gated ? gated.deflected.reduce((s, d) => s + d.count, 0) : 0;
  const quantum = ship.missiles.damageType === 'distortion';
  const quantumOpp = opponent?.missiles.damageType === 'distortion';

  const set = (patch: Partial<SideKnobs>) => onChange({ uuid: ship.uuid, turrets: config.mannedTurrets, w: config.powerToWeapons, s: config.powerToShields, ...patch });

  const pdcOn = config.pdcOn ?? true;
  const pdcCount = ship.pdcCount ?? 0;
  const components = ship.components ?? [];
  // Opening state per plan Decision 2 (2026-10-23: QDrive/jump unpowered): a missing
  // allocs list = engine `defaultAllocation` semantics — every powered system at
  // minOnline, QuantumDrive/jump at 0.
  const allocs = config.allocs ?? components.map(defaultAllocOf);
  const gunDraw = gunDrawFull(ship, pdcOn);
  const gunFrac = ship.weaponPool > 0 ? Math.min(1, Math.max(0, config.powerToWeapons / ship.weaponPool)) : 0;
  const gunDrawNow = gunCostAt(ship, config.powerToWeapons, pdcOn);
  const gunDrawFullCost = gunDraw > 0 ? pipCost(gunDraw) : 0;
  const allocated = allocatedPower(ship, allocs, config.powerToWeapons, config.powerToShields, pdcOn);
  const available = ship.powerSegments - allocated;
  const generation = components.reduce((s, c) => s + (c.generation?.power ?? 0), 0);
  const maxOutput = generation > 0 ? generation : ship.powerSegments;
  // Per-Shield on/off (2026-10-23): the floor is Σ pipCost(minOnline) over the ON
  // generators; the slider CAP follows the boost-ladder rule (power.ts shieldCapOn):
  // all generators ON ⇒ full pool (Σ fullDraw) + boost room, ANY generator OFF ⇒ cap
  // = the ON-set floor (boost locked). Strength scales by the ON-set fullDraw share.
  // All-off → floor 0, cap 0, factor 0.
  const shieldOns = shieldOnsOf(ship, config.shieldOns);
  const shieldFloorOnV = shieldFloorOn(ship, config.shieldOns);
  const shieldCapOnV = shieldCapOn(ship, config.shieldOns);
  const shieldFactor = shieldStrengthFactor(ship, config.shieldOns);
  const shieldsAllOff = shieldCapOnV === 0 && components.some((c) => (c.type ?? '') === 'Shield');
  const shieldsAnyOff = components.some((c, i) => (c.type ?? '') === 'Shield' && !shieldOns[i]);
  // ON-set regen fraction: allocated pips / ON cap, scaled by the strength factor —
  // the readout shows the ON generators' actual regen share of the all-on pool.
  const shieldFrac = shieldCapOnV > 0 ? Math.min(1, Math.max(0, config.powerToShields / shieldCapOnV)) * shieldFactor : 0;
  const crewCap = crewTurretCap(ship);

  // Per-Shield toggle (PDC-row pattern): flips one generator's on/off; App's
  // normalizeKnobs re-clamps the shield pips into the reduced ON-set cap.
  const toggleShield = (i: number, on: boolean) =>
    set({ shieldOns: shieldOns.map((v, j) => (j === i ? on : v)) });

  const indexed = components.map((c, i) => ({ c, i }));
  const systemComps = indexed.filter(({ c }) => isSystemComponent(c));
  // 2026-10-23: the guns list = the weapons pool types (the old "non-system with no
  // generation" sweep misfiled Shield components under Guns); Shield rows render
  // read-only under the Shields blocks.
  const weaponComps = indexed.filter(({ c }) => WEAPONS_POOL_COMPONENT_TYPES.has(c.type ?? ''));
  const shieldComps = indexed.filter(({ c }) => (c.type ?? '') === 'Shield');
  // T23 join + T25 fixed-gun fallback in one pass (the matcher is stateful — driven
  // exactly once per Turret-family component, in component order).
  const gunPair = fixedGunPairings(ship, weaponComps, turretMountMatcher(ship));
  const missileGroups = missileRackGroups(weaponComps);

  const sizeGrade = (c: ShipComponent) => `${c.size != null ? `S${c.size}` : ''}${c.grade != null ? ` G${c.grade}` : ''}`;
  const rangeText = (c: ShipComponent) => `${fmtPip(minOnlineOf(c))}–${fmtPip(fullDrawOf(c))}`;
  const typeLabel = (c: ShipComponent) => (
    <>{c.type}: {c.name}{sizeGrade(c) && <em className="comp-sg"> {sizeGrade(c)}</em>}</>
  );

  return (
    <div className="loadout">
      <h3>Loadout — {ship.name}</h3>

      <div className="readouts">
        <div><span>Weapon DPS</span><b>{fmtInt(derived.weaponDps)}</b></div>
        <div><span>— fixed</span><b>{fmtInt(derived.fixedDps)}</b></div>
        <div><span>— turrets</span><b>{fmtInt(derived.turretDps)}</b></div>
        <div><span>Power scale</span><b>{Math.round(derived.dpsScale * 100)}%</b></div>
        <div title={`Shield regen = ${fmtInt(ship.shield.regenPerSec)}/s (API) × the pip fraction of the ON generators' cap × the strength factor (${Math.round(shieldFactor * 100)}% — Σ fullDraw of ON generators / Σ all). An OFF generator drops the cap and takes its share of regen with it.`}>
          <span>Shield regen</span><b>{fmtInt(derived.shieldRegen)}/s</b>
        </div>
        <div><span>Shield face</span><b>{ship.shield.faceType}</b></div>
        {split !== null && splitTotal > 0 && (
          <div title="Share of your incoming DPS the foe's shields absorb (the armor gate never touches shields — a deflected gun keeps grinding the shield pool); the rest phases through straight onto their armor (hull once armor is gone)">
            <span>Shield cover vs foe</span><b>{Math.round((split.shield / splitTotal) * 100)}%</b>
          </div>
        )}
        {split !== null && splitTotal > 0 && split.structure > 0 && (
          <div title="Share of your incoming DPS that bypasses the foe's shields (low shield absorption for your damage types, e.g. ballistic) and hits armor/hull directly — only for weapons above the foe's armor gate; gated weapons contribute nothing past the shield">
            <span>Leak past shields</span><b>{Math.round((split.structure / splitTotal) * 100)}%</b>
          </div>
        )}
        {gated && opponent && (
          <div title={`Enemy armor deflect gate ${fmtInt(opponent.armorDeflection.physical)} ballistic / ${fmtInt(opponent.armorDeflection.energy)} energy at full armor: weapons whose per-shot damage is at or below the gate cannot damage armor while the enemy has armor (their shots are still absorbed by the enemy's shields) — the gate shrinks as their armor pool depletes, and marginal weapons resume armor fire`}>
            <span>Through foe's armor gate</span><b>{firing - deflectedCount}/{firing}</b>
          </div>
        )}
        {gated && opponent && (
          <div><span>Effective DPS vs foe</span><b>{fmtInt(gated.dps)}</b></div>
        )}
        {ship.missiles.ammo > 0 && (
          <div title={quantum
            ? `Quantum torpedoes (S${ship.missiles.size} warheads): 1 fired every ${TORPEDO_FIRE_EVERY_ROUNDS} rounds; distortion blast — fully absorbed by enemy shields, strikes structure only when shields are down; armor deflection never stops them; each decoy counts ${TORPEDO_CM_EFFICIENCY}x against them`
            : ship.missiles.torpedo
            ? `Torpedoes (S${ship.missiles.size} warheads): 1 fired every ${TORPEDO_FIRE_EVERY_ROUNDS} rounds; each decoy counts ${TORPEDO_CM_EFFICIENCY}x against them; armor deflection never stops missiles`
            : `Missiles (S${ship.missiles.size}): 1 fired per round from the warload until dry; blast damage bleeds through shields (physical penetration); armor deflection never stops missiles`}>
            <span>{quantum ? 'Quantum torpedoes' : ship.missiles.torpedo ? 'Torpedoes' : 'Missiles'}</span>
            <b>{ship.missiles.ammo} × {fmtInt(ship.missiles.perShot)}</b>
          </div>
        )}
        {ship.countermeasures.decoys > 0 && (
          <div title={`Decoys auto-fired at incoming missiles; need ceil(your IR ${fmtInt(ship.emission.ir)} / ${fmtInt(DECOY_STRENGTH)}) per missile to evade`}>
            <span>Decoy stock</span><b>{fmtInt(decoyStockFor(ship))} ({ship.countermeasures.decoys} launcher{ship.countermeasures.decoys > 1 ? 's' : ''})</b>
          </div>
        )}
        {ship.countermeasures.decoys === 0 && (opponent?.missiles.ammo ?? 0) > 0 && (
          <div title="No decoy launchers: every incoming missile from the foe's warload will hit you">
            <span>Missile defense</span><b>none</b>
          </div>
        )}
      </div>

      <section className="loadout-section output">
        <h4>Output</h4>
        <div
          className="output-display"
          aria-label={`Available power ${fmtPip(available)} pips · maximum ${fmtPip(maxOutput)} from power plant generation`}
          title={`Available = ${ship.powerSegments} APU pips − allocated (systems + shield pips + gun draw at the current pip fraction — every cost billed in whole pips, rounded up) · MAX = total PowerPlant generation · APU budget: ${ship.powerSegments} pips · negative available (overdraw) disables Fight`}
        >
          <div className={`output-value${available < 0 ? ' net-neg' : ''}`} aria-label={`Available power ${fmtPip(available)} pips`}>{fmtPip(available)}</div>
          <div className="output-max" aria-label={`Maximum power output ${fmtPip(maxOutput)} pips`}><b>{fmtPip(maxOutput)}</b><span>MAX</span></div>
        </div>
      </section>

      {ship.turretCount > 0 && (
        <label className="knob">
          <span>
            Manned turrets <b>{config.mannedTurrets}/{ship.turretCount}</b>
            {crewCap < ship.turretCount && <em title="Every manned turret needs a gunner; the pilot seat is not a turret post"> — game-legal max: {crewCap} (crew {ship.crew.max})</em>}
          </span>
          <input
            type="range" min={0} max={ship.turretCount} value={config.mannedTurrets}
            onChange={(e) => set({ turrets: Number(e.target.value) })}
          />
        </label>
      )}

      <section className="loadout-section guns">
        <h4>Guns</h4>
        <PowerBlocks
          kind="weapons"
          label={<>Power to guns <b>{config.powerToWeapons}/{ship.weaponPool}</b> pips — draw {fmtPip(gunDrawNow)} of {fmtPip(gunDrawFullCost)} pips{gunFrac < 1 && <span title="Gun draw scales with the pip fraction, billed in whole pips (a fractional draw occupies the next segment); DPS is cut to the same fraction"> ({Math.round(gunFrac * 100)}%)</span>}</>}
          value={config.powerToWeapons}
          min={0}
          max={ship.weaponPool}
          onChange={(v) => set({ w: v })}
        />
        <div className="gun-draw-note" title="Aggregate gun draw = API grouped fixed-gun usage + manned turrets + PDCs while the toggle is on (declared heuristic: the API exposes no per-weapon/turret power). Fractional API usage occupies whole pips in-game (RSI Ship Owner's Guide, Comm-Link 20263: power is allocated in segments), so the billed draw is rounded up.">
          guns draw {fmtPip(gunDrawFullCost)} pips at full power (API usage {fmtPip(gunDraw)} — fractions occupy whole pips){pdcCount > 0 ? (pdcOn ? `, incl. PDC ${fmtPip(pdcCount * TURRET_POWER_PIPS)}` : ', PDC off') : ''}
        </div>
        {pdcCount > 0 && (
          <label className="pdc-row knob" title={`PDC draw is a declared heuristic: ${pdcCount} × ${TURRET_POWER_PIPS} pip${pdcCount * TURRET_POWER_PIPS === 1 ? '' : 's'} (the API has no per-PDC power). Turning PDCs off frees the pips for other systems.`}>
            <span>
              <input type="checkbox" checked={pdcOn} onChange={(e) => onPdcToggle(e.target.checked)} />
              {' '}PDC × {pdcCount} — draws {fmtPip(pdcCount * TURRET_POWER_PIPS)} pips into the weapons pool when on
            </span>
          </label>
        )}
        {weaponComps.length > 0 && (
          <div className="comp-list">
            {weaponComps.map(({ c, i }) => {
              const mount = gunPair.mounts.get(i) ?? null;
              const rack = missileGroups.get(i);
              // T24 indented sub-lines: one per gun model on a joined turret mount
              // (name deduped with ×N counts, size/dps/alpha from the API), one
              // aggregated line per missile-rack model group, and the T25 fixed-gun
              // fallback lines on turret rows the T23 join left empty (order-pairing
              // heuristic — the API has no gun→mount mapping for these hardpoints).
              // Display-only — power rides in the aggregate guns pool (no per-weapon
              // power in the API).
              const subLines: { label: string; detail: string; title: string }[] = [];
              if (mount) {
                for (const w of mount.weapons) {
                  subLines.push({
                    label: `${w.size != null ? `S${w.size} ` : ''}${w.name}${w.count > 1 ? ` ×${w.count}` : ''}`,
                    detail: `alpha ${fmtInt(w.alpha)} / ${fmtInt(w.dps)} dps`,
                    title: `${w.count} × ${w.name}${w.size != null ? ` (S${w.size})` : ' (size unknown)'} — alpha ${fmtInt(w.alpha)} per shot, ${fmtInt(w.dps)} dps total for the ${w.count} gun${w.count > 1 ? 's' : ''} on this mount (per-gun API values summed; the builder takes the size from the entry-level weapon_sizes array, name-token fallback)`,
                  });
                }
              }
              for (const g of gunPair.byIndex.get(i) ?? []) {
                subLines.push({
                  label: `${g.name}${g.count > 1 ? ` ×${g.count}` : ''}`,
                  detail: `alpha ${fmtInt(g.alpha)} / ${fmtInt(g.dps)} dps`,
                  title: g.count > 1
                    ? `API has no gun→mount mapping for these hardpoints (T23 gap); the ship's ${gunPair.guns} fixed guns were paired to its ${gunPair.mountsTotal} turret-mount rows round-robin by list order (declared heuristic) — ${g.count} × ${g.name} on this row is a count ASSUMPTION of that even distribution, not API truth. alpha ${fmtInt(g.alpha)} per gun (max), dps ${fmtInt(g.dps)} summed across the ${g.count} guns (ship-level weaponry.fixed_weapons entries; no per-gun size in the API, so the hardpoint size shows on the mount row). Display-only: power rides in the aggregate guns pool.`
                    : `API has no gun→mount mapping for these hardpoints (T23 gap); the ship's ${gunPair.guns} fixed gun${gunPair.guns > 1 ? 's' : ''} were paired to its ${gunPair.mountsTotal} turret-mount row${gunPair.mountsTotal > 1 ? 's' : ''} by list order (declared heuristic). ${g.name}: alpha ${fmtInt(g.alpha)} per shot, ${fmtInt(g.dps)} dps (ship-level weaponry.fixed_weapons entry; no per-gun size in the API, so the hardpoint size shows on the mount row). Display-only: power rides in the aggregate guns pool.`,
                });
              }
              if (rack) {
                const kind = rack.size >= MISSILE_TORPEDO_MIN_SIZE ? 'torpedo' : 'missile';
                subLines.push({
                  label: `${rack.base} ×${rack.count}`,
                  detail: `${kind} S${rack.size} · ${fmtInt(ship.missiles.perShot)} blast/shot`,
                  title: `${rack.count} rack${rack.count > 1 ? 's' : ''} of ${rack.base || 'this missile rack'} firing ${kind}s (size ${rack.size >= MISSILE_TORPEDO_MIN_SIZE ? 'at least ' + MISSILE_TORPEDO_MIN_SIZE : 'below ' + MISSILE_TORPEDO_MIN_SIZE} — ${rack.size >= MISSILE_TORPEDO_MIN_SIZE ? 'torpedo' : 'missile'} class, per-rack size from the API naming conventions — shared classifier src/engine/missile-size.mjs, identical to the builder's ship-level torpedo flag). Blast damage is the SHIP-LEVEL API aggregate (${fmtInt(ship.missiles.ammo)} warshots, ${fmtInt(ship.missiles.perShot)} each) — the API exposes no per-rack warhead damage.`,
                });
              }
              const detail = mount
                ? (
                  <span
                    className="mount-weapons"
                    title={`${mount.mount} (${mount.kind} turret): ${mount.weapons.map((w) => (w.count > 1 ? `${w.name} ×${w.count}` : w.name)).join(', ')} — weapons are display-only: the API exposes no per-weapon/per-turret power, so every turret draws from the aggregate guns pool`}
                  >
                    — {mount.weapons.reduce((s, w) => s + w.count, 0)} gun{mount.weapons.reduce((s, w) => s + w.count, 0) === 1 ? '' : 's'} on mount
                  </span>
                )
                : (c.power ? `${rangeText(c)} pips` : `${c.type} · guns pool`);
              return (
                <div className="comp-item" key={i}>
                  <ComponentRow
                    label={typeLabel(c)}
                    detail={detail}
                    title="Weapon-category component — power rides in the aggregate guns pool (no per-weapon power in the API); not individually allocatable"
                  />
                  {subLines.length > 0 && (
                    <div className="comp-sublist">
                      {subLines.map((s, j) => (
                        <div className="comp-sub" key={j} title={s.title}>
                          <span className="comp-sub-label">{s.label}</span>
                          <span className="comp-sub-detail">{s.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="loadout-section shields">
        <h4>Shields</h4>
        <PowerBlocks
          kind="shields"
          label={<>Shields <b>{config.powerToShields}/{shieldCapOnV}</b> pips{shieldCapOnV > 0 && <> — regen {Math.round(shieldFrac * 100)}%</>}{(shieldFloorOnV > 0 || shieldFactor < 1) && <span title="Shield floor = Σ minOnline of the ON generators (whole-pip billing) — a generator toggled OFF frees its minOnline pips, so with every generator OFF the floor is 0 (shields can be dropped completely)"> · floor {fmtPip(shieldFloorOnV)}</span>}{shieldFactor < 1 && <span title="Shield strength factor = Σ fullDraw ON / Σ fullDraw ALL (declared heuristic: the API exposes one ship-level shield pool) — an OFF generator takes its share of shield hp and regen with it"> · strength {Math.round(shieldFactor * 100)}%</span>}</>}
          value={config.powerToShields}
          min={shieldFloorOnV}
          max={shieldCapOnV}
          onChange={(v) => set({ s: v })}
        />
        {shieldsAnyOff && !shieldsAllOff && (
          <div className="gun-draw-note" title="Boost ladder rule (2026-10-23): the whole ship shares ONE shield pool, so pushing pips above the generators' minOnline floor requires every generator online. With a generator OFF each ON generator contributes only its minimum — cap = floor.">
            Boost locked: re-enable all shield generators to add pips above minimum
          </div>
        )}
        {shieldsAllOff && (
          <div className="gun-draw-note" title="Every shield generator toggled OFF: the battle starts shields-down — all incoming damage lands on armor and hull from round 1, and there is no regeneration. Switch a generator back ON to restore its share of the pool.">
            Shields OFF — all damage hits structure
          </div>
        )}
        {shieldComps.length > 0 && (
          <div className="comp-list">
            {shieldComps.map(({ c, i }) => (
              <label
                key={i}
                className="pdc-row knob"
                title={`Shield generator — individually toggleable; OFF frees its minOnline pips (${rangeText(c)} pips) from the shield floor/cap and its share of shield strength (hp & regen). All generators OFF = no shields: all damage hits structure.`}
              >
                <span>
                  <input type="checkbox" checked={shieldOns[i]} onChange={(e) => toggleShield(i, e.target.checked)} />
                  {' '}{c.type}: {c.name}{sizeGrade(c) && <em className="comp-sg"> {sizeGrade(c)}</em>} — {rangeText(c)} pips{shieldOns[i] ? ' · ON' : ' · OFF'}
                </span>
              </label>
            ))}
          </div>
        )}
      </section>

      {systemComps.length > 0 && (
        <section className="loadout-section systems">
          <h4>Systems</h4>
          {systemComps.map(({ c, i }) => (
            <ComponentBlocks
              key={i}
              label={typeLabel(c)}
              value={allocs[i] ?? defaultAllocOf(c)}
              max={fullDrawOf(c)}
              detail={c.type === 'QuantumDrive'
                ? <span className="no-sim-tag" title={`Quantum Drive / Jump Drive (incl. jump modules) ship unpowered: the app simulates the SCF/NAV (non-quantum) power state. ${minOnlineOf(c)} minOnline–fullDraw ${fullDrawOf(c)} pips. Allocation is budget accounting only.`}>Unpowered (non-quantum power state) · {rangeText(c)}</span>
                : <span className="no-sim-tag" title={`Locked at minOnline (${minOnlineOf(c)} of ${fullDrawOf(c)} pips), billed ${fmtPip(pipCost(minOnlineOf(c)))} whole pips (fractional usage occupies the next segment). ${minOnlineOf(c)} minOnline–fullDraw ${fullDrawOf(c)} pips. Allocation is budget accounting only — the app simulates no radar/cooling/flight effects.`}>Locked to min. power · {rangeText(c)} → {fmtPip(pipCost(minOnlineOf(c)))} pip{pipCost(minOnlineOf(c)) === 1 ? '' : 's'}</span>}
              title={c.type === 'QuantumDrive'
                ? `Unpowered (0 of ${fullDrawOf(c)} pips): Quantum Drive / Jump Drive (incl. jump modules) are off because the app simulates the SCF/NAV (non-quantum) power state. ${minOnlineOf(c)} minOnline–fullDraw ${fullDrawOf(c)} pips. Allocation is budget accounting only.`
                : `Locked at minOnline (${minOnlineOf(c)} of ${fullDrawOf(c)} pips), billed ${fmtPip(pipCost(minOnlineOf(c)))} whole pips (fractional usage occupies the next segment). ${minOnlineOf(c)} minOnline–fullDraw ${fullDrawOf(c)} pips. Allocation is budget accounting only — the app simulates no radar/cooling/flight effects.`}
            />
          ))}
        </section>
      )}

      {opponent && ship.missiles.ammo > 0 && opponent.countermeasures.decoys > 0 && (
        <ul className="power-notes">
          <li title={`Their IR signature ${fmtInt(opponent.emission.ir)}: ${ship.missiles.torpedo ? `each of their decoys counts ${TORPEDO_CM_EFFICIENCY}x against your torpedoes (ceil(IR / ${fmtInt(DECOY_STRENGTH * TORPEDO_CM_EFFICIENCY)}))` : `ceil(IR ${fmtInt(opponent.emission.ir)} / ${fmtInt(DECOY_STRENGTH)} decoy strength)`}`}>
            Evading {opponent.name}'s {ship.missiles.torpedo ? 'torpedoes' : 'missiles'} needs {requiredDecoysFor(opponent, ship.missiles.torpedo)} of their {fmtInt(decoyStockFor(opponent))} decoys per shot (~{Math.round((1 - MISSILE_FUMBLE) * 100)}% evade, {Math.round(MISSILE_FUMBLE * 100)}% pilot fumble).
          </li>
        </ul>
      )}
      {opponent && ship.missiles.ammo > 0 && opponent.countermeasures.decoys === 0 && (
        <ul className="power-notes">
          <li>{opponent.name} has no decoy launchers — every missile you fire will land (armor deflection never stops missiles).</li>
        </ul>
      )}
      {opponent && opponent.missiles.ammo > 0 && ship.countermeasures.decoys === 0 && (
        <ul className="power-notes">
          <li>⚠ You have no decoys: {opponent.name}'s {opponent.missiles.ammo} {quantumOpp ? 'quantum torpedoes' : opponent.missiles.torpedo ? 'torpedoes' : 'missiles'} ({fmtInt(opponent.missiles.perShot)} blast each) will all hit{quantumOpp
            ? ' — their distortion blast is fully absorbed by your shields and grinds the pool down, then hits structure at full strength'
            : ` — their ${opponent.missiles.torpedo ? 'torpedo' : 'missile'} salvo bleeds ~${Math.round((1 - shieldSplitFor(ship, PHYSICAL_MIX).shield) * 100)}% past your shields`}.</li>
        </ul>
      )}

      {gated && opponent && deflectedCount > 0 && (
        <ul className="power-notes">
          <li>
            {deflectedCount}/{firing} weapon(s) deflected by {opponent.name}'s armor gate ({fmtInt(opponent.armorDeflection.physical)}P/{fmtInt(opponent.armorDeflection.energy)}E): {gated.deflected.map((d) => (d.count > 1 ? `${d.name}×${d.count}` : d.name)).join(', ')} — no armor damage while their armor holds, but their shields still eat the full hit.
          </li>
        </ul>
      )}

      {notes.length > 0 && (
        <ul className="power-notes">
          {notes.map((n, i) => <li key={i}>{n.text}</li>)}
        </ul>
      )}
    </div>
  );
}
