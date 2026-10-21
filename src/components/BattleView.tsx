import { useEffect, useMemo, useState } from 'react';
import { fmtInt } from '../data';
import { derivedStats, ROUND_SECONDS, simulate } from '../engine';
import type { ShipConfig, ShipRoundState } from '../engine/types';
import { Summary } from './Summary';

type Speed = '0.5' | '1' | '2' | 'instant';

const SPEED_MS: Record<Speed, number> = { '0.5': 2000, '1': 1000, '2': 500, instant: 0 };

function damageTaken(r: ShipRoundState): number {
  return Math.max(0, (r.shieldBefore - r.shieldAfter) + (r.armorBefore - r.armorAfter) + (r.hullBefore - r.hullAfter));
}

export function BattleView({ a, b, seed, shareLink, onEdit }: {
  a: ShipConfig;
  b: ShipConfig;
  seed: number;
  shareLink: string;
  onEdit: () => void;
}) {
  const result = useMemo(() => simulate(a, b, seed), [a, b, seed]);
  const total = result.rounds.length;
  const [shown, setShown] = useState(0);
  const [speed, setSpeed] = useState<Speed>('1');
  const finished = shown >= total;

  useEffect(() => {
    if (speed === 'instant') {
      setShown(total);
      return;
    }
    if (shown >= total) return;
    const id = setInterval(() => setShown((s) => Math.min(total, s + 1)), SPEED_MS[speed]);
    return () => clearInterval(id);
  }, [speed, shown, total]);

  const round = shown > 0 ? result.rounds[shown - 1] : null;
  const stateFor = (side: 'a' | 'b'): ShipRoundState | null => round ? round[side] : null;

  const sideView = (side: 'a' | 'b', cfg: ShipConfig) => {
    const st = stateFor(side);
    const d = derivedStats(cfg);
    const shieldPct = st ? (st.shieldAfter / cfg.ship.shield.hp) * 100 : 100;
    const armorPct = st ? (st.armorAfter / Math.max(1, cfg.ship.armor)) * 100 : 100;
    const hullPct = st ? (Math.max(0, st.hullAfter) / cfg.ship.health) * 100 : 100;
    const taken = st ? damageTaken(st) : 0;
    const shieldsDown = st ? !st.shieldActive : true;
    const extraSegs = Math.max(0, cfg.powerToShields - cfg.ship.shieldPool);
    return (
      <div className={`combatant side-${side}`}>
        <div className="combatant-head">
          {cfg.ship.image ? <img className="combatant-img" src={cfg.ship.image} alt={cfg.ship.name} /> : <div className="combatant-img placeholder">{cfg.ship.sizeClass}</div>}
          <div>
            <div className="combatant-name">{cfg.ship.name}</div>
            <div className="combatant-sub">{cfg.ship.manufacturer} · {cfg.ship.sizeClass}</div>
          </div>
          {taken > 0 && <div className="damage-float" key={`dmg-${side}-${shown}`}>−{fmtInt(taken)}</div>}
        </div>
        <div className={`phase-banner${shieldsDown ? ' down' : ''}`}>
          {shieldsDown
            ? (cfg.ship.armor > 0 && (st ? st.armorAfter > 0 : true) ? 'Shields down — armor exposed' : 'Armor gone — hull exposed')
            : `Shields up (${cfg.ship.shield.faceType})`}
        </div>
        <div className="bar-row">
          <div className="bar-label">🛡</div>
          <div className="bar shield"><div style={{ width: `${shieldPct}%` }} /></div>
          <div className="bar-num">
            {st ? fmtInt(st.shieldAfter) : fmtInt(cfg.ship.shield.hp)}
            <span className="regen-indicator" title={`regen/s, +${extraSegs} bonus seg(s)`}>▲{fmtInt(d.shieldRegen)}/s{extraSegs > 0 ? ` +${extraSegs}` : ''}</span>
          </div>
        </div>
        <div className="bar-row">
          <div className="bar-label">🔩</div>
          <div className="bar armor"><div style={{ width: `${armorPct}%` }} /></div>
          <div className="bar-num">{st ? fmtInt(st.armorAfter) : fmtInt(cfg.ship.armor)}</div>
        </div>
        <div className="bar-row">
          <div className="bar-label">❤</div>
          <div className="bar hull"><div style={{ width: `${hullPct}%` }} /></div>
          <div className="bar-num">{st ? fmtInt(Math.max(0, st.hullAfter)) : fmtInt(cfg.ship.health)}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <header className="header battle-header">
        <button className="btn" onClick={onEdit}>← Edit matchup</button>
        <div className="battle-seed">seed: <code>{seed}</code></div>
        <div className="speeds">
          {(['0.5', '1', '2', 'instant'] as Speed[]).map((s) => (
            <button key={s} className={`btn btn-speed${speed === s ? ' active' : ''}`} onClick={() => setSpeed(s)}>{s === 'instant' ? '⏭' : `${s}×`}</button>
          ))}
          <button className="btn" onClick={() => setShown(0)}>↺</button>
        </div>
      </header>

      <div className="round-counter">Round {Math.min(shown, total)} / {total}</div>

      <div className="battle-grid">
        {sideView('a', a)}
        {sideView('b', b)}
      </div>

      {finished ? (
        <Summary result={result} a={a} b={b} shareLink={shareLink} onEdit={onEdit} />
      ) : (
        <div className="fighting-note">Simulating — {ROUND_SECONDS}s per round</div>
      )}

      <details className="round-log">
        <summary>Round log ({total} rounds)</summary>
        <pre>
          {result.rounds.map((r) => {
            const lines = [
              `round ${r.index}`,
              `  A ${r.a.shieldAfter >= 0 && r.a.shieldActive ? '' : '[down] '}shield ${fmtInt(r.a.shieldBefore)}→${fmtInt(r.a.shieldAfter)} armor ${fmtInt(r.a.armorBefore)}→${fmtInt(r.a.armorAfter)} hull ${fmtInt(r.a.hullBefore)}→${fmtInt(r.a.hullAfter)} (took ${fmtInt(damageTaken(r.a))})`,
              `  B ${r.b.shieldAfter >= 0 && r.b.shieldActive ? '' : '[down] '}shield ${fmtInt(r.b.shieldBefore)}→${fmtInt(r.b.shieldAfter)} armor ${fmtInt(r.b.armorBefore)}→${fmtInt(r.b.armorAfter)} hull ${fmtInt(r.b.hullBefore)}→${fmtInt(r.b.hullAfter)} (took ${fmtInt(damageTaken(r.b))})`,
              ...r.a.events.map((e) => `  A • ${e}`),
              ...r.b.events.map((e) => `  B • ${e}`),
            ];
            return lines.join('\n');
          }).join('\n')}
        </pre>
      </details>

      <footer className="footer">
        Data &amp; images via Star Citizen Wiki API / RSI. Unofficial fan project — not affiliated with CIG.
      </footer>
    </div>
  );
}
