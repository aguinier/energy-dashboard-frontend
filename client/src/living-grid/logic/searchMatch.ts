import { ZONES } from './zoneRegistry';

/**
 * The header search: type two characters and the map selects.
 *
 * Matching is deliberately narrow — an exact two-letter zone code, or a prefix
 * of the zone's name. A substring match would jump the selection to Ireland
 * while someone was still typing "Ger" (Germany contains no "ire", but
 * "Netherlands" contains "land", "Finland" contains "in", and so on), and the
 * selection moving under a half-typed query reads as a bug.
 */
export function matchZone(query: string, available: readonly string[]): string | null {
  const trimmed = query.trim();
  if (trimmed.length < 2) return null;

  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const has = (code: string) => available.includes(code);

  if (upper.length === 2) {
    const exact = ZONES.find((z) => z.code === upper);
    if (exact && has(exact.code)) return exact.code;
  }

  const byName = ZONES.find((z) => has(z.code) && z.name.toLowerCase().startsWith(lower));
  return byName ? byName.code : null;
}
