import { useDashboardStore } from '@/store/dashboardStore';

const REPO_URL = 'https://github.com/aguinier/energy-dashboard-frontend';

// Bottom-of-page CTA: surfaces the real GET endpoint for whatever tab is
// active and links to the API docs. The path shown is the one that actually
// serves the chart above it.
export function ApiCta() {
  const { selectedCountry, activeChartTab } = useDashboardStore();

  // Map tab keys to the real /api resource routes.
  const tabToResource: Record<string, string> = {
    load: 'load',
    price: 'prices',
    renewables: 'renewables',
    generation: 'renewables',
    analytics: 'forecasts/load',
    forecast: 'forecasts/load',
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
        <span className="text-ink-muted">GET</span> /api/{resource}?country=
        <span className="text-primary">{selectedCountry}</span>
      </code>
      <button
        onClick={() => window.open(`${REPO_URL}#readme`, '_blank')}
        className="cursor-pointer rounded-md border-none bg-foreground px-4 py-2.5 text-[13px] font-medium text-background"
      >
        API docs →
      </button>
    </div>
  );
}
