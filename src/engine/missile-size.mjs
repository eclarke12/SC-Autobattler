/** Single source for missile warhead sizing (plan Decisions: gun-ammo-sizes-style
 *  shared module). Consumed by scripts/build-data.mjs (ship-level `missiles.size`
 *  + the torpedo classification) and the LoadoutPanel per-rack sub-lines, so the
 *  displayed per-rack missile/torpedo class can never drift from the simulated
 *  `ship.missiles.torpedo` flag. */

/** A rack is classified as a TORPEDO (not a missile) when its warhead size >=
 *  this threshold (docs/data-notes.md). */
export const MISSILE_TORPEDO_MIN_SIZE = 5;

/**
 * Size of the missiles a rack fires, from the API naming conventions:
 *  - class_name trailing missile-size token: MRCK_S06_..._AEGS_Sabre_Firebird_S03 → 3
 *    (leading MRCK_S0N is the hardpoint; a trailing token overrides it)
 *  - explicit "12xS3" / "2xS2" / "Quad S5" in the display name
 *  - MSD-abc racks: digits are hardpoint/count/missile-size (MSD-543 = S5 rack, 4×S3)
 *  - otherwise missile size == hardpoint size (rack fills its hardpoint, e.g. S6 torpedoes)
 *
 * Takes the three relevant fields normalized (`className`, `name`, `size`), so
 * both the raw API item (`class_name`/`name`/`size`) and the app's ShipComponent
 * (`className`/`name`/`size`) call it directly. Non-numeric/absent size → 0.
 *
 * @param {{ className?: string | null, name?: string | null, size?: number | null }} item
 * @returns {number}
 */
export function missileSizeFor(item) {
  const cn = item.className ?? '';
  const name = item.name ?? '';
  const trail = cn.match(/_S(\d{1,2})$/i);
  if (trail) return Number(trail[1]);
  const named = name.match(/\d+\s*x\s*S(\d)/i) ?? name.match(/\bQuad\s+S(\d)\b/i) ?? name.match(/\bS(\d)\b/i);
  if (named) return Number(named[1]);
  const msd = name.match(/MSD-(\d)(\d)(\d)/i);
  if (msd) return Number(msd[3]);
  const prefix = cn.match(/^MRCK_S(\d{1,2})/i);
  if (prefix) return Number(prefix[1]);
  return Number.isFinite(item.size) ? item.size : 0;
}
