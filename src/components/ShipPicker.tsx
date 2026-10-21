import { useMemo, useState } from 'react';
import { CAREERS, MANUFACTURERS, SHIPS, SIZES } from '../data';
import type { ShipData } from '../engine/types';
import { ShipCard } from './ShipCard';

export function ShipPicker({ selected, onSelect, exclude }: {
  selected: ShipData | null;
  onSelect: (ship: ShipData) => void;
  exclude?: string;
}) {
  const [query, setQuery] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [size, setSize] = useState('');
  const [career, setCareer] = useState('');

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return SHIPS.filter((s) => {
      if (s.uuid === exclude) return false;
      if (manufacturer && s.manufacturer !== manufacturer) return false;
      if (size && s.sizeClass !== size) return false;
      if (career && (s.career ?? 'Unclassified') !== career) return false;
      if (q && !`${s.name} ${s.manufacturer} ${s.role ?? ''} ${s.career ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [query, manufacturer, size, career, exclude]);

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
      <div className="ship-list">
        {filtered.slice(0, 120).map((s) => (
          <ShipCard
            key={s.uuid}
            ship={s}
            selected={selected?.uuid === s.uuid}
            onSelect={() => onSelect(s)}
          />
        ))}
        {filtered.length > 120 && <div className="picker-count">…narrow the filters to see more</div>}
      </div>
    </div>
  );
}
