import { useEffect, useMemo, useRef, useState } from 'react';
import { CAREERS, MANUFACTURERS, SHIPS, SIZES } from '../data';
import type { ShipData } from '../engine/types';
import { ShipCard } from './ShipCard';

export function ShipPicker({ selected, scope, onSelect, focusToken = 0 }: {
  selected: ShipData | null;
  scope: string;
  onSelect: (ship: ShipData) => void;
  focusToken?: number;
}) {
  const [query, setQuery] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [size, setSize] = useState('');
  const [career, setCareer] = useState('');

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return SHIPS.filter((s) => {
      if (manufacturer && s.manufacturer !== manufacturer) return false;
      if (size && s.sizeClass !== size) return false;
      if (career && (s.career ?? 'Unclassified') !== career) return false;
      if (q && !`${s.name} ${s.manufacturer} ${s.role ?? ''} ${s.career ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [query, manufacturer, size, career]);

  const visible = useMemo(() => {
    const top = filtered.slice(0, 120);
    if (selected && !top.some((s) => s.uuid === selected.uuid)) return [selected, ...top];
    return top;
  }, [filtered, selected]);

  const listRef = useRef<HTMLDivElement>(null);
  const lastToken = useRef(0);

  useEffect(() => {
    if (!focusToken || focusToken === lastToken.current || !selected) return;
    lastToken.current = focusToken;
    setQuery('');
    setManufacturer('');
    setSize('');
    setCareer('');
    requestAnimationFrame(() => {
      listRef.current?.querySelector(`#ship-card-${scope}-${selected.uuid}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [focusToken, selected?.uuid, scope]);

  return (
    <div className="picker">
      <div className="picker-filters">
        <input
          className="search"
          placeholder="Search ships…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={manufacturer} onChange={(e) => setManufacturer(e.target.value)}>
          <option value="">All manufacturers</option>
          {MANUFACTURERS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="">All sizes</option>
          {SIZES.map((sz) => <option key={sz} value={sz}>{sz}</option>)}
        </select>
        <select value={career} onChange={(e) => setCareer(e.target.value)}>
          <option value="">All careers</option>
          {CAREERS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="picker-count">{filtered.length} ships</div>
      <div className="ship-list" ref={listRef}>
        {visible.map((s) => (
          <ShipCard
            key={s.uuid}
            ship={s}
            scope={scope}
            selected={selected?.uuid === s.uuid}
            onSelect={() => onSelect(s)}
          />
        ))}
        {filtered.length > 120 && <div className="picker-count">…narrow the filters to see more</div>}
      </div>
    </div>
  );
}
