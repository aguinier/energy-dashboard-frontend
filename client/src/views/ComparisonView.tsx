import { lazy, Suspense, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCrossCountryMetrics } from '@/hooks/useDashboardData';
import { ComparisonFilterBar } from '@/components/comparison/ComparisonFilterBar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Grid3X3, Map, Trophy } from 'lucide-react';

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
    <div className="rounded-lg border bg-card p-6 animate-pulse">
      <div className="h-5 w-32 bg-muted rounded mb-4" />
      <div className="h-64 w-full bg-muted rounded" />
    </div>
  );
}

export default function ComparisonView() {
  const { goToMap } = useDashboardStore();
  const { data, isLoading, isError } = useCrossCountryMetrics();
  const [activeTab, setActiveTab] = useState('heatmap');

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center gap-4 px-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={goToMap}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Map
          </Button>
          <div className="h-6 w-px bg-border" />
          <h1 className="text-lg font-semibold">Cross-Country Comparison</h1>
        </div>
      </header>

      {/* Content */}
      <main className="container mx-auto px-4 py-6 space-y-4">
        {/* Filter Bar */}
        <ComparisonFilterBar />

        {/* Loading / Error states */}
        {isLoading && (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center gap-4">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading comparison data...</p>
            </div>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-center h-64">
            <p className="text-sm text-muted-foreground">
              Failed to load comparison data. The backend API may not be available yet.
            </p>
          </div>
        )}

        {/* Tabs */}
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
      </main>
    </div>
  );
}
