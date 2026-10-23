import { MAX_ROUNDS, ROUND_SECONDS, TORPEDO_FIRE_EVERY_ROUNDS, VARIANCE } from './constants';
import { armorRatioOf, decoyEvadeChance, decoyStockFor, deflectionFor, derivedStats, effectiveGate, gatedLoadout, gunAmmoInfo, requiredDecoysFor, shieldSplitFor } from './derived';
import type { GatedAttack } from './derived';
import { mulberry32 } from './rng';
import type {
  BattleResult,
  BattleSummary,
  DamageType,
  Phase,
  Round,
  ShipConfig,
  ShipData,
  ShipRoundState,
  SideSummary,
} from './types';
import { DAMAGE_TYPES } from './types';

interface CombatState {
  ship: ShipData;
  shield: number;
  shieldMax: number;
  armor: number;
  hull: number;
  hullMax: number;
  shieldActive: boolean;
  downRoundsLeft: number;
  shieldBrokenAtRound: number | null;
  shieldDownRounds: number;
  totalDamageDealt: number;
  damageByType: Record<DamageType, number>;
  missilesLeft: number;
  missilesFired: number;
  missilesEvaded: number;
  missilesHit: number;
  decoysLeft: number;
  /** Shots remaining per weapon, index-aligned with `ship.weapons` (W4). `Infinity` =
   *  infinite (energy lasers draw ship power; alpha-0 guns have unknown fire rate). */
  ammoLeft: number[];
  /** Shots each weapon consumes per round (0 for infinite-ammo weapons). */
  shotsPerRound: number[];
  /** Weapons whose ammunition has run dry (W4 → SideSummary.gunsDryRounds). */
  gunsDry: number;
}

function initState(ship: ShipData): CombatState {
  const ammo = ship.weapons.map((w) => gunAmmoInfo(w, ROUND_SECONDS));
  return {
    ship,
    shield: ship.shield.hp,
    shieldMax: ship.shield.hp,
    armor: ship.armor,
    hull: ship.health,
    hullMax: ship.health,
    shieldActive: true,
    downRoundsLeft: 0,
    shieldBrokenAtRound: null,
    shieldDownRounds: 0,
    totalDamageDealt: 0,
    damageByType: { physical: 0, energy: 0, distortion: 0, thermal: 0, biochemical: 0, stun: 0 },
    missilesLeft: ship.missiles?.ammo ?? 0,
    missilesFired: 0,
    missilesEvaded: 0,
    missilesHit: 0,
    decoysLeft: decoyStockFor(ship),
    ammoLeft: ship.weapons.map((w) => (w.ammo === null ? Number.POSITIVE_INFINITY : w.ammo)),
    shotsPerRound: ammo.map((a) => a.perRound),
    gunsDry: 0,
  };
}

/** W4 gun-ammo consumption: only weapons the side actually fired this round (per
 *  `gatedLoadout`'s fired predicate — deflected shots included, a deflected shot left the
 *  barrel) spend their per-round burst; unpowered (0 dps), dry and ammo-less weapons are
 *  skipped, and a weapon goes dry at the end of the round it fires its last magazine. */
function depleteGuns(state: CombatState, roundIndex: number, events: string[], firedIndices: number[]): void {
  for (const i of firedIndices) {
    const w = state.ship.weapons[i];
    const left = state.ammoLeft[i];
    if (!Number.isFinite(left) || left <= 0) continue;
    const after = left - state.shotsPerRound[i];
    state.ammoLeft[i] = Math.max(0, after);
    if (state.ammoLeft[i] === 0) {
      state.gunsDry++;
      events.push(`${w.name} ammunition depleted at round ${roundIndex} (${state.shotsPerRound[i]} shots/round) — silent from the next round`);
    }
  }
}

function currentPhase(s: CombatState): Phase {
  if (s.shieldActive && s.shield > 0) return 'shield';
  if (s.armor > 0) return 'armor';
  return 'hull';
}

/** Apply one round of incoming damage (post deflection-gate, post-variance) split into the
 *  shield-absorbed part and the per-damage-type parts phasing through shields onto
 *  armor/hull. Armor HP is consumed at dmg × armorMultipliers[type]; the structural hull
 *  takes raw damage (A4, 2026-10-22). Armor depletion overflow carries to hull, split by
 *  the attacker's damage mix. Mutates state. */
