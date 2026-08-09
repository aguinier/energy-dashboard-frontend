import { lazy, Suspense, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCrossCountryMetrics } from '@/hooks/useDashboardData';
import { ComparisonFilterBar } from '@/components/comparison/ComparisonFilterBar';
import { buildPortfolioRows } from '@/components/comparison/portfolioSummary';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Grid3X3, Map, Trophy } from 'lucide-react';

const ComparisonHeatmap = lazy(() =>
  import('@/components/comparison/ComparisonHeatmap').then(m => ({ default: m.ComparisonHeatmap }))
);
const ComparisonMap = lazy(() =>
  import('@/components/comparison/ComparisonMap').then(m => ({ default: m.ComparisonMap }))
);
const ComparisonLeaderboard = lazy(() =>
  import('@/components/comparison/ComparisonLeaderboard').then(m => ({ default: m.ComparisonLeaderboard }))
);

function TabSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-border bg-card p-6">
      <div className="mb-4 h-5 w-32 rounded bg-muted" />
      <div className="h-64 w-full rounded bg-muted" />
    </div>
  );
}

export default function ComparisonView() {
  const { goToMap } = useDashboardStore();
  const { data, isLoading, isError } = useCrossCountryMetrics();
  const [activeTab, setActiveTab] = useState('heatmap');

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-[1200px] px-8 pb-14 pt-7">
        <div className="mb-3.5 flex items-center gap-2">
          <button
            onClick={goToMap}
            className="cursor-pointer border-none bg-transparent p-0 text-meta text-ink-dim hover:text-foreground"
          >
            ← Map
          </button>
          <span className="text-meta text-ink-faint">/</span>
          <span className="text-meta text-ink-dim">Forecast quality</span>
        </div>

        <h1 className="m-0 mb-6 text-display font-medium">
          Forecast quality
        </h1>

        <p className="-mt-4 mb-6 max-w-2xl text-body text-ink-dim">
          Measured forecast performance across the portfolio. Choose a country to inspect its detail.
        </p>

        <div className="space-y-4">
          <ComparisonFilterBar />

          {isLoading && (
            <div className="flex h-64 items-center justify-center">
              <div className="flex flex-col items-center gap-4">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                <p className="text-sm text-ink-dim">Loading comparison data…</p>
              </div>
            </div>
          )}

          {isError && (
            <div className="flex h-64 items-center justify-center">
              <p className="text-sm text-ink-dim">
                Failed to load comparison data. The backend API may not be available yet.
              </p>
            </div>
          )}

          {data && !isLoading && (
            <>
              <PortfolioSummary data={data} />
              <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="heatmap" className="gap-1.5">
                  <Grid3X3 className="h-3.5 w-3.5" />
                  Portfolio
                </TabsTrigger>
                <TabsTrigger value="map" className="gap-1.5">
                  <Map className="h-3.5 w-3.5" />
                  Map
                </TabsTrigger>
                <TabsTrigger value="leaderboard" className="gap-1.5">
                  <Trophy className="h-3.5 w-3.5" />
                  Country ranking
                </TabsTrigger>
              </TabsList>

              <TabsContent value="heatmap">
                <Suspense fallback={<TabSkeleton />}>
                  <ComparisonHeatmap data={data} />
                </Suspense>
              </TabsContent>

              <TabsContent value="map">
                <Suspense fallback={<TabSkeleton />}>
                  <ComparisonMap data={data} />
                </Suspense>
              </TabsContent>

              <TabsContent value="leaderboard">
                <Suspense fallback={<TabSkeleton />}>
                  <ComparisonLeaderboard data={data} />
                </Suspense>
              </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PortfolioSummary({ data }: { data: Parameters<typeof buildPortfolioRows>[0] }) {
  const rows = buildPortfolioRows(data);

  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Forecast performance by variable">
      <h2 className="m-0 text-body font-medium text-foreground">Forecast performance by variable</h2>
      <p className="mt-1 text-micro text-ink-muted">
        WAPE compares stored forecasts with actuals. Ranges are across countries for one variable; they are not a cross-variable score.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.type} className="rounded-lg border border-border bg-background px-3 py-2.5">
            <p className="m-0 text-meta font-medium text-foreground">{row.label}</p>
            {row.coverage === 'measured' ? (
              <>
                <p className="mt-1 font-mono-num text-title text-foreground">{row.minWape!.toFixed(1)}–{row.maxWape!.toFixed(1)}%</p>
                <p className="text-micro text-ink-muted">WAPE across {row.measuredCountries} {row.measuredCountries === 1 ? 'country' : 'countries'}</p>
              </>
            ) : row.coverage === 'unmeasurable' ? (
              <>
                <p className="mt-1 text-meta font-medium text-ink-dim">WAPE not measurable</p>
                <p className="mt-1 text-micro text-ink-muted">{row.pairedCountries} paired {row.pairedCountries === 1 ? 'country has' : 'countries have'} zero total actuals.</p>
              </>
            ) : (
              <>
                <p className="mt-1 text-meta font-medium text-ink-dim">No cross-country measure</p>
                <p className="mt-1 text-micro text-ink-muted">No paired forecast-versus-actual measure is returned for this variable.</p>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
