import type { GridDay, GridDayZone, GridFuelKey, GridHourSeries } from '@/types';
import { GRID_FUEL_KEYS } from '@/types';

/**
 * A small but honest Living Grid day, shared by the logic tests.
 *
 * It carries the shapes the real payload has and the UI has to survive:
 * a fully-reporting zone, a zone with no published net position (so the
 * flow-derived fallback is exercised), a zone that reports nothing at all, and
 * a border with a missing hour.
 */

export const NO_VALUES: GridHourSeries = new Array<number | null>(24).fill(null);

/** A 24-slot series from a generator, so tests can shape one in a line. */
export function series(f: (hour: number) => number | null): GridHourSeries {
  return Array.from({ length: 24 }, (_, h) => f(h));
}

export function emptyMix(): Record<GridFuelKey, GridHourSeries> {
  return Object.fromEntries(GRID_FUEL_KEYS.map((k) => [k, [...NO_VALUES]])) as Record<
    GridFuelKey,
    GridHourSeries
  >;
}

export function zone(overrides: Partial<GridDayZone> = {}): GridDayZone {
  return {
    load: [...NO_VALUES],
    price: [...NO_VALUES],
    net: [...NO_VALUES],
    mix: emptyMix(),
    ...overrides,
  };
}

export function makeDay(overrides: Partial<GridDay> = {}): GridDay {
  const deMix = emptyMix();
  deMix.wind = series(() => 20_000);
  deMix.solar = series(() => 10_000);
  deMix.coal = series(() => 5_000);

  const frMix = emptyMix();
  frMix.nuclear = series(() => 40_000);
  frMix.hydro = series(() => 5_000);

  return {
    zones: {
      // Fully reporting, net exporter.
      DE: zone({
        load: series(() => 60_000),
        price: series(() => 90),
        net: series(() => 2_000),
        mix: deMix,
      }),
      // Fully reporting, net importer, cheaper.
      FR: zone({
        load: series(() => 50_000),
        price: series(() => 70),
        net: series(() => -1_000),
        mix: frMix,
      }),
      // No published net position — the flow-derived fallback zone.
      IT: zone({
        load: series(() => 35_000),
        price: series(() => 120),
      }),
      // On the map, but published nothing today.
      PT: zone(),
    },
    flows: {
      'DE-FR': series((h) => (h === 5 ? null : 1_500)),
      'CH-IT': series(() => 900),
      'FR-IT': series(() => 600),
    },
    meta: {
      date: '2026-09-17',
      timezone: 'Europe/Brussels',
      hoursUtc: Array.from({ length: 24 }, (_, h) =>
        `2026-09-16T${String((h + 22) % 24).padStart(2, '0')}:00:00Z`,
      ),
      sharedZones: { LU: 'DE_LU' },
      currentHour: 14,
      isToday: true,
      today: '2026-09-17',
      zoneCount: 4,
      borderCount: 3,
    },
    ...overrides,
  };
}

/**
 * A day that carries nothing — the shape every date past D+1 returns.
 *
 * The server only creates a zone key once a row exists, so an unpublished day
 * is not a day of null series but a payload with no zones at all. Several
 * consumers read that as "no data anywhere" rather than "not yet", which is
 * what the empty-day handling exists to get right, so the tests need the real
 * shape rather than a day of nulls.
 */
export function makeEmptyDay(date = '2026-09-24', today = '2026-09-17'): GridDay {
  return makeDay({
    zones: {},
    flows: {},
    meta: {
      ...makeDay().meta,
      date,
      today,
      isToday: date === today,
      zoneCount: 0,
      borderCount: 0,
    },
  });
}
