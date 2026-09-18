import type { GridDay, GridDayZone } from '@/types';

/**
 * The zones the Living Grid draws, and what each one's data actually supports.
 *
 * The list is the design's — 28 European zones, keyed by ISO country code
 * because that is what the whole stack is keyed by. It is intersected with
 * what the payload carries rather than trusted: a zone with no rows is drawn
 * as absent, not as zero.
 */

export interface ZoneInfo {
  code: string;
  name: string;
  /** Flag chip colour from the design; purely decorative. */
  flag: string;
}

export const ZONES: readonly ZoneInfo[] = [
  { code: 'DE', name: 'Germany', flag: '#2A2A2A' },
  { code: 'FR', name: 'France', flag: '#1E3A8A' },
  { code: 'BE', name: 'Belgium', flag: '#B8860B' },
  { code: 'NL', name: 'Netherlands', flag: '#B45309' },
  { code: 'ES', name: 'Spain', flag: '#B91C1C' },
  { code: 'IT', name: 'Italy', flag: '#15803D' },
  { code: 'PL', name: 'Poland', flag: '#BE123C' },
  { code: 'AT', name: 'Austria', flag: '#B91C1C' },
  { code: 'CH', name: 'Switzerland', flag: '#DC2626' },
  { code: 'CZ', name: 'Czech Republic', flag: '#1D4ED8' },
  { code: 'DK', name: 'Denmark', flag: '#B91C1C' },
  { code: 'SE', name: 'Sweden', flag: '#1D4ED8' },
  { code: 'NO', name: 'Norway', flag: '#1E3A8A' },
  { code: 'FI', name: 'Finland', flag: '#1D4ED8' },
  { code: 'PT', name: 'Portugal', flag: '#15803D' },
  { code: 'IE', name: 'Ireland', flag: '#15803D' },
  { code: 'GB', name: 'United Kingdom', flag: '#1E3A8A' },
  { code: 'HU', name: 'Hungary', flag: '#15803D' },
  { code: 'RO', name: 'Romania', flag: '#1D4ED8' },
  { code: 'GR', name: 'Greece', flag: '#1D4ED8' },
  { code: 'SK', name: 'Slovakia', flag: '#1D4ED8' },
  { code: 'SI', name: 'Slovenia', flag: '#1D4ED8' },
  { code: 'HR', name: 'Croatia', flag: '#1D4ED8' },
  { code: 'BG', name: 'Bulgaria', flag: '#15803D' },
  { code: 'EE', name: 'Estonia', flag: '#1D4ED8' },
  { code: 'LV', name: 'Latvia', flag: '#7F1D1D' },
  { code: 'LT', name: 'Lithuania', flag: '#B8860B' },
  { code: 'LU', name: 'Luxembourg', flag: '#1D4ED8' },
];

export const ZONE_BY_CODE: Readonly<Record<string, ZoneInfo>> = Object.fromEntries(
  ZONES.map((z) => [z.code, z]),
);

/**
 * How much of a zone's day the data actually covers.
 *
 * `full` — every stream the panel shows has values.
 * `partial` — some streams are missing; the panel says which.
 * `none` — the zone is on the map but published nothing today.
 */
export type ZoneBasis = 'full' | 'partial' | 'none';

export interface ZoneAvailability {
  hasLoad: boolean;
  hasPrice: boolean;
  hasNet: boolean;
  hasMix: boolean;
  /** The zone's series is another bidding zone's, e.g. LU served DE_LU. */
  sharedWith: string | null;
  basis: ZoneBasis;
}

const anyValue = (series: (number | null)[] | undefined): boolean =>
  series !== undefined && series.some((v) => v !== null);

export function zoneAvailability(
  code: string,
  zone: GridDayZone | undefined,
  sharedZones: Record<string, string> = {},
): ZoneAvailability {
  const hasLoad = anyValue(zone?.load);
  const hasPrice = anyValue(zone?.price);
  const hasNet = anyValue(zone?.net);
  const hasMix = zone !== undefined && Object.values(zone.mix).some(anyValue);

  const present = [hasLoad, hasPrice, hasNet, hasMix].filter(Boolean).length;
  const basis: ZoneBasis = present === 0 ? 'none' : present === 4 ? 'full' : 'partial';

  return {
    hasLoad,
    hasPrice,
    hasNet,
    hasMix,
    sharedWith: sharedZones[code] ?? null,
    basis,
  };
}

/** The design's zones that the payload actually carries data for. */
export function availableZones(day: GridDay | undefined): ZoneInfo[] {
  if (!day) return [];
  return ZONES.filter((z) => zoneAvailability(z.code, day.zones[z.code], day.meta.sharedZones).basis !== 'none');
}

/** Short label for the basis pill; the design's DEMO pill, told the truth. */
export function basisLabel(availability: ZoneAvailability): string {
  switch (availability.basis) {
    case 'full':
      return 'LIVE DATA';
    case 'partial':
      return 'PARTIAL DATA';
    default:
      return 'NO DATA';
  }
}
