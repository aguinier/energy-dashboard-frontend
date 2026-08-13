import { Router, type Request, type Response } from 'express';
import {
  describeSeries,
  emptyCoverage,
  observeResolution,
  type Envelope,
  type ExcludedNote,
} from '../data/envelope.js';
import { freshnessBlockOf } from '../data/freshnessMap.js';
import { buildLink } from '../data/links.js';
import { decodeCursor, encodeCursor, queryFingerprint } from '../data/cursor.js';
import { parseEnumList, parseLimit, parseWindow, parseZone, toIsoSecond } from '../data/params.js';
import {
  OFFSET_ROWS_EXCLUDED,
  readObservations,
  type ObservationRow,
} from '../data/observationsRepo.js';
import {
  PRODUCTION_TYPES,
  STREAMS,
  type ObservationStream,
  type SeriesDefinition,
} from '../data/series.js';
import type { V1DataContext } from '../data/context.js';

/**
 * `GET /v1/observations/{load,price,generation}` — ENTSO-E-derived history.
 *
 * ABL-293 recommends leading with these rather than with forecasts, and the
 * measurements are why: `energy_load` holds 2.78M rows across 36 zones back to
 * 2019, `energy_generation` 3.18M across 34 back to 2021, `energy_price` 1.55M
 * across 30 — against a forecast history 7.5 months deep. This is the deeper
 * product.
 *
 * All three are the same handler with a different stream, deliberately. Any
 * difference between them would be a difference a customer has to learn, and
 * every rule that makes these responses honest — the row cap, the cursor, the
 * half-open window, the NULL contract, the per-series licence, the freshness
 * block — is a rule that has to hold for all three or it holds for none.
 *
 * **Net position is not here.** `energy_load`, `energy_price` and
 * `energy_generation` are the three streams this file knows about; there is no
 * `net-position` route and no `net_position` entry in `STREAMS`, so the
 * exclusion is a missing case rather than a filter. Board decision 2 is open;
 * the JAO leg being resolved (ABL-298 closed, authorisation held) is not a
 * reason to add it.
 */

export function observationsRouter(context: V1DataContext): Router {
  const router = Router();
  for (const stream of ['load', 'price', 'generation'] as const) {
    router.get(`/${stream}`, (req, res) => serveStream(context, stream, req, res));
  }
  return router;
}

/** Applied to every observation response — see `observationsRepo.ts` rule 2. */
const EXCLUDED: ExcludedNote[] = [OFFSET_ROWS_EXCLUDED];

function serveStream(
  context: V1DataContext,
  stream: ObservationStream,
  req: Request,
  res: Response
): void {
  const zone = parseZone(req.query.zone);
  const window = parseWindow(req.query as Record<string, unknown>);
  const limit = parseLimit(req.query.limit);
  const series = selectSeries(stream, req.query.production_type);

  const path = `/v1/observations/${stream}`;
  // The fingerprint covers every parameter that changes what a page contains —
  // and `production_type` is in it as the *resolved* field list rather than as
  // the raw string, so `?production_type=solar,wind_onshore` and
  // `?production_type=wind_onshore,solar` share a cursor. They are the same
  // query; a client whose HTTP layer reorders a list should not get a 400 on
  // page two.
  const fingerprint = queryFingerprint(path, {
    zone,
    from: window.fromIso,
    to: window.toIso,
    limit,
    fields: series.map((s) => s.field).join(','),
  });
  const after = decodeCursor(req.query.cursor, fingerprint);

  const page = readObservations(context.source, { stream, zone, window, series, after, limit });
  const held = context.freshness.lookup(zone, stream);

  const linkParams = {
    zone,
    from: window.fromIso,
    to: window.toIso,
    limit,
    production_type:
      stream === 'generation' && req.query.production_type !== undefined
        ? series.map((s) => s.field).join(',')
        : undefined,
  };

  const body: Envelope<ObservationRow> = {
    data: page.rows,
    meta: {
      resource: `observations.${stream}`,
      zone,
      from: window.fromIso,
      to: window.toIso,
      // `ok` the moment a row came back. An empty page is where the interesting
      // distinction lives, and `emptyCoverage` makes it: a window inside the
      // span we hold that returned nothing is an upstream gap, not our outage.
      coverage: page.rows.length > 0 ? 'ok' : emptyCoverage(window, held),
      row_count: page.rows.length,
      row_limit: limit,
      truncated: page.hasMore,
      ...observeResolution(page.rows.map((row) => row.timestamp)),
      series: describeSeries(series),
      freshness: {
        ...freshnessBlockOf(held),
        generated_at: toIsoSecond(context.now()),
      },
      excluded: EXCLUDED,
    },
    links: {
      self: buildLink(context.publicBaseUrl, path, {
        ...linkParams,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      }),
      // A `next` link exists only when there is a next page. Emitting one
      // unconditionally would bill a caller for the empty request that
      // discovers there was nothing after all — the row cap's cost falling on
      // the customer rather than on us.
      next:
        page.hasMore && page.lastStoredTimestamp !== null
          ? buildLink(context.publicBaseUrl, path, {
              ...linkParams,
              cursor: encodeCursor(fingerprint, page.lastStoredTimestamp),
            })
          : null,
    },
  };

  res.json(body);
}

/**
 * Which series a request asked for.
 *
 * `load` and `price` hold one each and take no `production_type`. `generation`
 * holds 21, and **all 21 are emitted by default** — `null` for a type the zone
 * does not report, which is the NULL contract at its most load-bearing:
 * `nuclear_mw` is reported by 14 of 34 zones and `marine_mw` by 2, and omitting
 * an unreported type would make "does not report" indistinguishable from "we
 * dropped it".
 *
 * `?production_type=` narrows the emitted set, and narrowing is the only thing
 * it does: a type a zone does not report is still `null` rather than absent when
 * it is asked for by name.
 */
function selectSeries(stream: ObservationStream, raw: unknown): readonly SeriesDefinition[] {
  const all = STREAMS[stream].series;
  if (stream !== 'generation') return all;

  const requested = parseEnumList(raw, 'production_type', PRODUCTION_TYPES);
  if (requested === undefined) return all;

  // Emitted in registry order rather than in the order asked for: a stable
  // field order across requests is what lets a client diff two pages.
  const wanted = new Set(requested);
  return all.filter((definition) => wanted.has(definition.field));
}