function applyHit(def: CombatState, shieldPart: number, structByType: Record<DamageType, number>, mix: Record<DamageType, number>, roundIndex: number, events: string[]): number {
  let applied = 0;
  if (def.shieldActive && def.shield > 0) {
    def.shield -= shieldPart;
    applied += shieldPart;
    applied += applyToStructure(def, structByType, events);
    if (def.shield <= 0) {
      const overflow = -def.shield;
      def.shield = 0;
      def.shieldActive = false;
      def.downRoundsLeft = Math.max(1, Math.ceil(def.ship.shield.reconfigurationCooldown / ROUND_SECONDS));
      if (def.shieldBrokenAtRound === null) def.shieldBrokenAtRound = roundIndex;
      events.push(`Shields broken at round ${roundIndex} (shield cover ${(shieldPart / Math.max(1e-9, shieldPart + sumTypes(structByType)) * 100).toFixed(0)}%), overflow ${fmt(overflow)} to armor; down for ${def.downRoundsLeft} round(s)`);
      applied += applyToStructure(def, scaleMix(mix, overflow), events);
    }
  } else {
    applied += applyToStructure(def, scaleMix(mix, shieldPart + sumTypes(structByType)), events);
  }
  return applied;
}

function applyToStructure(def: CombatState, rawByType: Record<DamageType, number>, events: string[]): number {
  const mults = def.ship.armorMultipliers;
  let raw = 0;
  let armorDamage = 0;
  for (const t of DAMAGE_TYPES) {
    raw += rawByType[t];
    armorDamage += rawByType[t] * (mults?.[t] ?? 1);
  }
  const hullRaw = raw;
  let applied = 0;
  if (def.armor > 0) {
    const toArmor = Math.min(def.armor, armorDamage);
    def.armor -= toArmor;
    applied += toArmor;
  }
  const rest = hullRaw - applied;
  if (rest > 0) {
    def.hull -= rest;
    applied += rest;
    if (def.hull <= 0) events.push(`Hull breached — destroyed`);
  }
  return applied;
}

function sumTypes(byType: Record<DamageType, number>): number {
  return DAMAGE_TYPES.reduce((s, t) => s + byType[t], 0);
}

