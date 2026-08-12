import { AlertTriangle, CheckCircle2, Clock, HelpCircle, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OpsHistoryCard } from '@/components/ops/OpsHistoryCard';
import { useOpsStatus } from '@/hooks/useOpsStatus';
import { useOpsStatusHistory } from '@/hooks/useOpsStatusHistory';
import { deriveEnvironmentState, type ThresholdState } from '@/lib/opsStatusThresholds';
import { formatTimeAgo } from '@/lib/formatters';
import type { CombinedOpsStatus, FreshnessRollup, OpsSideStatus } from '@/types';

/**
 * Internal acceptance/prod status comparison (ABL-238). Reachable only by
 * visiting `/ops-status` directly — deliberately not in `AbleHeader`'s nav or
 * the persisted `currentView` store, per the issue's "doesn't need main-nav
 * prominence". `App.tsx` renders this off `window.location.pathname` instead.
 *
 * All the actual merge/degrade logic (an unreachable peer must never blank
 * this side, a locked local DB during the ABL-220 sync blackout must never
 * blank the peer's) lives server-side in `combinedOpsStatusService.ts`. This
 * component only renders the `{ local, peer }` shape it already produces.
 */
export default function OpsStatusView() {
  const { data, isLoading, isError, refetch, isFetching } = useOpsStatus();
  // Separate query, separate failure: the live KPIs must still render when the
  // snapshot store is unreadable, and the trend must still render during the
  // ABL-220 blackout that degrades the live call (the history endpoint does
  // not touch the database).
  const historyQuery = useOpsStatusHistory();

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-[1000px] px-4 pb-14 pt-7 sm:px-8">
        <div className="mb-3.5 flex items-center gap-2">
          <a href="/" className="text-meta text-ink-dim hover:text-foreground">← Dashboard</a>
          <span className="text-meta text-ink-faint">/</span>
          <span className="text-meta text-ink-dim">Ops status</span>
        </div>
        <h1 className="m-0 mb-2 text-display font-medium">Ops status</h1>
        <p className="mb-6 max-w-2xl text-body text-ink-dim">
          This environment's KPIs and the peer environment's, fetched server-side and merged. Auto-refreshes every 30s.
        </p>

        {isLoading && <SkeletonBlock />}
        {isError && <ErrorBlock onRetry={() => refetch()} />}

        {data && (
          <div className="space-y-4">
            {shouldShowBlackoutBanner(data) && <BlackoutBanner label={data.syncBlackout.label} />}
            <CommitDriftBanner local={data.local} peer={data.peer} />
            <div className="grid gap-4 md:grid-cols-2">
              <EnvironmentCard title="This environment" side={data.local} blackoutActive={data.syncBlackout.active} />
              <EnvironmentCard
                title="Peer environment"
                side={data.peer}
                blackoutActive={data.syncBlackout.active}
                peerConfigured={data.peerConfigured}
              />
            </div>
            {historyQuery.data && <OpsHistoryCard history={historyQuery.data} />}
            {historyQuery.isError && (
              <p className="text-meta text-ink-dim">
                Could not load the snapshot history.{' '}
                <button
                  onClick={() => historyQuery.refetch()}
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  Retry
                </button>
              </p>
            )}
            <p className="text-micro text-ink-faint">
              As of {formatTimeAgo(data.timestamp)}{isFetching ? ' · refreshing…' : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function shouldShowBlackoutBanner(data: CombinedOpsStatus): boolean {
  return data.syncBlackout.active && (!data.local.reachable || !data.peer.reachable);
}

function BlackoutBanner({ label }: { label: string | null }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-body text-ink-dim">
      <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        A side below is unreachable during the {label} — a known DB write-lock window (ABL-220), not
        necessarily an outage. See <code className="font-mono-num">WORKFLOWS.md</code>, "Acceptance
        blackout during Stage 2".
      </span>
    </div>
  );
}

/**
 * Only rendered on an actual mismatch — a matching commit is the
 * unremarkable default and says nothing worth a banner for. Silent (not
 * "unavailable") when either side has no commit to compare, since a `null`
 * commit means a dev server, not drift.
 */
function CommitDriftBanner({ local, peer }: { local: OpsSideStatus; peer: OpsSideStatus }) {
  if (!local.reachable || !peer.reachable) return null;
  const localCommit = local.status.provenance.commit;
  const peerCommit = peer.status.provenance.commit;
  if (!localCommit || !peerCommit || localCommit === peerCommit) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-dirty/40 bg-dirty/5 px-4 py-3 text-body text-foreground">
      <AlertTriangle className="h-4 w-4 shrink-0 text-dirty" aria-hidden="true" />
      <span>
        Commit drift: this environment is on{' '}
        <code className="font-mono-num">{localCommit.slice(0, 7)}</code>, the peer is on{' '}
        <code className="font-mono-num">{peerCommit.slice(0, 7)}</code>.
      </span>
    </div>
  );
}

function EnvironmentCard({
  title,
  side,
  blackoutActive,
  peerConfigured,
}: {
  title: string;
  side: OpsSideStatus;
  blackoutActive: boolean;
  /** Only meaningful for the peer card — `undefined` for the local card, which is always configured. */
  peerConfigured?: boolean;
}) {
  const state = deriveEnvironmentState(side, blackoutActive);
  const notConfigured = peerConfigured === false;

  if (!side.reachable) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-title">{title}</CardTitle>
          <StateBadge state={notConfigured ? 'unknown' : state} label={notConfigured ? 'Not configured' : STATE_LABEL[state]} />
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          {notConfigured ? (
            <p className="text-body text-ink-dim">
              <code className="font-mono-num">OPS_PEER_URL</code> is not set for this environment.
            </p>
          ) : (
            <>
              <p className="text-body text-foreground">
                Unreachable{side.latencyMs !== null ? ` after ${side.latencyMs}ms` : ''}
              </p>
              <p className="text-meta text-ink-dim">{side.error}</p>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const { status } = side;
  const disk = status.host.disk;
  const diskPercent = disk && disk.totalBytes > 0 ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-title">{title}</CardTitle>
        <StateBadge state={state} label={STATE_LABEL[state]} />
      </CardHeader>
      <CardContent className="space-y-2.5 pt-0">
        <Row label="Latency" value={`${side.latencyMs}ms`} />
        <Row
          label="Commit"
          value={status.provenance.commit ? status.provenance.commit.slice(0, 7) : `— (${status.provenance.runtime})`}
        />
        <Row label="Freshness" value={describeFreshnessRollup(status.freshness)} />
        <Row
          label="Disk"
          value={disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} (${diskPercent}%)` : 'not measured'}
        />
        <Row label="Memory (RSS)" value={formatBytes(status.process.memory.rssBytes)} />
        <Row label="Uptime" value={formatUptime(status.process.uptimeSeconds)} />
        <Row label="CPU load (1m)" value={status.host.cpuLoad ? status.host.cpuLoad.load1.toFixed(2) : 'not measured on Windows'} />
        {status.freshness.staleCountries.length > 0 && (
          <p className="pt-1 text-meta text-ink-dim">Stale: {status.freshness.staleCountries.join(', ')}</p>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-meta text-ink-dim">{label}</span>
      <span className="font-mono-num text-body text-foreground">{value}</span>
    </div>
  );
}

const STATE_LABEL: Record<ThresholdState, string> = {
  ok: 'OK',
  warn: 'Degraded',
  error: 'Down',
  unknown: 'Unknown',
};

const STATE_ICON: Record<ThresholdState, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
  unknown: HelpCircle,
};

const STATE_CLASS: Record<ThresholdState, string> = {
  ok: 'border-clean/40 bg-clean/5 text-clean',
  warn: 'border-amber-600/40 bg-amber-600/5 text-amber-700 dark:text-amber-400',
  error: 'border-dirty/40 bg-dirty/5 text-dirty',
  unknown: 'border-border bg-transparent text-ink-faint',
};

function StateBadge({ state, label }: { state: ThresholdState; label: string }) {
  const Icon = STATE_ICON[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-meta font-medium ${STATE_CLASS[state]}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

function describeFreshnessRollup(freshness: FreshnessRollup): string {
  if (freshness.status === 'stale') return `stale (${freshness.counts.stale}/${freshness.streamsChecked} streams)`;
  if (freshness.status === 'live') return 'live';
  if (freshness.status === 'ended') return 'ended (not an alarm)';
  return 'no data held';
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function SkeletonBlock() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
    </div>
  );
}

function ErrorBlock({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card">
      <p className="text-body text-ink-dim">Could not load ops status.</p>
      <button
        onClick={onRetry}
        className="cursor-pointer rounded-md border border-border bg-transparent px-3 py-1.5 text-meta hover:bg-secondary"
      >
        Retry
      </button>
    </div>
  );
}
