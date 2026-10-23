export interface SideKnobs {
  uuid: string;
  /** Absent = App fills from engine defaults (turretCount / defaultAllocation). */
  turrets?: number;
  w?: number;
  s?: number;
  /** Index-parallel to `ship.components[]`; only system components carry values,
   *  non-system entries are 0 (RULE-R). Absent = App fills engine defaults. */
  alloc?: number[];
  /** PDC on/off; absent = App defaults to on. */
  pdcOn?: boolean;
}

export interface MatchupState {
  a: SideKnobs;
  b: SideKnobs;
  /** Absent = App draws a fresh random seed at fight time. */
  seed?: number;
}

export function encodeMatchup(m: MatchupState): string {
  const p = new URLSearchParams();
  p.set('a', m.a.uuid);
  p.set('at', String(m.a.turrets));
  p.set('aw', String(m.a.w));
  p.set('as', String(m.a.s));
  p.set('b', m.b.uuid);
  p.set('bt', String(m.b.turrets));
  p.set('bw', String(m.b.w));
  p.set('bs', String(m.b.s));
  if (m.seed !== undefined) p.set('seed', String(m.seed));
  if (m.a.alloc) p.set('aa', m.a.alloc.join(','));
  if (m.b.alloc) p.set('ba', m.b.alloc.join(','));
  if (m.a.pdcOn !== undefined) p.set('pd', m.a.pdcOn ? '1' : '0');
  if (m.b.pdcOn !== undefined) p.set('ps', m.b.pdcOn ? '1' : '0');
  return `#?${p.toString()}`;
}

export function decodeMatchup(hash: string): MatchupState | null {
  if (!hash.startsWith('#?')) return null;
  const p = new URLSearchParams(hash.slice(2));
  const a = p.get('a');
  const b = p.get('b');
  if (!a || !b) return null;
  const n = (k: string): number | undefined => {
    const raw = p.get(k);
    if (raw === null) return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  const alloc = (k: string): number[] | undefined => {
    const raw = p.get(k);
    if (raw === null) return undefined;
    const nums = raw.split(',').map(Number);
    return nums.length > 0 && nums.every((v) => Number.isFinite(v)) ? nums : undefined;
  };
  const pdc = (k: string): boolean | undefined => {
    const v = p.get(k);
    return v === '1' ? true : v === '0' ? false : undefined;
  };
  return {
    a: { uuid: a, turrets: n('at'), w: n('aw'), s: n('as'), alloc: alloc('aa'), pdcOn: pdc('pd') },
    b: { uuid: b, turrets: n('bt'), w: n('bw'), s: n('bs'), alloc: alloc('ba'), pdcOn: pdc('ps') },
    seed: n('seed'),
  };
}

export function shareUrl(m: MatchupState): string {
  return `${location.origin}${location.pathname}${encodeMatchup(m)}`;
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}
