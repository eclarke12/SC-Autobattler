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
  crewTurretCap,
  decoyStockFor,
  defaultAllocOf,
  derivedStats,
  fmtPip,
  fullDrawOf,
  gatedLoadout,
  gunDrawFull,
  isSystemComponent,
  minOnlineOf,
  powerNotes,
  requiredDecoysFor,
  shieldSplitFor,
} from '../engine';
import type { ShipComponent, ShipConfig, ShipData } from '../engine/types';
import type { SideKnobs } from '../url';
import { ComponentBlocks, ComponentRow, PowerBlocks } from './PowerBlocks';

/** Per-side loadout editor (plan-power-components T21). Star Citizen power-tab-style
 *  **Output** display directly under the ship name: big live available number
 *  (net = pips − allocated, red when overdrawn) over the total PowerPlant
 *  generation marked **MAX** (PowerPlants are the generation source — no allocatable
 *  Power section). Sections: Guns (pip slider + PDC toggle + read-only
 *  weapon-component list), Shields (floor-bounded blocks), Systems (read-only locked
 *  power blocks via `isSystemComponent` — each system sits at its minOnline default;
 *  the engine `defaultAllocation` is the only allocation source; QuantumDrive/jump
 *  rows show unpowered 0/max). Non-combat allocations are budget accounting only
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
  const split = gated && opponent ? shieldSplitFor(opponent, gated.mix) : null;
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
  const gunDrawNow = gunDraw * gunFrac;
  const allocated = allocatedPower(ship, allocs, config.powerToWeapons, config.powerToShields, pdcOn);
  const available = ship.powerSegments - allocated;
  const generation = components.reduce((s, c) => s + (c.generation?.power ?? 0), 0);
  const maxOutput = generation > 0 ? generation : ship.powerSegments;
  const shieldMin = ship.shieldMin ?? 0;
  const shieldFrac = ship.shieldPool > 0 ? Math.min(1, config.powerToShields / ship.shieldPool) : 0;
  const crewCap = crewTurretCap(ship);

  const indexed = components.map((c, i) => ({ c, i }));
  const systemComps = indexed.filter(({ c }) => isSystemComponent(c));
  // 2026-10-23: the guns list = the weapons pool types (the old "non-system with no
  // generation" sweep misfiled Shield components under Guns); Shield rows render
  // read-only under the Shields blocks.
  const weaponComps = indexed.filter(({ c }) => WEAPONS_POOL_COMPONENT_TYPES.has(c.type ?? ''));
  const shieldComps = indexed.filter(({ c }) => (c.type ?? '') === 'Shield');

  const sizeGrade = (c: ShipComponent) => `${c.size != null ? `S${c.size}` : ''}${c.grade != null ? ` G${c.grade}` : ''}`;
  const rangeText = (c: ShipComponent) => `${fmtPip(minOnlineOf(c))}–${fmtPip(fullDrawOf(c))}`;
  const typeLabel = (c: ShipComponent) => (
    <>{c.type}: {c.name}{sizeGrade(c) && <em className="comp-sg"> {sizeGrade(c)}</em>}</>
  );

  return (
    <div className="loadout">
      <h3>Loadout — {ship.name}</h3>

      <section className="loadout-section output">
        <h4>Output</h4>
        <div
          className="output-display"
          aria-label={`Available power ${fmtPip(available)} pips · maximum ${fmtPip(maxOutput)} from power plant generation`}
          title={`Available = ${ship.powerSegments} APU pips − allocated (systems + shield pips + gun draw at the current pip fraction) · MAX = total PowerPlant generation · APU budget: ${ship.powerSegments} pips · negative available (overdraw) disables Fight`}
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
          label={<>Power to guns <b>{config.powerToWeapons}/{ship.weaponPool}</b> pips — draw {fmtPip(gunDrawNow)} of {fmtPip(gunDraw)} pips{gunFrac < 1 && <span title="Gun draw scales with the pip fraction; DPS is cut to the same fraction"> ({Math.round(gunFrac * 100)}%)</span>}</>}
          value={config.powerToWeapons}
          min={0}
          max={ship.weaponPool}
          onChange={(v) => set({ w: v })}
        />
        <div className="gun-draw-note" title="Aggregate gun draw = API grouped fixed-gun usage + manned turrets + PDCs while the toggle is on (declared heuristic: the API exposes no per-weapon/turret power)">
          guns draw {fmtPip(gunDraw)} pips at full power{pdcCount > 0 ? (pdcOn ? ` (incl. PDC ${fmtPip(pdcCount * TURRET_POWER_PIPS)})` : ' (PDC off)') : ''}
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
            {weaponComps.map(({ c, i }) => (
              <ComponentRow
                key={i}
                label={typeLabel(c)}
                detail={c.power ? `${rangeText(c)} pips` : `${c.type} · guns pool`}
                title="Weapon-category component — power rides in the aggregate guns pool (no per-weapon power in the API); not individually allocatable"
              />
            ))}
          </div>
        )}
      </section>

      <section className="loadout-section shields">
        <h4>Shields</h4>
        <PowerBlocks
          kind="shields"
          label={<>Shields <b>{config.powerToShields}/{ship.shieldPool}</b> pips — regen {Math.round(shieldFrac * 100)}%{shieldMin > 0 && <span title="Shield floor = Σ shield minOnline — shields can never be set below this"> · floor {shieldMin}</span>}</>}
          value={config.powerToShields}
          min={shieldMin}
          max={ship.shieldPool}
          onChange={(v) => set({ s: v })}
        />
        {shieldComps.length > 0 && (
          <div className="comp-list">
            {shieldComps.map(({ c, i }) => (
              <ComponentRow
                key={i}
                label={typeLabel(c)}
                detail={c.power ? `${rangeText(c)} pips · shield slider` : `${c.type} · shield slider`}
                title="Shield component — the shield slider models it (floor = Σ shield minOnline, cap = Σ shield fullDraw); not individually allocatable"
              />
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
                : <span className="no-sim-tag" title={`Locked at minOnline (${minOnlineOf(c)} of ${fullDrawOf(c)} pips). ${minOnlineOf(c)} minOnline–fullDraw ${fullDrawOf(c)} pips. Allocation is budget accounting only — the app simulates no radar/cooling/flight effects.`}>Locked to min. power · {rangeText(c)}</span>}
              title={c.type === 'QuantumDrive'
                ? `Unpowered (0 of ${fullDrawOf(c)} pips): Quantum Drive / Jump Drive (incl. jump modules) are off because the app simulates the SCF/NAV (non-quantum) power state. ${minOnlineOf(c)} minOnline–fullDraw ${fullDrawOf(c)} pips. Allocation is budget accounting only.`
                : `Locked at minOnline (${minOnlineOf(c)} of ${fullDrawOf(c)} pips). ${minOnlineOf(c)} minOnline–fullDraw ${fullDrawOf(c)} pips. Allocation is budget accounting only — the app simulates no radar/cooling/flight effects.`}
            />
          ))}
        </section>
      )}

      <div className="readouts">
        <div><span>Weapon DPS</span><b>{fmtInt(derived.weaponDps)}</b></div>
        <div><span>— fixed</span><b>{fmtInt(derived.fixedDps)}</b></div>
        <div><span>— turrets</span><b>{fmtInt(derived.turretDps)}</b></div>
        <div><span>Power scale</span><b>{Math.round(derived.dpsScale * 100)}%</b></div>
        <div><span>Shield regen</span><b>{fmtInt(derived.shieldRegen)}/s</b></div>
        <div><span>Shield face</span><b>{ship.shield.faceType}</b></div>
        {split !== null && (
          <div title="Share of your effective DPS the foe's shields absorb; the rest phases through straight onto their armor (hull once armor is gone)">
            <span>Shield cover vs foe</span><b>{Math.round(split.shield * 100)}%</b>
          </div>
        )}
        {split !== null && split.structure > 0 && (
          <div title="Share of your effective DPS that bypasses the foe's shields (low shield absorption for your damage types, e.g. ballistic) and hits armor/hull directly">
            <span>Leak past shields</span><b>{Math.round(split.structure * 100)}%</b>
          </div>
        )}
        {gated && opponent && (
          <div title={`Enemy armor deflect gate ${fmtInt(opponent.armorDeflection.physical)} ballistic / ${fmtInt(opponent.armorDeflection.energy)} energy at full armor: weapons whose per-shot damage is at or below the gate deal no damage while the enemy has armor — the gate shrinks as their armor pool depletes, and marginal weapons resume fire`}>
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
            {deflectedCount}/{firing} weapon(s) deflected by {opponent.name}'s armor gate ({fmtInt(opponent.armorDeflection.physical)}P/{fmtInt(opponent.armorDeflection.energy)}E): {gated.deflected.map((d) => (d.count > 1 ? `${d.name}×${d.count}` : d.name)).join(', ')} — zero damage while their armor holds.
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
