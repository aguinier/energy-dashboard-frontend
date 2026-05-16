import { lazy, Suspense } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { CountryBreadcrumb } from '@/components/dashboard/CountryBreadcrumb';
import { AbleStatRow } from '@/components/dashboard/AbleStatRow';
import { RangeSegment } from '@/components/dashboard/RangeSegment';
import { ModelPicker } from '@/components/dashboard/ModelPicker';
import { ApiCta } from '@/components/dashboard/ApiCta';

// Lazy-loaded tab bodies — each is self-contained (chart cards + adapters).
const PriceTab = lazy(() =>
  import('@/components/dashboard/PriceTab').then((m) => ({ default: m.PriceTab })),
);
const LoadTab = lazy(() =>
  import('@/components/dashboard/LoadTab').then((m) => ({ default: m.LoadTab })),
);
const GenerationTab = lazy(() =>
  import('@/components/dashboard/GenerationTab').then((m) => ({ default: m.GenerationTab })),
);
const ForecastTab = lazy(() =>
  import('@/components/dashboard/ForecastTab').then((m) => ({ default: m.ForecastTab })),
);

function TabSkeleton({ height = 350 }: { height?: number }) {
  return (
    <div className="animate-pulse rounded-xl border border-border bg-card p-6">
      <div className="mb-2 h-5 w-32 rounded bg-muted" />
      <div className="mb-4 h-4 w-48 rounded bg-muted" />
      <div className="w-full rounded bg-muted" style={{ height }} />
    </div>
  );
}

export function CountryDashboardView() {
  const { selectedCountry, activeChartTab, setActiveChartTab } = useDashboardStore();
  const { data: countries } = useCountries();

  const country = countries?.find((c) => c.country_code === selectedCountry);

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-[1200px] px-8 pb-14 pt-7">
        <CountryBreadcrumb />

        <div className="mb-1 flex items-baseline gap-3.5">
          <h1 className="m-0 text-[36px] font-medium leading-none tracking-[-0.025em]">
            {country?.country_name ?? selectedCountry}
          </h1>
          <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono-num text-[12px] text-ink-muted">
            {selectedCountry}
          </span>
        </div>
        <p className="mb-6 mt-2 max-w-[640px] text-[14px] leading-relaxed text-ink-dim">
          Live electricity load, day-ahead price, generation mix and TSO forecast accuracy.
          All values from ENTSO-E, EPEX and the local TSO.
        </p>

        <AbleStatRow />

        <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
          <Tabs value={activeChartTab} onValueChange={setActiveChartTab} className="flex-shrink-0">
            <TabsList>
              <TabsTrigger value="price">Price</TabsTrigger>
              <TabsTrigger value="load">Load</TabsTrigger>
              <TabsTrigger value="renewables">Generation</TabsTrigger>
              <TabsTrigger value="analytics">Forecast accuracy</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex-1" />
          <RangeSegment />
          <ModelPicker />
        </div>

        <Tabs value={activeChartTab} onValueChange={setActiveChartTab}>
          <TabsContent value="price">
            <Suspense fallback={<TabSkeleton />}>
              <PriceTab />
            </Suspense>
          </TabsContent>
          <TabsContent value="load">
            <Suspense fallback={<TabSkeleton />}>
              <LoadTab />
            </Suspense>
          </TabsContent>
          <TabsContent value="renewables">
            <Suspense fallback={<TabSkeleton height={400} />}>
              <GenerationTab />
            </Suspense>
          </TabsContent>
          <TabsContent value="analytics">
            <Suspense fallback={<TabSkeleton height={400} />}>
              <ForecastTab />
            </Suspense>
          </TabsContent>
        </Tabs>

        <ApiCta />
      </div>
    </div>
  );
}
