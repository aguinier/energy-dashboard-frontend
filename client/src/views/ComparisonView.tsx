import { lazy, Suspense, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCrossCountryMetrics } from '@/hooks/useDashboardData';
import { ComparisonFilterBar } from '@/components/comparison/ComparisonFilterBar';
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
            className="cursor-pointer border-none bg-transparent p-0 text-[12px] text-ink-dim hover:text-foreground"
          >
            ← Map
          </button>
          <span className="text-[12px] text-ink-faint">/</span>
          <span className="text-[12px] text-ink-dim">Cross-country comparison</span>
        </div>

        <h1 className="m-0 mb-6 text-[36px] font-medium leading-none tracking-[-0.025em]">
          Cross-country comparison
        </h1>

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
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="heatmap" className="gap-1.5">
                  <Grid3X3 className="h-3.5 w-3.5" />
                  Heatmap
                </TabsTrigger>
                <TabsTrigger value="map" className="gap-1.5">
                  <Map className="h-3.5 w-3.5" />
                  Map
                </TabsTrigger>
                <TabsTrigger value="leaderboard" className="gap-1.5">
                  <Trophy className="h-3.5 w-3.5" />
                  Leaderboard
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
          )}
        </div>
      </div>
    </div>
  );
}
