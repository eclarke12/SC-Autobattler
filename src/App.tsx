import { useMemo, useState } from 'react';
import { SHIPS, shipByUuid } from './data';
import type { ShipConfig, ShipData } from './engine/types';
import {
  defaultAllocOf,
  defaultAllocation,
  fullDrawOf,
  isOverdrawn,
  isSystemComponent,
  netPower,
} from './engine';
import { ShipPicker } from './components/ShipPicker';
import { LoadoutPanel } from './components/LoadoutPanel';
import { BattleView } from './components/BattleView';
import { decodeMatchup, encodeMatchup, randomSeed, SideKnobs, shareUrl } from './url';

export interface SideSetup {
  ship: ShipData | null;
  knobs: SideKnobs;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const clampTurrets = (v: number, ship: ShipData) => Math.max(0, Math.min(Math.trunc(v), ship.turretCount));

/** Index-parallel to `ship.components[]`: system components (isSystemComponent, RULE-R)
 *  get their allocation clamped to [0, fullDraw]; missing entries fall back to
 *  `defaultAllocOf` (minOnline, 0 for unpowered QuantumDrive/jump); non-system entries
 *  are always 0. */
function fillAllocs(ship: ShipData, alloc: number[] | undefined): number[] {
  return (ship.components ?? []).map((c, i) =>
    isSystemComponent(c) ? clamp(alloc?.[i] ?? defaultAllocOf(c), 0, fullDrawOf(c)) : 0,
  );
}

/** Trust-boundary normalization (plan Decisions: shared-link knobs clamp here,
 *  components add their own defensive caps). Knobs absent from a link fill from
 *  `defaultAllocation(ship)` (T20 opening state: ladder defaults, PDC on), so
 *  legacy links without aw/as/bw/bs/at/bt open at the confirmed opening state,
 *  never guns-off/shields-off. Present knobs decode unchanged (clamped). */
function normalizeKnobs(ship: ShipData, knobs: SideKnobs): SideKnobs {
  const d = defaultAllocation(ship);
  return {
    uuid: ship.uuid,
    turrets: clampTurrets(knobs.turrets ?? ship.turretCount, ship),
    w: clamp(knobs.w ?? d.gunPips, 0, ship.weaponPool),
    s: clamp(knobs.s ?? d.shieldPips, 0, ship.shieldPool),
    alloc: fillAllocs(ship, knobs.alloc),
    pdcOn: typeof knobs.pdcOn === 'boolean' ? knobs.pdcOn : true,
  };
}

function defaultKnobs(ship: ShipData): SideKnobs {
  const d = defaultAllocation(ship);
  return normalizeKnobs(ship, {
    uuid: ship.uuid,
    turrets: ship.turretCount,
    w: d.gunPips,
    s: d.shieldPips,
    alloc: d.allocs,
    pdcOn: d.pdcOn,
  });
}

function toConfig(side: SideSetup): ShipConfig | null {
  if (!side.ship) return null;
  const ship = side.ship;
  const d = defaultAllocation(ship);
  return {
    ship,
    mannedTurrets: clampTurrets(side.knobs.turrets ?? ship.turretCount, ship),
    powerToWeapons: clamp(side.knobs.w ?? d.gunPips, 0, ship.weaponPool),
    powerToShields: clamp(side.knobs.s ?? d.shieldPips, 0, ship.shieldPool),
    allocs: fillAllocs(ship, side.knobs.alloc),
    pdcOn: typeof side.knobs.pdcOn === 'boolean' ? side.knobs.pdcOn : true,
  };
}

function setupFromKnobs(knobs: SideKnobs): SideSetup {
  const ship = shipByUuid.get(knobs.uuid) ?? null;
  return { ship, knobs: ship ? normalizeKnobs(ship, knobs) : defaultKnobs(SHIPS[0]) };
}

/** `net +3` / `net −5` (fractional gun draws → at most 1 dp). */
function fmtNet(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${r < 0 ? '\u2212' : '+'}${Math.abs(r)}`;
}

function NetChip({ net }: { net: number }) {
  return <span className={`net-chip ${net < 0 ? 'net-neg' : 'net-pos'}`}>net {fmtNet(net)}</span>;
}

export function App() {
  const initial = useMemo(() => decodeMatchup(location.hash), []);
  const [a, setA] = useState<SideSetup>(() => (initial ? setupFromKnobs(initial.a) : { ship: null, knobs: defaultKnobs(SHIPS[0]) }));
  const [b, setB] = useState<SideSetup>(() => (initial ? setupFromKnobs(initial.b) : { ship: null, knobs: defaultKnobs(SHIPS[0]) }));
  const [battle, setBattle] = useState<{ a: ShipConfig; b: ShipConfig; seed: number } | null>(() => {
    if (!initial) return null;
    const ca = toConfig(setupFromKnobs(initial.a));
    const cb = toConfig(setupFromKnobs(initial.b));
    if (!ca || !cb) return null;
    // Deep-link overdraw gate: a crafted hash must not auto-start a net<0 battle.
    // Fall through to the setup UI, which shows the existing overdraw note.
    if (isOverdrawn(ca.ship, ca) || isOverdrawn(cb.ship, cb)) return null;
    return { a: ca, b: cb, seed: initial.seed ?? randomSeed() };
  });
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  const setShip = (side: 'a' | 'b', ship: ShipData) => {
    const setter = side === 'a' ? setA : setB;
    setter({ ship, knobs: defaultKnobs(ship) });
  };

  const setKnobs = (side: 'a' | 'b', knobs: SideKnobs) => {
    const setter = side === 'a' ? setA : setB;
    setter((prev) => {
      if (!prev.ship) return { ...prev, knobs };
      return { ...prev, knobs: normalizeKnobs(prev.ship, knobs) };
    });
  };

  const setPdc = (side: 'a' | 'b', pdcOn: boolean) => {
    const setter = side === 'a' ? setA : setB;
    setter((prev) => ({ ...prev, knobs: { ...prev.knobs, pdcOn } }));
  };

  const randomMatchup = () => {
    const shipA = SHIPS[Math.floor(Math.random() * SHIPS.length)];
    const shipB = SHIPS[Math.floor(Math.random() * SHIPS.length)];
    setA({ ship: shipA, knobs: defaultKnobs(shipA) });
    setB({ ship: shipB, knobs: defaultKnobs(shipB) });
    setFocusToken((t) => t + 1);
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
  const netA = ca ? netPower(ca.ship, ca) : null;
  const netB = cb ? netPower(cb.ship, cb) : null;
  const overA = ca ? isOverdrawn(ca.ship, ca) : false;
  const overB = cb ? isOverdrawn(cb.ship, cb) : false;
  const fightDisabled = !ca || !cb || overA || overB;
  const gateNote = overA || overB
    ? [overA && `Ship A power overdraw: net ${fmtNet(netA!)}`, overB && `Ship B power overdraw: net ${fmtNet(netB!)}`]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <div className="app">
      <header className="header">
        <h1>SC Autobattler</h1>
        <p className="tagline">Pick two ships. Tune turrets &amp; power. Watch the app.</p>
        <div className="header-actions">
          <button className="btn" onClick={randomMatchup}>Random matchup</button>
          <button className="btn btn-fight" disabled={fightDisabled} onClick={fight}>⚔ Fight</button>
        </div>
        {gateNote && <p className="fight-gate-note">{gateNote}</p>}
      </header>

      <div className="setup-grid">
        {(['a', 'b'] as const).map((side) => {
          const s = side === 'a' ? a : b;
          const net = side === 'a' ? netA : netB;
          return (
            <section key={side} className={`setup-col side-${side}`}>
              <h2 className={side === 'a' ? 'side-label a' : 'side-label b'}>
                {side === 'a' ? 'Ship A' : 'Ship B'}
                {s.ship && <span className="side-ship-name"> {s.ship.name}</span>}
                {net !== null && <NetChip net={net} />}
              </h2>
              <ShipPicker
                selected={s.ship}
                scope={side}
                onSelect={(ship) => setShip(side, ship)}
                focusToken={focusToken}
              />
              {s.ship && (
                <LoadoutPanel
                  config={toConfig(s)!}
                  opponent={(side === 'a' ? cb?.ship : ca?.ship) ?? null}
                  onChange={(knobs) => setKnobs(side, knobs)}
                  onPdcToggle={(on) => setPdc(side, on)}
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
