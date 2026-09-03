import type { OpsStatus } from './opsStatusService.js';

/**
 * Reachable-or-not shape for one environment's status, for the acceptance/prod
 * comparison page (ABL-238). `combinedOpsStatusService.ts` uses this same shape
 * for the *local* side too (wrapping `getOpsStatus()` in a try/catch) so both
 * sides degrade identically: a genuinely down peer comes back `reachable:
 * false` with a message, never a thrown error that would 500 the whole
 * combined payload over one side.
 *
 * **A locked database is no longer one of those cases** (ABL-657). It used to
 * be — `/api/ops/status` 500'd for the duration of the ABL-220 sync window and
 * both sides read it as unreachable — which meant this flag answered "did the
 * environment respond?" with "could it read its database?". Those are different
 * questions and the second one has its own KPI. A side that answers is
 * `reachable: true` even when its freshness rollup comes back `unmeasured`.
 */
export type SideStatus =
  | { reachable: true; latencyMs: number; status: OpsStatus }
  | { reachable: false; latencyMs: number | null; error: string };

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Fetches `${peerUrl}/api/ops/status`. `peerUrl` is `OPS_PEER_URL` — deliberately
 * not hardcoded here (or anywhere in source): prod's peer is CAT/acceptance and
 * acceptance's peer is prod, so the same code has to answer with a different LAN
 * IP depending which environment's process is running it (`../../../WORKFLOWS.md`,
 * "API proxy on CAT").
 *
 * `fetchImpl` is injectable so the timeout/malformed/refused branches are
 * directly testable without a real socket (`peerOpsStatus.test.ts`).
 */
export async function fetchPeerOpsStatus(
  peerUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SideStatus> {
  if (!peerUrl) {
    return { reachable: false, latencyMs: null, error: 'OPS_PEER_URL is not configured' };
  }

  const url = `${peerUrl.replace(/\/+$/, '')}/api/ops/status`;
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return {
      reachable: false,
      latencyMs,
      error: timedOut ? `timed out after ${timeoutMs}ms` : message,
    };
  }

  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    return { reachable: false, latencyMs, error: `peer responded ${res.status} ${res.statusText}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { reachable: false, latencyMs, error: 'peer response was not valid JSON' };
  }

  const envelope = body as { success?: boolean; data?: OpsStatus };
  if (!envelope || envelope.success !== true || !envelope.data) {
    return { reachable: false, latencyMs, error: 'peer response was not the expected { success, data } envelope' };
  }

  return { reachable: true, latencyMs, status: envelope.data };
}
