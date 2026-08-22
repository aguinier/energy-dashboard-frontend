import type { EnergyQuery } from './energySource.js';
import type { FreshnessMap } from './freshnessMap.js';
import type { CatalogRepo } from './catalogRepo.js';
import type { AcknowledgementLedger } from '../modelVersions/acknowledgements.js';

/**
 * Everything the `/v1` data routes need, handed to them rather than reached for.
 *
 * The same injection discipline ABL-300 established for the key store and
 * ABL-301 for the meter, applied to data: `publicApp.ts` names this shape as a
 * **type**, which `tsc` erases, and `publicIndex.ts` decides what fills it. That
 * is what keeps `better-sqlite3` out of the module that serves requests even
 * though this API's whole job is now reading a 9.4 GB SQLite file.
 *
 * It is also what makes the routes testable without a database *or* a clock:
 * `observations.test.ts` fills this with a seeded in-memory handle and a fixed
 * `now`, so "does a cache-free response report the time it was computed" is a
 * checked assertion rather than an unassertable one.
 */
export interface V1DataContext {
  source: EnergyQuery;
  /** Fleet-wide freshness and coverage, memoized on a timer. Never queried per request. */
  freshness: FreshnessMap;
  catalog: CatalogRepo;
  /**
   * Which forecast artifacts a human has signed off (ABL-529).
   *
   * Carried as the **ledger**, not as a resolved gate, because a material
   * acknowledgement becomes servable at its own instant and a gate resolved once
   * at startup would keep withholding the new artifact until somebody restarted
   * the process. The routes build a gate per request from this plus `now`, so
   * the thirtieth day arrives on its own.
   *
   * Required rather than optional on purpose: an optional field defaulting to
   * "no restriction" would make forgetting to wire it a silent fail-open, and
   * this is the field whose absence means a §9.3 breach ships unnoticed. Making
   * it required turns that into a `tsc` error at every construction site.
   */
  acknowledgedVersions: AcknowledgementLedger;
  /**
   * The origin subscribers reach this API on, or `null` for relative links.
   *
   * Configuration, never derived from the request — see `links.ts`. A
   * `192.168.x` address baked into a subscriber's client by a `next` link is the
   * LAN trap ABL-291 brief §2 names, and it is prevented here by there being
   * nothing else to build a link from.
   */
  publicBaseUrl: string | null;
  /**
   * The handler clock.
   *
   * Injected rather than called inline so `generated_at` can be asserted, and
   * because ABL-293 §2g.F requires it to be *handler*-computed: a stamp applied
   * by a serializer or by middleware would be recomputed on a cache replay and
   * would report a cached body as freshly computed, wrong by up to the TTL.
   * There is no response cache here yet; the field is built so that adding one
   * cannot make it lie.
   */
  now: () => Date;
}
