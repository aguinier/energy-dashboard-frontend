import { getOpsStatus, type OpsStatus } from './opsStatusService.js';
import { fetchPeerOpsStatus, type SideStatus } from './peerOpsStatus.js';
import { checkSyncBlackoutWindow, type BlackoutStatus } from '../lib/syncBlackoutWindow.js';
import {
  deriveSideState,
  deriveCommitDriftState,
  type OpsSideDerived,
  type ThresholdState,
} from '../lib/opsStatusThresholds.js';

/**
 * The warn/error verdicts for both lanes (ABL-292). Strictly additive to this
 * payload: `local`, `peer`, `peerConfigured` and `syncBlackout` keep the exact
 * shape ABL-238's deployed `/ops-status` page reads, and the verdict lands in a
 * new sibling key rather than being grafted into either side — anything still
 * on the old shape sees no difference, and `SideStatus` stays the one type
 * `peerOpsStatus.ts` can build straight from a peer's `/api/ops/status`.
 */
export interface CombinedOpsStatusDerived {
  local: OpsSideDerived;
  peer: OpsSideDerived;
  /**
   * Whether the two lanes are on the same build (ABL-287). A cross-lane
   * comparison, so it sits beside the per-side verdicts rather than inside
   * either — see `deriveCommitDriftState`.
   */
  commitDrift: ThresholdState;
}

export interface CombinedOpsStatus {
  timestamp: string;
  /** This process's own KPIs, wrapped the same way the peer's are. */
  local: SideStatus;
  /** The other environment's KPIs, fetched over HTTP via `OPS_PEER_URL`. */
  peer: SideStatus;
  /** False when `OPS_PEER_URL` is unset — lets the client say "not configured" instead of "unreachable". */
  peerConfigured: boolean;
  /**
   * ABL-220's twice-daily DB-sync write-lock window. The client uses this to
   * downgrade an unreachable/degraded side into a known-state annotation
   * rather than a red alarm when the timestamp falls inside it — see
   * `syncBlackoutWindow.ts`.
   */
  syncBlackout: BlackoutStatus;
  /**
   * Per-KPI and overall warn/error state for each lane, derived server-side
   * (ABL-292) so the alert engine (ABL-287) and the trend view (ABL-288) read
   * the same verdict the `/ops-status` page renders, against one copy of the
   * thresholds (`lib/opsStatusThresholds.ts`). Both lanes are covered by
   * construction: the derivation runs off whatever this endpoint reports for
   * each side, and the local side is the peer side on the other environment.
   */
  derived: CombinedOpsStatusDerived;
}

/**
 * Wraps the synchronous, DB-touching `getOpsStatus()` the same way
 * `fetchPeerOpsStatus` wraps the peer HTTP call, so a locked DB during the
 * sync blackout (ABL-220) degrades this side to `reachable: false` instead of
 * throwing through the route and 500ing the whole combined payload — the
 * peer's KPIs must still render even when this process's own DB call fails.
 */
function getLocalSideStatus(now: Date, getStatus: (now: Date) => OpsStatus): SideStatus {
  const startedAt = Date.now();
  try {
    const status = getStatus(now);
    return { reachable: true, latencyMs: Date.now() - startedAt, status };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CombinedOpsStatusDeps {
  getLocalStatus?: (now: Date) => OpsStatus;
  fetchPeer?: (peerUrl: string | undefined) => Promise<SideStatus>;
  env?: Record<string, string | undefined>;
}

/**
 * Merges this process's own KPIs with the peer environment's, for the
 * acceptance/prod status page (ABL-238). Built on top of the single-side
 * `/api/ops/status` payload (ABL-237) — this adds no new metrics of its own,
 * only the peer fetch, the blackout annotation, and the merge.
 *
 * `deps` exists so the merge/aggregation logic is testable without a database
 * or a socket (`combinedOpsStatusService.test.ts`): supply `getLocalStatus`
 * and `fetchPeer` stand-ins and every branch — both up, peer down, local down
 * during a simulated blackout, peer not configured — is a synchronous,
 * deterministic test case.
 */
export async function getCombinedOpsStatus(
  now: Date = new Date(),
  deps: CombinedOpsStatusDeps = {},
): Promise<CombinedOpsStatus> {
  const { getLocalStatus = getOpsStatus, fetchPeer = fetchPeerOpsStatus, env = process.env } = deps;
  const peerUrl = env.OPS_PEER_URL;

  const [local, peer] = await Promise.all([
    Promise.resolve(getLocalSideStatus(now, getLocalStatus)),
    fetchPeer(peerUrl),
  ]);

  const syncBlackout = checkSyncBlackoutWindow(now);

  return {
    timestamp: now.toISOString(),
    local,
    peer,
    peerConfigured: Boolean(peerUrl),
    syncBlackout,
    derived: {
      local: deriveSideState(local, syncBlackout.active),
      peer: deriveSideState(peer, syncBlackout.active),
      commitDrift: deriveCommitDriftState(local, peer),
    },
  };
}
