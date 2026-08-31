import { useDashboardStore } from '@/store/dashboardStore';

const REPO_URL = 'https://github.com/aguinier/energy-dashboard-frontend';

/**
 * One line per figure, rather than `ApiCta`'s single line for "whatever tab
 * is active". `ApiCta` (unchanged, still `CountryDashboardView`'s footer)
 * maps `activeChartTab` to a resource — a concept this scrolling document has
 * none of, since all six figures are on screen (or lazily mounted) at once
 * with no single "current" one. The design spec's page-structure table calls
 * for exactly this: "footer — per-figure API endpoint"
 * (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md).
 *
 * A separate component rather than a mode added to `ApiCta` — Task 9a leaves
 * the tab view byte-identical, and `ApiCta` is still that view's live footer.
 */
const ENDPOINTS: ReadonlyArray<{ figureNumber: number; label: string; resource: string; usesPathParam?: boolean }> = [
  { figureNumber: 1, label: 'Load', resource: 'load' },
  { figureNumber: 2, label: 'Price', resource: 'prices' },
  { figureNumber: 3, label: 'Generation', resource: 'renewables' },
  { figureNumber: 4, label: 'Wind onshore', resource: 'generation/wind' },
  { figureNumber: 5, label: 'Wind offshore', resource: 'generation/wind' },
  // net-position takes the country code in the path, not as a query param —
  // see server/src/routes/netPosition.ts:23. Every other resource above takes
  // `?country=`.
  { figureNumber: 6, label: 'Net position', resource: 'net-position', usesPathParam: true },
];

export function DocumentApiFooter() {
  const selectedCountry = useDashboardStore((s) => s.selectedCountry);

  return (
    <div className="mt-7 rounded-xl border border-border bg-card px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-5">
        <div className="min-w-[280px] flex-1">
          <div className="mb-1 text-title font-medium">Use this in your own product</div>
          <div className="text-meta leading-snug text-ink-dim">
            Every figure above is one API call away. Hourly, day-ahead, week-ahead — all markets.
          </div>
        </div>
        <button
          onClick={() => window.open(`${REPO_URL}#readme`, '_blank')}
          className="cursor-pointer rounded-md border-none bg-foreground px-4 py-2.5 text-body font-medium text-background"
        >
          API docs →
        </button>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {ENDPOINTS.map((e) => (
          <code
            key={`${e.figureNumber}-${e.resource}`}
            className="flex flex-wrap items-baseline gap-1.5 rounded-md border border-border bg-secondary px-3 py-2 font-mono-num text-meta text-foreground"
          >
            <span className="text-ink-muted">
              Fig. {e.figureNumber} · {e.label}
            </span>
            <span className="text-ink-muted">GET</span>
            <span>
              /api/{e.resource}
              {e.usesPathParam ? '/' : '?country='}
              <span className="text-primary">{selectedCountry}</span>
            </span>
          </code>
        ))}
      </div>
    </div>
  );
}
