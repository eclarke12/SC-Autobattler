import type { ReactNode } from 'react';

/** Clickable power-segment blocks. 1 pip = 1 block. Clicking block N of max sets the
 *  value to N (so blocks 1..N fill in, e.g. pick block 4 of 5 from value 1 => fills 1-4).
 *  Clicking the top filled block clears it (value N => N-1). */
export function PowerBlocks({ label, value, max, onChange, kind }: {
  label: ReactNode;
  value: number;
  max: number;
  onChange: (v: number) => void;
  kind: 'weapons' | 'shields';
}) {
  const safeMax = Math.min(Math.max(0, Math.trunc(max)), 256);
  const clamped = Math.min(Math.max(0, Math.trunc(value)), safeMax);
  const blocks = Array.from({ length: safeMax }, (_, i) => i + 1);
  return (
    <div className="power-blocks-field">
      <span className="power-blocks-label">{label}</span>
      {safeMax === 0
        ? <span className="power-blocks-empty">No segments available (all used by the other system)</span>
        : (
          <div className={`power-blocks ${kind}`} role="group" aria-label={`${kind} power segments`}>
            {blocks.map((n) => (
              <button
                key={n}
                type="button"
                className={`power-block${n <= clamped ? ' filled' : ''}`}
                aria-pressed={n <= clamped}
                aria-label={`Set ${kind} power to ${n} of ${max}`}
                title={`${n} of ${max} segment${max === 1 ? '' : 's'}`}
                onClick={() => onChange(n === clamped ? n - 1 : n)}
              />
            ))}
          </div>
        )}
    </div>
  );
}
