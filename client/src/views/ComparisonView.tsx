import { lazy, Suspense, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCrossCountryMetrics } from '@/hooks/useDashboardData';
import { ComparisonFilterBar } from '@/components/comparison/ComparisonFilterBar';
import { summarizePortfolio } from '@/components/comparison/portfolioSummary';
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
  const { goToMap, comparisonMetric, comparisonTimeRange } = useDashboardStore();
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
              <PortfolioSummary data={data} metric={comparisonMetric} timeRange={comparisonTimeRange} />
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

function PortfolioSummary({ data, metric, timeRange }: {
  data: Parameters<typeof summarizePortfolio>[0];
  metric: Parameters<typeof summarizePortfolio>[1];
  timeRange: '7d' | '30d' | '90d';
}) {
  const summary = summarizePortfolio(data, metric);
  const metricLabel = metric.toUpperCase();
  const facts = [
    { label: 'Countries measured', value: summary.countries },
    { label: 'Forecast types measured', value: summary.forecastTypes },
    { label: `${metricLabel} series measured`, value: summary.measuredSeries },
    { label: 'Paired observations returned', value: summary.pairedObservations.toLocaleString() },
  ];

  return (
    <section className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-4" aria-label="Portfolio coverage">
      {facts.map((fact, index) => (
        <div key={fact.label} className={`px-4 py-3 ${index % 2 === 0 ? 'border-r border-border' : ''} ${index < 2 ? 'border-b border-border sm:border-b-0' : ''} ${index < 3 ? 'sm:border-r sm:border-border' : ''}`}>
          <p className="font-mono-num text-label uppercase text-ink-muted">{fact.label}</p>
          <p className="mt-1 font-mono-num text-title font-medium text-foreground">{fact.value}</p>
        </div>
      ))}
      <p className="col-span-2 border-t border-border px-4 py-2 text-micro text-ink-muted sm:col-span-4">
        Coverage for {metricLabel} over the last {timeRange}. Series without a measurable {metricLabel} are excluded; this is not an averaged portfolio error.
      </p>
    </section>
  );
}
