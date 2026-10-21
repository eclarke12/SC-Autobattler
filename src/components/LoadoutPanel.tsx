import { fmtInt } from '../data';
import { derivedStats, gatedLoadout, powerNotes, shieldSplitFor } from '../engine';
import type { ShipConfig, ShipData } from '../engine/types';
import type { SideKnobs } from '../url';
import { PowerBlocks } from './PowerBlocks';

export function LoadoutPanel({ config, opponent, onChange }: {
  config: ShipConfig;
  opponent: ShipData | null;
  onChange: (knobs: SideKnobs) => void;
}) {
  const { ship } = config;
  const derived = derivedStats(config);
  const notes = powerNotes(config);
  const gated = opponent ? gatedLoadout(config, opponent, opponent.armor, derived.dpsScale) : null;
  const split = gated && opponent ? shieldSplitFor(opponent, gated.mix) : null;
  const firing = gated ? gated.fired : 0;
  const deflectedCount = gated ? gated.deflected.reduce((s, d) => s + d.count, 0) : 0;

  const set = (patch: Partial<SideKnobs>) => onChange({ uuid: ship.uuid, turrets: config.mannedTurrets, w: config.powerToWeapons, s: config.powerToShields, ...patch });

  const maxW = Math.max(0, ship.powerSegments - config.powerToShields);
  const maxS = Math.max(0, ship.powerSegments - config.powerToWeapons);

  return (
    <div className="loadout">
      <h3>Loadout — {ship.name}</h3>
      {ship.turretCount > 0 && (
        <label className="knob">
          <span>Manned turrets <b>{config.mannedTurrets}/{ship.turretCount}</b></span>
          <input
            type="range" min={0} max={ship.turretCount} value={config.mannedTurrets}
            onChange={(e) => set({ turrets: Number(e.target.value) })}
          />
        </label>
      )}
      <PowerBlocks
        kind="weapons"
        label={<>Power to weapons <b>{config.powerToWeapons}/{ship.powerSegments}</b> segs (demand {derived.powerDemand})</>}
        value={config.powerToWeapons}
        max={maxW}
        onChange={(v) => set({ w: v })}
      />
      <PowerBlocks
        kind="shields"
        label={<>Power to shields <b>{config.powerToShields}</b> segs (pool {ship.shieldPool})</>}
        value={config.powerToShields}
        max={maxS}
        onChange={(v) => set({ s: v })}
      />

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
          <div title={`Enemy armor deflect gate ${fmtInt(opponent.armorDeflection.physical)} ballistic / ${fmtInt(opponent.armorDeflection.energy)} energy: weapons whose per-shot damage is below the gate deal no damage while the enemy has armor`}>
            <span>Through foe's armor gate</span><b>{firing - deflectedCount}/{firing}</b>
          </div>
        )}
        {gated && opponent && (
          <div><span>Effective DPS vs foe</span><b>{fmtInt(gated.dps)}</b></div>
        )}
      </div>

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
