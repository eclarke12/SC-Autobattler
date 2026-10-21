import { fmtInt } from '../data';
import { derivedStats, powerNotes, shieldFactorFor } from '../engine';
import type { ShipConfig, ShipData } from '../engine/types';
import type { SideKnobs } from '../url';

export function LoadoutPanel({ config, opponent, onChange }: {
  config: ShipConfig;
  opponent: ShipData | null;
  onChange: (knobs: SideKnobs) => void;
}) {
  const { ship } = config;
  const derived = derivedStats(config);
  const notes = powerNotes(config);
  const effShield = opponent ? shieldFactorFor(opponent, derived.damageMix) : null;

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
      <label className="knob">
        <span>Power to weapons <b>{config.powerToWeapons}/{ship.powerSegments}</b> segs (demand {derived.powerDemand})</span>
        <input
          type="range" min={0} max={maxW} value={Math.min(config.powerToWeapons, maxW)}
          onChange={(e) => set({ w: Number(e.target.value) })}
        />
      </label>
      <label className="knob">
        <span>Power to shields <b>{config.powerToShields}</b> segs (pool {ship.shieldPool})</span>
        <input
          type="range" min={0} max={maxS} value={Math.min(config.powerToShields, maxS)}
          onChange={(e) => set({ s: Number(e.target.value) })}
        />
      </label>

      <div className="readouts">
        <div><span>Weapon DPS</span><b>{fmtInt(derived.weaponDps)}</b></div>
        <div><span>— fixed</span><b>{fmtInt(derived.fixedDps)}</b></div>
        <div><span>— turrets</span><b>{fmtInt(derived.turretDps)}</b></div>
        <div><span>Power scale</span><b>{Math.round(derived.dpsScale * 100)}%</b></div>
        <div><span>Shield regen</span><b>{fmtInt(derived.shieldRegen)}/s</b></div>
        <div><span>Shield face</span><b>{ship.shield.faceType}</b></div>
        {effShield !== null && <div><span>Shield cover vs foe</span><b>{Math.round(effShield * 100)}%</b></div>}
      </div>

      {notes.length > 0 && (
        <ul className="power-notes">
          {notes.map((n, i) => <li key={i}>{n.text}</li>)}
        </ul>
      )}
    </div>
  );
}
