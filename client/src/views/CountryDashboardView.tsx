import { lazy, Suspense } from 'react';
import { DashboardGrid } from '@/components/dashboard/DashboardGrid';
import { CountryHeader } from '@/components/layout/CountryHeader';
import { Sidebar } from '@/components/layout/Sidebar';
import { TimeNavigator } from '@/components/dashboard/TimeNavigator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDashboardStore } from '@/store/dashboardStore';

// Lazy load chart components (heavy - contain Recharts)
const LoadChart = lazy(() => import('@/components/charts/LoadChart').then(m => ({ default: m.LoadChart })));
const PriceChart = lazy(() => import('@/components/charts/PriceChart').then(m => ({ default: m.PriceChart })));
const RenewableMixChart = lazy(() => import('@/components/charts/RenewableMixChart').then(m => ({ default: m.RenewableMixChart })));
const RenewablePieChart = lazy(() => import('@/components/charts/RenewablePieChart').then(m => ({ default: m.RenewablePieChart })));
const PriceHeatmap = lazy(() => import('@/components/charts/PriceHeatmap').then(m => ({ default: m.PriceHeatmap })));
const ForecastAnalyticsPanel = lazy(() => import('@/components/analytics').then(m => ({ default: m.ForecastAnalyticsPanel })));

// Chart loading skeleton
function ChartSkeleton({ height = 350 }: { height?: number }) {
  return (
    <div className="rounded-lg border bg-card p-6 animate-pulse">
      <div className="h-5 w-32 bg-muted rounded mb-2" />
      <div className="h-4 w-48 bg-muted rounded mb-4" />
      <div className="w-full bg-muted rounded" style={{ height }} />
    </div>
  );
}

export function CountryDashboardView() {
  const { activeChartTab, setActiveChartTab } = useDashboardStore();

  return (
    <div className="min-h-screen bg-background">
      {/* Country Header with back button */}
      <CountryHeader />

      {/* Main content with sidebar */}
      <div className="flex">
        {/* Alphabetical country sidebar */}
        <Sidebar />

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          <div className="container mx-auto px-4 py-6 space-y-6">
        {/* Stats Grid */}
        <DashboardGrid />

        {/* Time Navigation */}
        <div className="flex justify-center">
          <TimeNavigator />
        </div>

        {/* Chart Tabs */}
        <Tabs value={activeChartTab} onValueChange={setActiveChartTab}>
          <TabsList className="grid w-full max-w-lg mx-auto grid-cols-4">
            <TabsTrigger value="load">Load</TabsTrigger>
            <TabsTrigger value="price">Price</TabsTrigger>
            <TabsTrigger value="renewables">Renewables</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>

          <TabsContent value="load" className="mt-6">
            <Suspense fallback={<ChartSkeleton />}>
              <LoadChart />
            </Suspense>
          </TabsContent>

          <TabsContent value="price" className="space-y-6 mt-6">
            <Suspense fallback={<ChartSkeleton />}>
              <PriceChart />
            </Suspense>
            <Suspense fallback={<ChartSkeleton />}>
              <PriceHeatmap />
            </Suspense>
          </TabsContent>

          <TabsContent value="renewables" className="space-y-6 mt-6">
            <Suspense fallback={<ChartSkeleton height={400} />}>
              <RenewableMixChart />
            </Suspense>
            <Suspense fallback={<ChartSkeleton height={300} />}>
              <RenewablePieChart />
            </Suspense>
          </TabsContent>

          <TabsContent value="analytics" className="mt-6">
            <Suspense fallback={<ChartSkeleton height={400} />}>
              <ForecastAnalyticsPanel />
            </Suspense>
          </TabsContent>
        </Tabs>
          </div>
        </main>
      </div>
    </div>
  );
}
