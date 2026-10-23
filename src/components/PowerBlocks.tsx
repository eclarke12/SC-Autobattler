import type { ReactElement, ReactNode } from 'react';

/** Trust-boundary clamp (repo convention, T21): UI knobs defensively bound pip
 *  counts to sane ranges; App.tsx re-clamps at the `toConfig` boundary as a second
 *  layer (URL-decoded configs are untrusted). */
const clampBound = (n: number) => Math.min(Math.max(0, Math.trunc(n)), 256);

/** Clickable power-pip blocks. 1 pip = 1 block. Clicking block N of max sets the
 *  value to N (so blocks 1..N fill in, e.g. pick block 4 of 5 from value 1 => fills 1-4).
 *  Clicking the top filled block clears it (value N => N-1). `min` floors the legal
 *  range (shield floor = Σ shield minOnline — Stronghold ships can't drop shields to 0). */
export function PowerBlocks({ label, value, max, min = 0, onChange, kind }: {
  label: ReactNode;
  value: number;
  max: number;
  min?: number;
  onChange: (v: number) => void;
  kind: 'weapons' | 'shields';
}) {
  const safeMax = clampBound(max);
  const safeMin = Math.min(clampBound(min), safeMax);
  const clamped = Math.min(Math.max(safeMin, Math.trunc(value)), safeMax);
  const blocks = Array.from({ length: safeMax }, (_, i) => i + 1);
  return (
    <div className="power-blocks-field">
      <span className="power-blocks-label">{label}</span>
      {safeMax === 0
        ? <span className="power-blocks-empty">No pips available</span>
        : (
          <div className={`power-blocks ${kind}`} role="group" aria-label={`${kind} power pips`}>
            {blocks.map((n) => {
              const target = Math.min(Math.max(n === clamped ? n - 1 : n, safeMin), safeMax);
              return (
                <button
                  key={n}
                  type="button"
                  className={`power-block${n <= clamped ? ' filled' : ''}`}
                  aria-pressed={n <= clamped}
                  aria-label={`Set ${kind} power to ${target} of ${max}`}
                  title={`${target} of ${max} pip${max === 1 ? '' : 's'}${safeMin > 0 ? ` (floor ${safeMin})` : ''}`}
                  onClick={() => onChange(target)}
                />
              );
            })}
          </div>
        )}
    </div>
  );
}

/** Flatten a ReactNode label to plain text for aria-label interpolation. */
function labelToText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(labelToText).join('');
  const children = (node as ReactElement<{ children?: ReactNode }>).props?.children;
  return children === undefined ? '' : labelToText(children);
}

/** Read-only power-pip blocks (Systems section): every system sits locked at its
 *  minOnline default (App fills allocs from the engine `defaultAllocation`), so the
 *  pickers are removed — blocks are non-interactive spans styled like the Guns/Shields
 *  pickers. Defensive clamp per repo convention ([0, 256] ints); returns null for
 *  components with no power draw (nothing to show). */
export function ComponentBlocks({ label, value, max, detail, title }: {
  label: ReactNode;
  value: number;
  max: number;
  detail?: ReactNode;
  title?: string;
}) {
  const safeMax = clampBound(max);
  if (safeMax <= 0) return null;
  const clamped = Math.min(Math.max(0, Math.trunc(value)), safeMax);
  return (
    <div className="power-blocks-field">
      <span className="power-blocks-label">
        {label} <b>{clamped}/{safeMax}</b>
        {detail && <em className="comp-detail"> {detail}</em>}
      </span>
      <div
        className="power-blocks systems"
        role="img"
        aria-label={`${labelToText(label)}: ${clamped} of ${safeMax} pip${safeMax === 1 ? '' : 's'} (locked)`}
        title={title}
      >
        {Array.from({ length: safeMax }, (_, i) => i + 1).map((n) => (
          <span key={n} className={`power-block${n <= clamped ? ' filled' : ''}`} />
        ))}
      </div>
    </div>
  );
}

/** Read-only component row (weapons-category list, PowerPlant generation rows). */
export function ComponentRow({ label, detail, title }: {
  label: ReactNode;
  detail: ReactNode;
  title?: string;
}) {
  return (
    <div className="comp-row" title={title}>
      <span className="comp-name">{label}</span>
      <span className="comp-detail">{detail}</span>
    </div>
  );
}
