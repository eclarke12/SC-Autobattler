export interface SideKnobs {
  uuid: string;
  turrets: number;
  w: number;
  s: number;
}

export interface MatchupState {
  a: SideKnobs;
  b: SideKnobs;
  seed: number;
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
  p.set('seed', String(m.seed));
  return `#?${p.toString()}`;
}

export function decodeMatchup(hash: string): MatchupState | null {
  if (!hash.startsWith('#?')) return null;
  const p = new URLSearchParams(hash.slice(2));
  const a = p.get('a');
  const b = p.get('b');
  const seed = p.get('seed');
  if (!a || !b || !seed) return null;
  const n = (k: string, def: number) => {
    const v = Number(p.get(k));
    return Number.isFinite(v) ? v : def;
  };
  return {
    a: { uuid: a, turrets: n('at', 0), w: n('aw', 0), s: n('as', 0) },
    b: { uuid: b, turrets: n('bt', 0), w: n('bw', 0), s: n('bs', 0) },
    seed: Number(seed),
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
