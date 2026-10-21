import { fmtInt, shipTotalDps } from '../data';
import type { ShipData } from '../engine/types';

export function ShipCard({ ship, selected, onSelect }: {
  ship: ShipData;
  selected: boolean;
  onSelect: () => void;
}) {
  const fixed = ship.weapons.filter((w) => w.type === 'fixed');
  const turrets = ship.weapons.filter((w) => w.type === 'turret');
  const turretAvg = ship.turretCount > 0
    ? turrets.reduce((s, w) => s + w.dps, 0) / Math.max(1, turrets.length)
    : 0;

  return (
    <button className={`ship-card${selected ? ' selected' : ''}`} onClick={onSelect}>
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
          <span title="Armor pool">🔩 {fmtInt(ship.armor)}</span>
          <span title="Hull HP">❤ {fmtInt(ship.health)}</span>
          <span title="Fixed weapon DPS">⚔ {fmtInt(shipTotalDps(ship))}</span>
          {ship.turretCount > 0 && <span title="Manned turret DPS per turret">🎯 {fmtInt(turretAvg)}×{ship.turretCount}</span>}
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
