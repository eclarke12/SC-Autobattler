import { DEFLECTION, MAX_ROUNDS, ROUND_SECONDS, VARIANCE } from './constants';
import { derivedStats, shieldFactorFor } from './derived';
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

/** Apply raw incoming (post-deflection, post-variance) full-round damage to defender. Mutates state. */
function applyHit(def: CombatState, attackerFactor: number, rawDamage: number, roundIndex: number, events: string[]): number {
  let applied = 0;
  if (def.shieldActive) {
    const eff = rawDamage * attackerFactor;
    def.shield -= eff;
    applied += eff;
    if (def.shield <= 0) {
      const overflow = -def.shield;
      def.shield = 0;
      def.shieldActive = false;
      def.downRoundsLeft = Math.max(1, Math.ceil(def.ship.shield.reconfigurationCooldown / ROUND_SECONDS));
      if (def.shieldBrokenAtRound === null) def.shieldBrokenAtRound = roundIndex;
      events.push(`Shields broken at round ${roundIndex} (factor ${attackerFactor.toFixed(2)}), overflow ${fmt(overflow)} to armor; down for ${def.downRoundsLeft} round(s)`);
      applied += applyToStructure(def, overflow, events);
    }
  } else {
    applied += applyToStructure(def, rawDamage, events);
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
  const factorAB = shieldFactorFor(b.ship, statsA.damageMix); // A attacks B
  const factorBA = shieldFactorFor(a.ship, statsB.damageMix); // B attacks A

  const rounds: Round[] = [];
  let winner: 'a' | 'b' | 'draw' | null = null;

  for (let round = 1; round <= MAX_ROUNDS && winner === null; round++) {
    const va = 1 + (rand() * 2 - 1) * VARIANCE;
    const vb = 1 + (rand() * 2 - 1) * VARIANCE;
    const incomingA = statsA.weaponDps * (1 - DEFLECTION) * va * ROUND_SECONDS;
    const incomingB = statsB.weaponDps * (1 - DEFLECTION) * vb * ROUND_SECONDS;

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

    // Shield regen first (only if powered & active).
    if (stateA.shieldActive) stateA.shield = Math.min(stateA.shieldMax, stateA.shield + statsA.shieldRegen * ROUND_SECONDS);
    if (stateB.shieldActive) stateB.shield = Math.min(stateB.shieldMax, stateB.shield + statsB.shieldRegen * ROUND_SECONDS);

    // Simultaneous fire: both incoming values computed from start-of-round state.
    const dealtByA = incomingA;
    const dealtByB = incomingB;
    stateA.totalDamageDealt += dealtByA;
    stateB.totalDamageDealt += dealtByB;
    for (const t of DAMAGE_TYPES) {
      stateA.damageByType[t] += dealtByA * statsA.damageMix[t];
      stateB.damageByType[t] += dealtByB * statsB.damageMix[t];
    }

    applyHit(stateB, factorAB, dealtByA, round, eventsB);
    applyHit(stateA, factorBA, dealtByB, round, eventsA);

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
