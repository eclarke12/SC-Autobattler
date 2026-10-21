import { useState } from 'react';
import { fmtInt } from '../data';
import { powerNotes, ROUND_SECONDS } from '../engine';
import type { BattleResult, ShipConfig } from '../engine/types';
import { DAMAGE_TYPES } from '../engine/types';

const W = 620;
const H = 160;

function pctSeries(values: number[], max: number): string {
  const n = values.length;
  if (n === 0) return '';
  return values
    .map((v, i) => `${(4 + (i * (W - 8)) / Math.max(1, n - 1)).toFixed(1)},${(H - 6 - (Math.max(0, v) / Math.max(1, max)) * (H - 12)).toFixed(1)}`)
    .join(' ');
}

const SERIES = [
  { key: 'shield', label: 'shield', dash: '' },
  { key: 'armor', label: 'armor', dash: '6 3' },
  { key: 'hull', label: 'hull', dash: '2 3' },
] as const;

export function Summary({ result, a, b, shareLink, onEdit }: {
  result: BattleResult;
  a: ShipConfig;
  b: ShipConfig;
  shareLink: string;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const s = result.summary;

  const seriesFor = (cfg: ShipConfig) => {
    const maxShield = cfg.ship.shield.hp;
    const maxArmor = Math.max(1, cfg.ship.armor);
    const maxHull = cfg.ship.health;
    const mk = (key: 'shield' | 'armor' | 'hull', max: number) => {
      const vals: number[] = [];
      for (const r of result.rounds) vals.push(r[cfg === a ? 'a' : 'b'][`${key}After`] as number);
      return { pts: pctSeries(vals, max), max };
    };
    return {
      shield: mk('shield', maxShield),
      armor: mk('armor', maxArmor),
      hull: mk('hull', maxHull),
    };
  };

  const sa = seriesFor(a);
  const sb = seriesFor(b);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const sidePanel = (cfg: ShipConfig, key: 'a' | 'b') => {
    const side = s.sides[key];
    const derived = side.derived;
    const totalDealt = Math.max(1, side.totalDamageDealt);
    const turretShare = derived.weaponDps > 0 ? derived.turretDps / Math.max(1, derived.fixedDps + derived.turretDps) : 0;
    return (
      <div className={`summary-side side-${key}`}>
        <h3>{side.shipName}</h3>
        <div className="summary-row"><span>Total damage dealt</span><b>{fmtInt(side.totalDamageDealt)}</b></div>
        <div className="summary-row"><span>Damage mix (fixed vs turret)</span><b>{Math.round((1 - turretShare) * 100)}% / {Math.round(turretShare * 100)}%</b></div>
        <div className="summary-row"><span>Shield down time</span><b>{fmtInt(side.shieldDownRounds * ROUND_SECONDS)}s{side.firstShieldBreakRound !== null ? ` (first break round ${side.firstShieldBreakRound})` : ''}</b></div>
        <div className="summary-row"><span>Hull at end</span><b>{Math.round(side.hullPctAtEnd * 100)}%</b></div>
        <div className="dps-breakdown">
          {DAMAGE_TYPES.filter((t) => side.damageByType[t] > 0).map((t) => (
            <div key={t} className="dtype-row">
              <span className="dtype-name">{t}</span>
              <div className="dtype-bar"><div style={{ width: `${(side.damageByType[t] / totalDealt) * 100}%` }} /></div>
              <b>{fmtInt(side.damageByType[t])}</b>
            </div>
          ))}
        </div>
        <ul className="power-notes">
          {powerNotes(cfg).map((n, i) => <li key={i}>{n.text}</li>)}
          {powerNotes(cfg).length === 0 && <li>Power allocation is efficient.</li>}
        </ul>
      </div>
    );
  };

  return (
    <section className="summary">
      <h2 className="summary-title">
        {s.winner === 'draw' ? 'Draw — time limit' : `Winner: ${s.winnerName}`}
        <span className="summary-rounds"> · {s.totalRounds} rounds · seed {s.seed}</span>
      </h2>

      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} className="timeline" role="img" aria-label="Battle timeline">
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={4} x2={W - 4} y1={H - 6 - g * (H - 12)} y2={H - 6 - g * (H - 12)} className="chart-grid" />
          ))}
          {([['a', sa, 'var(--side-a)'], ['b', sb, 'var(--side-b)']] as const).map(([key, series, color]) => (
            SERIES.map((se) => (
              <polyline
                key={`${key}-${se.key}`}
                points={series[se.key].pts}
                fill="none"
                stroke={color}
                strokeDasharray={se.dash}
                strokeWidth={key === 'a' ? 2 : 1.5}
                opacity={se.key === 'hull' ? 1 : se.key === 'shield' ? 0.85 : 0.6}
              />
            ))
          ))}
        </svg>
        <div className="chart-legend">
          <span style={{ color: 'var(--side-a)' }}>■ Side A</span>
          <span style={{ color: 'var(--side-b)' }}>■ Side B</span>
          <span>solid: shield · dashed: armor · dotted: hull</span>
        </div>
      </div>

      <div className="summary-grid">
        {sidePanel(a, 'a')}
        {sidePanel(b, 'b')}
      </div>

      <div className="share-box">
        <input readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn" onClick={copy}>{copied ? 'Copied!' : 'Copy share URL'}</button>
        <button className="btn" onClick={onEdit}>Rematch (edit)</button>
      </div>
    </section>
  );
}
