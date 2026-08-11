import { lazy, Suspense } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { CountryBreadcrumb } from '@/components/dashboard/CountryBreadcrumb';
import { TimePicker } from '@/components/dashboard/TimePicker';
import { ModelPicker } from '@/components/dashboard/ModelPicker';
import { NetPositionModelPicker } from '@/components/dashboard/NetPositionModelPicker';
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
const NetPositionTab = lazy(() =>
  import('@/components/dashboard/NetPositionTab').then((m) => ({ default: m.NetPositionTab })),
);

function TabSkeleton({ height = 350 }: { height?: number }) {
  return (
    <div className="animate-pulse rounded-xl border border-border bg-card p-5">
      <div className="mb-2 h-5 w-32 rounded bg-muted" />
      <div className="mb-4 h-4 w-48 rounded bg-muted" />
      <div className="w-full rounded bg-muted" style={{ height }} />
    </div>
  );
}

// Chart axes and tooltips format with `toLocaleTimeString([], …)` — i.e. the
// *viewer's* timezone, not the market's and not the Brussels zone the `today`
// / `thisWeek` presets are computed in (lib/timezone.ts). An unlabelled hour
// axis is a real hazard for this audience: "peak at 18:00" means different
// things in Lisbon and Helsinki. State the zone the numbers are actually
// drawn in rather than asserting CET, which would be wrong for most viewers.
const LOCAL_ZONE_LABEL = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
})();

// Tabs whose chart reads a multi-select model picker (`ModelPicker`, ABL-204
// — was single-select until then). `renewables` (Generation) and `analytics`
// (Forecast accuracy) render no picker at all — GenerationTab shows actuals
// only, and the accuracy overlay is driven by the Load tab's own selection.
// `net-position` has its own separate multi-select picker
// (`NetPositionModelPicker`, ABL-203) rather than this one — the two pickers
// are not unified into one component; see CLAUDE.md's "Forecast model
// selection" section for why.
const TABS_WITH_MODEL_PICKER = new Set(['price', 'load']);

export function CountryDashboardView() {
  const { selectedCountry, activeChartTab, setActiveChartTab, goToComparison } = useDashboardStore();
  const { data: countries } = useCountries();

  const country = countries?.find((c) => c.country_code === selectedCountry);

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto max-w-[1200px] px-5 pb-14 pt-6 md:px-8">
        <CountryBreadcrumb />

        {/* Identity block. The 36px title, its badge and a two-line paragraph
            of prose used to occupy ~150px above the fold before a single
            number appeared — and the prose only restated the tab labels
            directly below it ("load, day-ahead price, generation mix and TSO
            forecast accuracy"). What it carried that the tabs did not is the
            provenance, so that survives as one compact line, joined by the
            timezone the axes are actually drawn in. */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div>
            <div className="flex items-baseline gap-3">
              <h1 className="m-0 text-display font-medium">
                {country?.country_name ?? selectedCountry}
              </h1>
              <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono-num text-micro text-ink-muted">
                {selectedCountry}
              </span>
            </div>
            <p className="mt-1.5 text-meta text-ink-dim">
              ENTSO-E · EPEX · local TSO
            </p>
          </div>
          <p className="font-mono-num text-micro text-ink-muted">
            times in {LOCAL_ZONE_LABEL}
          </p>
        </div>

        {/* One control bar, one control height. Tabs (h-9, the radix default),
            the range control (~24px) and ModelPicker (~26px) previously each
            set their own, so the row read as three unrelated widgets that had
            landed next to each other rather than one bar. All are h-8 now:
            "what am I looking at" on the left, "over what window / which
            model" on the right, sharing a baseline. `TimePicker` keeps that
            height for both of its pills and for the shifted-window caption. */}
        <div className="mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Tabs value={activeChartTab} onValueChange={setActiveChartTab} className="flex-shrink-0">
            <TabsList>
              <TabsTrigger value="price">Price</TabsTrigger>
              <TabsTrigger value="load">Load</TabsTrigger>
              <TabsTrigger value="renewables">Generation</TabsTrigger>
              <TabsTrigger value="net-position">Net position</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex-1" />
          <TimePicker />
          {TABS_WITH_MODEL_PICKER.has(activeChartTab) && <ModelPicker />}
          {activeChartTab === 'net-position' && <NetPositionModelPicker />}
        </div>

        {activeChartTab === 'analytics' && (
          <div className="mb-3.5 flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
            <div>
              <p className="text-meta font-medium text-foreground">Forecast quality detail</p>
              <p className="text-micro text-ink-muted">Measured performance for {country?.country_name ?? selectedCountry}</p>
            </div>
            <button onClick={goToComparison} className="cursor-pointer rounded-md border border-border bg-background px-2.5 py-1 text-meta text-ink-dim hover:text-foreground">
              ← Forecast quality
            </button>
          </div>
        )}

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
          <TabsContent value="net-position">
            <Suspense fallback={<TabSkeleton />}>
              <NetPositionTab />
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
