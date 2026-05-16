import { useDashboardStore } from '@/store/dashboardStore';

// Bottom-of-page CTA: surfaces the GET endpoint for whatever tab is active and
// nudges users toward an API key. Path mirrors the prototype: /v1/<tab>/<XX>.
export function ApiCta() {
  const { selectedCountry, activeChartTab } = useDashboardStore();

  // Map our existing tab keys to the prototype's resource names.
  const tabToResource: Record<string, string> = {
    load: 'load',
    price: 'price',
    renewables: 'generation',
    generation: 'generation',
    analytics: 'forecast',
    forecast: 'forecast',
  };
  const resource = tabToResource[activeChartTab] ?? activeChartTab;

  return (
    <div className="mt-7 flex flex-wrap items-center gap-5 rounded-xl border border-border bg-card px-6 py-5">
      <div className="min-w-[280px] flex-1">
        <div className="mb-1 text-[14px] font-medium">Use this in your own product</div>
        <div className="text-[12.5px] leading-snug text-ink-dim">
          Every chart here is one API call away. Hourly, day-ahead, week-ahead — all markets.
        </div>
      </div>
      <code className="rounded-md border border-border bg-secondary px-3 py-2.5 font-mono-num text-[12px] text-foreground">
        <span className="text-ink-muted">GET</span> /v1/{resource}/
        <span className="text-primary">{selectedCountry}</span>
      </code>
      <button className="cursor-pointer rounded-md border-none bg-foreground px-4 py-2.5 text-[13px] font-medium text-background">
        Get API key →
      </button>
    </div>
  );
}
