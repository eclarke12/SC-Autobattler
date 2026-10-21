import { useMemo, useState } from 'react';
import { SHIPS, shipByUuid } from './data';
import type { ShipConfig, ShipData } from './engine/types';
import { ShipPicker } from './components/ShipPicker';
import { LoadoutPanel } from './components/LoadoutPanel';
import { BattleView } from './components/BattleView';
import { decodeMatchup, encodeMatchup, randomSeed, SideKnobs, shareUrl } from './url';

export interface SideSetup {
  ship: ShipData | null;
  knobs: SideKnobs;
}

function defaultKnobs(ship: ShipData): SideKnobs {
  const w = Math.min(ship.weaponPool, ship.powerSegments);
  const s = Math.min(ship.shieldPool, ship.powerSegments - w);
  return { uuid: ship.uuid, turrets: ship.turretCount, w, s };
}

function toConfig(side: SideSetup): ShipConfig | null {
  if (!side.ship) return null;
  return {
    ship: side.ship,
    mannedTurrets: Math.min(side.knobs.turrets, side.ship.turretCount),
    powerToWeapons: side.knobs.w,
    powerToShields: side.knobs.s,
  };
}

function setupFromKnobs(knobs: SideKnobs): SideSetup {
  const ship = shipByUuid.get(knobs.uuid) ?? null;
  return { ship, knobs: ship ? knobs : defaultKnobs(SHIPS[0]) };
}

export function App() {
  const initial = useMemo(() => decodeMatchup(location.hash), []);
  const [a, setA] = useState<SideSetup>(() => (initial ? setupFromKnobs(initial.a) : { ship: null, knobs: defaultKnobs(SHIPS[0]) }));
  const [b, setB] = useState<SideSetup>(() => (initial ? setupFromKnobs(initial.b) : { ship: null, knobs: defaultKnobs(SHIPS[0]) }));
  const [battle, setBattle] = useState<{ a: ShipConfig; b: ShipConfig; seed: number } | null>(() => {
    if (!initial) return null;
    const ca = toConfig(setupFromKnobs(initial.a));
    const cb = toConfig(setupFromKnobs(initial.b));
    return ca && cb ? { a: ca, b: cb, seed: initial.seed } : null;
  });
  const [shareLink, setShareLink] = useState<string | null>(null);

  const setShip = (side: 'a' | 'b', ship: ShipData) => {
    const setter = side === 'a' ? setA : setB;
    setter({ ship, knobs: defaultKnobs(ship) });
  };

  const setKnobs = (side: 'a' | 'b', knobs: SideKnobs) => {
    const setter = side === 'a' ? setA : setB;
    setter((prev) => ({ ...prev, knobs }));
  };

  const randomMatchup = () => {
    const pick = () => SHIPS[Math.floor(Math.random() * SHIPS.length)];
    setA({ ship: pick(), knobs: defaultKnobs(pick()) });
    setB({ ship: pick(), knobs: defaultKnobs(pick()) });
  };

  const fight = () => {
    const ca = toConfig(a);
    const cb = toConfig(b);
    if (!ca || !cb) return;
    const seed = randomSeed();
    setBattle({ a: ca, b: cb, seed });
    location.hash = encodeMatchup({ a: a.knobs, b: b.knobs, seed });
    setShareLink(shareUrl({ a: a.knobs, b: b.knobs, seed }));
    window.scrollTo(0, 0);
  };

  if (battle) {
    return (
      <BattleView
        a={battle.a}
        b={battle.b}
        seed={battle.seed}
        shareLink={shareLink ?? shareUrl({ a: a.knobs, b: b.knobs, seed: battle.seed })}
        onEdit={() => {
          setBattle(null);
          location.hash = '';
        }}
      />
    );
  }

  const ca = toConfig(a);
  const cb = toConfig(b);

  return (
    <div className="app">
      <header className="header">
        <h1>SC Autobattler</h1>
        <p className="tagline">Pick two ships. Tune turrets &amp; power. Watch the sim.</p>
        <div className="header-actions">
          <button className="btn" onClick={randomMatchup}>Random matchup</button>
          <button className="btn btn-fight" disabled={!ca || !cb} onClick={fight}>⚔ Fight</button>
        </div>
      </header>

      <div className="setup-grid">
        {(['a', 'b'] as const).map((side) => {
          const s = side === 'a' ? a : b;
          return (
            <section key={side} className={`setup-col side-${side}`}>
              <h2 className={side === 'a' ? 'side-label a' : 'side-label b'}>
                {side === 'a' ? 'Side A' : 'Side B'}
                {s.ship && <span className="side-ship-name"> {s.ship.name}</span>}
              </h2>
              <ShipPicker
                selected={s.ship}
                onSelect={(ship) => setShip(side, ship)}
                exclude={side === 'a' ? b.ship?.uuid : a.ship?.uuid}
              />
              {s.ship && (
                <LoadoutPanel
                  config={toConfig(s)!}
                  opponent={(side === 'a' ? cb?.ship : ca?.ship) ?? null}
                  onChange={(knobs) => setKnobs(side, knobs)}
                />
              )}
            </section>
          );
        })}
      </div>

      <footer className="footer">
        Data &amp; images via Star Citizen Wiki API / RSI. Unofficial fan project — not affiliated with CIG.
      </footer>
    </div>
  );
}
