import type { ShipComponent, ShipData, TurretMount, Weapon } from '../engine/types';

/** Component types that ARE turret mounts (mounts render as "Turret:"/"TurretBase:"
 *  rows in the guns list); the T23 weapons join and the fixed-gun fallback apply
 *  only to these. */
export const TURRET_COMPONENT_TYPES = new Set(['Turret', 'TurretBase', 'UtilityTurret']);

/** T23 multiset join: pair the k-th Turret-family component with a className `K` to
 *  the k-th `ship.turretMounts` entry of `className K` (mount class names repeat —
 *  3× "Mount_Gimbal_S3"). Mounts whose API entry can't be joined (null class_name,
 *  zero weapons) and ships with un-regenerated snapshots (no turretMounts) match
 *  nothing — the row keeps its current guns-pool detail.
 *  STATEFUL: call exactly once per Turret-family component, in component order. */
export function turretMountMatcher(ship: ShipData): (c: ShipComponent) => TurretMount | null {
  const byClass = new Map<string, TurretMount[]>();
  for (const m of ship.turretMounts ?? []) {
    const list = byClass.get(m.className);
    if (list) list.push(m);
    else byClass.set(m.className, [m]);
  }
  const used = new Map<string, number>();
  return (c: ShipComponent) => {
    if (!TURRET_COMPONENT_TYPES.has(c.type ?? '')) return null;
    const list = byClass.get(c.className);
    if (!list?.length) return null;
    const k = used.get(c.className) ?? 0;
    if (k >= list.length) return null;
    used.set(c.className, k + 1);
    return list[k];
  };
}

/** One gun-model group on a fallback mount row: `count` guns of `name`, `dps` summed
 *  across the guns, `alpha` the max per-gun alpha (T24 conventions). */
export interface FixedGunGroup {
  name: string;
  count: number;
  dps: number;
  alpha: number;
}

export interface FixedGunPairing {
  /** component index → its T23 turretMounts match (null = unmatched); produced by
   *  driving `mountFor` exactly once per Turret-family component, in order. */
  mounts: Map<number, TurretMount | null>;
  /** component index → fallback gun groups for an UNMATCHED turret mount row. */
  byIndex: Map<number, FixedGunGroup[]>;
  /** fixed-gun pool size after exclusion (G). */
  guns: number;
  /** unmatched Turret-family mount rows (M). */
  mountsTotal: number;
}

/** DECLARED HEURISTIC (T25, UI layer): the API has no gun→mount mapping for the
 *  Avenger-line/600i-class hardpoints (T23 gap: their turret arrays are empty; the
 *  gimbal-mount guns exist only as `weaponry.fixed_weapons` ship-level entries).
 *  After the T23 multiset join consumes its matches, pair the remaining
 *  `ship.weapons[]` entries with `type === 'fixed'` (excluded when the name is
 *  already rendered on a matched turretMounts mount — PDC/manned guns appear in
 *  both pools) to the REMAINING unmatched Turret/TurretBase/UtilityTurret
 *  component rows, in component order:
 *   - guns == mounts: k↔k list-order pairing, one gun per mount row.
 *   - guns  > mounts: round-robin distribution (gun k → mount k % M); a mount row
 *     aggregates identical names with ×N counts (dps summed, alpha shown once =
 *     max) — the per-mount count is an ASSUMPTION of the even distribution.
 *   - mounts > guns: the first G mounts get one gun each; extra mounts render
 *     no sub-lines.
 *  The API gives fixed weapons no size (probe GC2: fixed = {name, dps,
 *  sustained_dps, alpha}), so the row shows the MOUNT size and the sub-line shows
 *  no per-gun size. Display-only — power rides in the aggregate guns pool.
 *  TurretMounts-matched rows (600i remote turrets) keep rendering exactly as
 *  before; never double-lists a name already shown via a match. */
export function fixedGunPairings(
  ship: ShipData,
  weaponComps: { c: ShipComponent; i: number }[],
  mountFor: (c: ShipComponent) => TurretMount | null,
): FixedGunPairing {
  const mounts = new Map<number, TurretMount | null>();
  const unmatched: number[] = [];
  const rendered = new Set<string>();
  for (const { c, i } of weaponComps) {
    const isTurret = TURRET_COMPONENT_TYPES.has(c.type ?? '');
    const m = isTurret ? mountFor(c) : null;
    mounts.set(i, m);
    if (m) for (const w of m.weapons) rendered.add(w.name);
    else if (isTurret) unmatched.push(i);
  }
  const pool = (ship.weapons ?? []).filter((w) => w.type === 'fixed' && !rendered.has(w.name));
  const byIndex = new Map<number, FixedGunGroup[]>();
  const M = unmatched.length;
  const G = pool.length;
  if (M > 0 && G > 0) {
    if (G <= M) {
      for (let k = 0; k < G; k++) {
        byIndex.set(unmatched[k], [{ name: pool[k].name, count: 1, dps: pool[k].dps, alpha: pool[k].alpha }]);
      }
    } else {
      const buckets: Weapon[][] = Array.from({ length: M }, () => []);
      pool.forEach((w, k) => { buckets[k % M].push(w); });
      buckets.forEach((b, k) => {
        const groups: FixedGunGroup[] = [];
        for (const w of b) {
          const g = groups.find((x) => x.name === w.name);
          if (g) { g.count += 1; g.dps += w.dps; g.alpha = Math.max(g.alpha, w.alpha); }
          else groups.push({ name: w.name, count: 1, dps: w.dps, alpha: w.alpha });
        }
        byIndex.set(unmatched[k], groups);
      });
    }
  }
  return { mounts, byIndex, guns: G, mountsTotal: M };
}
