import { MAX_ROUNDS, ROUND_SECONDS, VARIANCE } from './constants';
import { deflectionFor, derivedStats, gatedLoadout, shieldSplitFor } from './derived';
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
}

function initState(ship: ShipData): CombatState {
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
  };
}

function currentPhase(s: CombatState): Phase {
  if (s.shieldActive && s.shield > 0) return 'shield';
  if (s.armor > 0) return 'armor';
  return 'hull';
}

/** Apply one round of incoming damage (post deflection-gate, post-variance) split into the
 *  shield-absorbed part and the part phasing through shields straight onto armor/hull.
 *  Passes the gate: damage hits armor first; armor depletion overflow carries to hull.
 *  Mutates state. */
function applyHit(def: CombatState, shieldPart: number, structPart: number, roundIndex: number, events: string[]): number {
  let applied = 0;
  if (def.shieldActive && def.shield > 0) {
    def.shield -= shieldPart;
    applied += shieldPart;
    applied += applyToStructure(def, structPart, events);
    if (def.shield <= 0) {
      const overflow = -def.shield;
      def.shield = 0;
      def.shieldActive = false;
      def.downRoundsLeft = Math.max(1, Math.ceil(def.ship.shield.reconfigurationCooldown / ROUND_SECONDS));
      if (def.shieldBrokenAtRound === null) def.shieldBrokenAtRound = roundIndex;
      events.push(`Shields broken at round ${roundIndex} (shield cover ${(shieldPart / Math.max(1e-9, shieldPart + structPart) * 100).toFixed(0)}%), overflow ${fmt(overflow)} to armor; down for ${def.downRoundsLeft} round(s)`);
      applied += applyToStructure(def, overflow, events);
    }
  } else {
    applied += applyToStructure(def, shieldPart + structPart, events);
  }
  return applied;
}

function applyToStructure(def: CombatState, damage: number, events: string[]): number {
  let rest = damage;
  let applied = 0;
  if (def.armor > 0) {
    const toArmor = Math.min(def.armor, rest);
    def.armor -= toArmor;
    rest -= toArmor;
    applied += toArmor;
  }
  if (rest > 0) {
    def.hull -= rest;
    applied += rest;
    if (def.hull <= 0) events.push(`Hull breached — destroyed`);
  }
  return applied;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
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

    // Deflection gate (hard): weapons with per-shot damage below the defender's armor
    // deflection for their damage type deal no damage while the defender has armor.
    const atkA = gatedLoadout(a, stateB.ship, stateB.armor, statsA.dpsScale);
    const atkB = gatedLoadout(b, stateA.ship, stateA.armor, statsB.dpsScale);
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

    const deflectNote = (atk: GatedAttack, gateHost: ShipData): string | null => {
      if (atk.deflected.length === 0) return null;
      const list = atk.deflected.map((d) => (d.count > 1 ? `${d.name}×${d.count}` : d.name)).join(', ');
      return `Armor deflects ${list} (gate ${fmt(deflectionFor(gateHost, 'physical'))}P / ${fmt(deflectionFor(gateHost, 'energy'))}E)`;
    };
    const noteB = deflectNote(atkA, b.ship); // A's shots deflected by B's armor
    if (noteB) eventsB.push(noteB);
    const noteA = deflectNote(atkB, a.ship); // B's shots deflected by A's armor
    if (noteA) eventsA.push(noteA);

    // Shield regen first (only if powered & active).
    if (stateA.shieldActive) stateA.shield = Math.min(stateA.shieldMax, stateA.shield + statsA.shieldRegen * ROUND_SECONDS);
    if (stateB.shieldActive) stateB.shield = Math.min(stateB.shieldMax, stateB.shield + statsB.shieldRegen * ROUND_SECONDS);

    // Simultaneous fire: both incoming values computed from start-of-round state.
    const dealtByA = incomingA;
    const dealtByB = incomingB;
    stateA.totalDamageDealt += dealtByA;
    stateB.totalDamageDealt += dealtByB;
    for (const t of DAMAGE_TYPES) {
      stateA.damageByType[t] += dealtByA * atkA.mix[t];
      stateB.damageByType[t] += dealtByB * atkB.mix[t];
    }

    applyHit(stateB, dealtByA * splitAB.shield, dealtByA * splitAB.structure, round, eventsB);
    applyHit(stateA, dealtByB * splitBA.shield, dealtByB * splitBA.structure, round, eventsA);

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
    shieldDownRounds: state.shieldDownRounds,
    firstShieldBreakRound: state.shieldBrokenAtRound,
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
