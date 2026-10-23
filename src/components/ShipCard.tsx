import { fmtInt, shipTotalDps } from '../data';
import { TORPEDO_FIRE_EVERY_ROUNDS, crewTurretCap } from '../engine';
import type { ShipData } from '../engine/types';

export function ShipCard({ ship, selected, scope, onSelect }: {
  ship: ShipData;
  selected: boolean;
  scope: string;
  onSelect: () => void;
}) {
  const fixed = ship.weapons.filter((w) => w.type === 'fixed');
  const turrets = ship.weapons.filter((w) => w.type === 'turret');
  const turretAvg = ship.turretCount > 0
    ? turrets.reduce((s, w) => s + w.dps, 0) / Math.max(1, turrets.length)
    : 0;

  return (
    <button id={`ship-card-${scope}-${ship.uuid}`} className={`ship-card${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="ship-thumb">
        {ship.image
          ? <img src={ship.image} alt={ship.name} loading="lazy" />
          : <div className="ship-thumb-placeholder">{ship.sizeClass}</div>}
      </div>
      <div className="ship-info">
        <div className="ship-name">{ship.name}</div>
        <div className="ship-meta">{ship.manufacturer} · {ship.sizeClass}{ship.career ? ` · ${ship.career}` : ''}</div>
        <div className="ship-stats">
          <span title="Shield pool">🛡 {fmtInt(ship.shield.hp)}</span>
          <span title={`Armor pool · deflect gate ${fmtInt(ship.armorDeflection.physical)} ballistic / ${fmtInt(ship.armorDeflection.energy)} energy at full armor — attacks at or below the gate deal no damage while armor holds; the gate shrinks as the armor pool depletes`}>🔩 {fmtInt(ship.armor)} ({fmtInt(ship.armorDeflection.physical)}/{fmtInt(ship.armorDeflection.energy)})</span>
          <span title="Hull HP">❤ {fmtInt(ship.health)}</span>
          <span title="Fixed weapon DPS">⚔ {fmtInt(shipTotalDps(ship))}</span>
          {ship.turretCount > 0 && <span title={`Manned turret DPS per turret${crewTurretCap(ship) < ship.turretCount ? ` — game-legal max: ${crewTurretCap(ship)} (crew ${ship.crew.max}): each manned turret needs a gunner beyond the pilot seat` : ''}`}>🎯 {fmtInt(turretAvg)}×{ship.turretCount}{crewTurretCap(ship) < ship.turretCount ? `†${crewTurretCap(ship)}` : ''}</span>}
          {ship.missiles?.ammo > 0 && (
            <span title={ship.missiles.damageType === 'distortion'
              ? `Quantum torpedoes (S${ship.missiles.size} warheads): ${ship.missiles.ammo} × ${fmtInt(ship.missiles.perShot)} distortion blast, fired every ${TORPEDO_FIRE_EVERY_ROUNDS} rounds; fully absorbed by shields, strikes structure once shields drop; very susceptible to countermeasures`
              : ship.missiles.torpedo
              ? `Torpedoes (S${ship.missiles.size} warheads): ${ship.missiles.ammo} × ${fmtInt(ship.missiles.perShot)} blast, fired every ${TORPEDO_FIRE_EVERY_ROUNDS} rounds; very susceptible to countermeasures`
              : `Missile warload (S${ship.missiles.size} missiles): ${ship.missiles.ammo} × ${fmtInt(ship.missiles.perShot)} blast, 1 fired per round; blast bleeds through shields`}>🚀 {ship.missiles.ammo}×{fmtInt(ship.missiles.perShot)}{ship.missiles.damageType === 'distortion' ? ' Q' : ''}</span>
          )}
          {ship.countermeasures?.decoys > 0 && (
            <span title={`Decoy launchers: auto-fires to pull incoming missiles off your IR signature (IR ${fmtInt(ship.emission?.ir ?? 0)})`}>🎇 {ship.countermeasures.decoys}</span>
          )}
        </div>
        <div className="ship-weapons">
          {fixed.slice(0, 6).map((w, i) => (
            <span key={i} className="weapon-chip">{w.name} <em>{fmtInt(w.dps)}</em></span>
          ))}
          {fixed.length > 6 && <span className="weapon-chip">+{fixed.length - 6} more</span>}
        </div>
      </div>
    </button>
  );
}