function scaleMix(mix: Record<DamageType, number>, v: number): Record<DamageType, number> {
  const out = {} as Record<DamageType, number>;
  for (const t of DAMAGE_TYPES) out[t] = mix[t] * v;
  return out;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Missile blast damage mix: full explosive damage as physical, so it routes through
 *  the existing shield absorption leak model (shared with the UI). */
export const PHYSICAL_MIX: Record<DamageType, number> = {
  physical: 1, energy: 0, distortion: 0, thermal: 0, biochemical: 0, stun: 0,
};

/** Quantum (distortion) blast mix: distortion is fully absorbed by shields fleet-wide
 *  (absorption {1,1}, probe GC5) and undeflectable (deflection 0 fleet-wide) — quantum
 *  torpedoes grind shield pools and strike structure only once shields are down. */
const DISTORTION_MIX: Record<DamageType, number> = {
  physical: 0, energy: 0, distortion: 1, thermal: 0, biochemical: 0, stun: 0,
};

/** Ordinance kind label from the warload: quantum (distortion) racks → 'Quantum torpedo',
 *  torpedo-size racks → 'Torpedo', else 'Missile'. Engine-authoritative so the UI and
 *  event-string matching share one label source (Finding 9). */
export function ordnanceKindLabel(m: ShipData['missiles']): 'Quantum torpedo' | 'Torpedo' | 'Missile' {
  return m.damageType === 'distortion' ? 'Quantum torpedo' : m.torpedo ? 'Torpedo' : 'Missile';
}

/** One missile salvo per firing side per cadence, resolved with the defender's decoys.
 *  Per-missile decoy semantics (C3/C4, 2026-10-22): against each incoming missile the
 *  defender commits `min(required, stockLeft)` charges; a seeded roll evades with
 *  `P = (1 − MISSILE_FUMBLE) × committed/required` — a full barrage evades everything
 *  except the pilot-fumble share, a partial barrage only partially protects, zero stock
 *  never evades. The committed charges burn on hit AND on evade (in-game a launched flare
 *  is spent either way — fixes the old bug where an impact burned the entire stock).
 *  Impacts bypass the armor deflection gate entirely (O1: explosives and quantum have
 *  deflection 0 in-game — decoys and maneuver are the defense) and deal blast damage as
 *  physical (or distortion for quantum racks, O3), bleeding through shields via the
 *  absorption leak model. Mutates both states. */
function missilePhase(att: CombatState, def: CombatState, variance: number, round: number, atkEvents: string[], defEvents: string[], rand: () => number): void {
  const m = att.ship.missiles;
  if (!m || m.ammo <= 0 || att.missilesLeft <= 0) return;
  const interval = m.torpedo ? TORPEDO_FIRE_EVERY_ROUNDS : 1;
  if ((round - 1) % interval !== 0) return;

  att.missilesLeft--;
  att.missilesFired++;
  const quantum = m.damageType === 'distortion';
  const kind = ordnanceKindLabel(m);
  atkEvents.push(`${kind} fired (${att.missilesLeft} left)`);

  const required = requiredDecoysFor(def.ship, m.torpedo);
  const stockBefore = def.decoysLeft;
  const committed = Math.min(stockBefore, required);
  def.decoysLeft = stockBefore - committed;
  const evaded = committed > 0 && rand() < decoyEvadeChance(stockBefore, required);
  const stockedOut = def.decoysLeft <= 0 && stockBefore > 0;
  if (evaded) {
    att.missilesEvaded++;
    defEvents.push(committed >= required
      ? `${kind} evaded: ${required} decoy(s) pulled the seeker (${def.decoysLeft} left)`
      : `${kind} evaded on partial barrage (${committed}/${required} decoys fired, ${def.decoysLeft} left)`);
    if (stockedOut) defEvents.push('Decoy stock exhausted — future impacts are unopposed');
    return;
  }
  defEvents.push(committed <= 0
    ? `${kind} impacts: no countermeasures on target`
    : committed >= required
      ? `${kind} slipped through ${committed} decoy(s) (pilot fumble, ${def.decoysLeft} left)`
      : `${kind} punched through ${committed}/${required} decoys (${def.decoysLeft} left)`);
  if (stockedOut) defEvents.push('Decoy stock exhausted — future impacts are unopposed');

  att.missilesHit++;
  const dmg = m.perShot * variance;
  const mix = quantum ? DISTORTION_MIX : PHYSICAL_MIX;
  const split = shieldSplitFor(def.ship, mix);
  const applied = applyHit(def, dmg * split.shield, scaleMix(mix, dmg * split.structure), mix, round, defEvents);
  att.totalDamageDealt += applied;
  att.damageByType[quantum ? 'distortion' : 'physical'] += applied;
  defEvents.push(split.structure > 0
    ? `${kind} impact: ${fmt(dmg)} blast, ${Math.round(split.structure * 100)}% bleeds past shields`
    : `${kind} impact: ${fmt(dmg)} blast fully absorbed by shields (grinds the pool)`);
}

export function simulate(a: ShipConfig, b: ShipConfig, seed: number): BattleResult {
  const rand = mulberry32(seed);
  const statsA = derivedStats(a);
  const statsB = derivedStats(b);
  const stateA = initState(a.ship);
  const stateB = initState(b.ship);

  const rounds: Round[] = [];
  let winner: 'a' | 'b' | 'draw' | null = null;

  for (let round = 1; round <= MAX_ROUNDS && winner === null; round++) {
    const va = 1 + (rand() * 2 - 1) * VARIANCE;
    const vb = 1 + (rand() * 2 - 1) * VARIANCE;

    // Deflection gate (hard, integrity-scaled): weapons with per-shot damage at or below
    // the defender's effective gate (deflection × armor/armorMax) for their damage type
    // deal no damage while the defender has armor; the gate lifts as the armor pool depletes.
    const atkA = gatedLoadout(a, stateB.ship, stateB.armor, statsA.dpsScale, stateA.ammoLeft);
    const atkB = gatedLoadout(b, stateA.ship, stateA.armor, statsB.dpsScale, stateB.ammoLeft);
    const splitAB = shieldSplitFor(b.ship, atkA.mix); // A attacks B
    const splitBA = shieldSplitFor(a.ship, atkB.mix); // B attacks A
    const incomingA = atkA.dps * va * ROUND_SECONDS;
    const incomingB = atkB.dps * vb * ROUND_SECONDS;

    const snapshotA = {
      shieldBefore: stateA.shield,
      armorBefore: stateA.armor,
      hullBefore: stateA.hull,
      phase: currentPhase(stateA),
      shieldActive: stateA.shieldActive,
    };
    const snapshotB = {
      shieldBefore: stateB.shield,
      armorBefore: stateB.armor,
      hullBefore: stateB.hull,
      phase: currentPhase(stateB),
      shieldActive: stateB.shieldActive,
    };

    const eventsA: string[] = [];
    const eventsB: string[] = [];

    const deflectNote = (atk: GatedAttack, gateHost: ShipData, armorRatio: number): string | null => {
      if (atk.deflected.length === 0) return null;
      const list = atk.deflected.map((d) => (d.count > 1 ? `${d.name}×${d.count}` : d.name)).join(', ');
      return `Armor deflects ${list} (effective gate ${fmt(effectiveGate(deflectionFor(gateHost, 'physical'), armorRatio))}P / ${fmt(effectiveGate(deflectionFor(gateHost, 'energy'), armorRatio))}E at ${Math.round(armorRatio * 100)}% armor)`;
    };
    const ratioB = armorRatioOf(b.ship.armor, stateB.armor);
    const ratioA = armorRatioOf(a.ship.armor, stateA.armor);
    const noteB = deflectNote(atkA, b.ship, ratioB); // A's shots deflected by B's armor
    if (noteB) eventsB.push(noteB);
    const noteA = deflectNote(atkB, a.ship, ratioA); // B's shots deflected by A's armor
    if (noteA) eventsA.push(noteA);

    // Shield regen first (only if powered & active).
    if (stateA.shieldActive) stateA.shield = Math.min(stateA.shieldMax, stateA.shield + statsA.shieldRegen * ROUND_SECONDS);
    if (stateB.shieldActive) stateB.shield = Math.min(stateB.shieldMax, stateB.shield + statsB.shieldRegen * ROUND_SECONDS);

    // Simultaneous fire: both incoming values computed from start-of-round state.
    // Ordnance salvos resolve against the defender's decoy barrage (seeded RNG).
    missilePhase(stateA, stateB, va, round, eventsA, eventsB, rand);
    missilePhase(stateB, stateA, vb, round, eventsB, eventsA, rand);

    // Guns spend this round's burst on the weapons that actually fired (deflected shots
    // left the barrel); weapons firing their last magazine report the depletion here and
    // go silent from next round. Unpowered/dry weapons consume nothing (Finding 2).
    depleteGuns(stateA, round, eventsA, atkA.firedIndices);
    depleteGuns(stateB, round, eventsB, atkB.firedIndices);

    const dealtByA = incomingA;
    const dealtByB = incomingB;
    stateA.totalDamageDealt += dealtByA;
    stateB.totalDamageDealt += dealtByB;
    for (const t of DAMAGE_TYPES) {
      stateA.damageByType[t] += dealtByA * atkA.mix[t];
      stateB.damageByType[t] += dealtByB * atkB.mix[t];
    }

    applyHit(stateB, dealtByA * splitAB.shield, scaleMix(atkA.mix, dealtByA * splitAB.structure), atkA.mix, round, eventsB);
    applyHit(stateA, dealtByB * splitBA.shield, scaleMix(atkB.mix, dealtByB * splitBA.structure), atkB.mix, round, eventsA);

    // End-of-round shield bookkeeping.
    if (!stateA.shieldActive) {
      stateA.shieldDownRounds++;
      if (--stateA.downRoundsLeft <= 0) {
        stateA.shieldActive = true;
        eventsA.push(`Shields reactivated at 0 (regen climbs)`);
      }
    }
    if (!stateB.shieldActive) {
      stateB.shieldDownRounds++;
      if (--stateB.downRoundsLeft <= 0) {
        stateB.shieldActive = true;
        eventsB.push(`Shields reactivated at 0 (regen climbs)`);
      }
    }

    const mk = (
      s: typeof snapshotA,
      state: CombatState,
      appliedIncoming: number,
      events: string[],
    ): ShipRoundState => ({
      shieldBefore: s.shieldBefore,
      shieldAfter: state.shield,
      armorBefore: s.armorBefore,
      armorAfter: state.armor,
      hullBefore: s.hullBefore,
      hullAfter: state.hull,
      dpsApplied: appliedIncoming / ROUND_SECONDS,
      phase: s.phase,
      shieldBrokenAtRound: state.shieldBrokenAtRound,
      shieldActive: state.shieldActive,
      events,
    });

    rounds.push({
      index: round,
      b: mk(snapshotB, stateB, dealtByA, eventsB),
      a: mk(snapshotA, stateA, dealtByB, eventsA),
    });

    if (stateA.hull <= 0 && stateB.hull <= 0) winner = 'draw';
    else if (stateB.hull <= 0) winner = 'a';
    else if (stateA.hull <= 0) winner = 'b';
  }

  if (winner === null) {
    const pa = stateA.hull / stateA.hullMax;
    const pb = stateB.hull / stateB.hullMax;
    winner = pa === pb ? 'draw' : pa > pb ? 'a' : 'b';
  }

  const side = (state: CombatState, derived: ReturnType<typeof derivedStats>): SideSummary => ({
    shipName: state.ship.displayName,
    totalDamageDealt: state.totalDamageDealt,
    damageByType: state.damageByType,
    missilesFired: state.missilesFired,
    missilesEvaded: state.missilesEvaded,
    missilesHit: state.missilesHit,
    shieldDownRounds: state.shieldDownRounds,
    firstShieldBreakRound: state.shieldBrokenAtRound,
    gunsDryRounds: state.gunsDry,
    hullPctAtEnd: Math.max(0, state.hull) / state.hullMax,
    derived,
  });

  const summary: BattleSummary = {
    winner,
    winnerName: winner === 'draw' ? null : winner === 'a' ? a.ship.displayName : b.ship.displayName,
    totalRounds: rounds.length,
    seed,
    sides: { a: side(stateA, statsA), b: side(stateB, statsB) },
  };

  return { winner, rounds, summary };
}
