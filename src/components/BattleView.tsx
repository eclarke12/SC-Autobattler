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
    const shieldCur = st ? st.shieldAfter : cfg.ship.shield.hp;
    const armorCur = st ? st.armorAfter : cfg.ship.armor;
    const hullCur = st ? Math.max(0, st.hullAfter) : cfg.ship.health;
    const shieldPct = Math.min(100, (shieldCur / Math.max(1, cfg.ship.shield.hp)) * 100);
    const armorPct = Math.min(100, (armorCur / Math.max(1, cfg.ship.armor)) * 100);
    const hullPct = Math.min(100, (hullCur / Math.max(1, cfg.ship.health)) * 100);
    const taken = st ? damageTaken(st) : 0;
    const shieldsDown = st ? !st.shieldActive : true;
    const extraSegs = Math.max(0, cfg.powerToShields - cfg.ship.shieldPool);
    const shieldBreak = !!st && st.shieldBefore > 0 && st.shieldAfter <= 0;
    const destroyed = !!st && st.hullBefore > 0 && st.hullAfter <= 0;
    const shieldTip = `Shield pool ${fmtInt(shieldCur)} / ${fmtInt(cfg.ship.shield.hp)} · ${cfg.ship.shield.faceType} face · regen ${fmtInt(d.shieldRegen)}/s${extraSegs > 0 ? ` (+${extraSegs} bonus seg${extraSegs === 1 ? '' : 's'})` : ''} · damage this shield absorbs poorly (e.g. ballistic) phases through onto armor`;
    const gateP = cfg.ship.armorDeflection.physical;
    const gateE = cfg.ship.armorDeflection.energy;
    const gateNote = cfg.ship.armor > 0 ? ` · deflect gate ${fmtInt(gateP)} ballistic / ${fmtInt(gateE)} energy` : '';
    const armorTip = `Armor pool ${fmtInt(armorCur)} / ${fmtInt(cfg.ship.armor)} — absorbs after shields drop${gateNote}; shots below the gate deal no damage while armor holds`;
    const hullTip = `Hull integrity ${fmtInt(hullCur)} / ${fmtInt(cfg.ship.health)} — destruction at 0`;
    return (
      <div className={`combatant side-${side}${destroyed ? ' destroyed' : ''}`}>
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
            ? (cfg.ship.armor > 0 && (st ? st.armorAfter > 0 : true) ? `Shields down — armor exposed (gate ${fmtInt(gateP)}P/${fmtInt(gateE)}E)` : 'Armor gone — hull exposed')
            : `Shields up (${cfg.ship.shield.faceType})`}
        </div>
        <div className="bar-row" title={shieldTip}>
          <div className="bar-label">🛡</div>
          <div className="bar shield"><div style={{ width: `${shieldPct}%` }} /></div>
          <div className="bar-num">
            {fmtInt(shieldCur)}
            <span className="regen-indicator" title={`regen/s, +${extraSegs} bonus seg(s)`}>▲{fmtInt(d.shieldRegen)}/s{extraSegs > 0 ? ` +${extraSegs}` : ''}</span>
          </div>
        </div>
        <div className="bar-row" title={armorTip}>
          <div className="bar-label">🔩</div>
          <div className="bar armor"><div style={{ width: `${armorPct}%` }} /></div>
          <div className="bar-num">{fmtInt(armorCur)}</div>
        </div>
        <div className="bar-row" title={hullTip}>
          <div className="bar-label">❤</div>
          <div className="bar hull"><div style={{ width: `${hullPct}%` }} /></div>
          <div className="bar-num">{fmtInt(hullCur)}</div>
        </div>
        {shieldBreak && <div className="shatter-fx" key={`shatter-${side}-${shown}`} />}
        {destroyed && <div className="explosion-fx" key={`boom-${side}-${shown}`} />}
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

      <div className="battle-stage">
        <div className="battle-grid">
          {sideView('a', a)}
          {sideView('b', b)}
        </div>
        {shown > 0 && shown < total && speed !== 'instant' && (
          <div className="projectile-layer" key={`proj-${shown}`}>
            {(['ab', 'ba'] as const).flatMap((sd) =>
              [0, 1, 2].map((i) => (
                <span
                  key={`${sd}-${i}`}
                  className={`projectile ${sd}`}
                  style={{ top: `${40 + i * 10}%`, animationDuration: `${SPEED_MS[speed]}ms`, animationDelay: `${i * 90}ms` }}
                />
              ))
            )}
          </div>
        )}
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
