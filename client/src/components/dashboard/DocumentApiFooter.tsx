import { useDashboardStore } from '@/store/dashboardStore';

const REPO_URL = 'https://github.com/aguinier/energy-dashboard-frontend';

/**
 * One line per figure, rather than a single line for "whatever tab is
 * active". That was `ApiCta`'s job, mapping `activeChartTab` to a resource —
 * a concept this scrolling document has none of, since all six figures are on
 * screen (or lazily mounted) at once with no single "current" one. The design
 * spec's page-structure table calls for exactly this: "footer — per-figure
 * API endpoint"
 * (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md).
 *
 * Built as a new component in Task 9a rather than a mode added to `ApiCta`,
 * specifically to leave the (then still-live) tab view's footer
 * byte-identical while both views coexisted. Task 9b then deleted `ApiCta`
 * along with the tab view it served — this is now the country page's only
 * API footer.
 */
const ENDPOINTS: ReadonlyArray<{ figureNumber: number; label: string; resource: string; usesPathParam?: boolean }> = [
  { figureNumber: 1, label: 'Load', resource: 'load' },
  { figureNumber: 2, label: 'Price', resource: 'prices' },
  // `/api/renewables` (the narrower renewables-only series) used to be listed
  // here — wrong: the figure reads `fetchGenerationSeries` off
  // `/generation/series` so it can draw nuclear and fossil bands alongside
  // the renewable families too (ABL-44; see the figure's own caption).
  // final-review-9, finding 2.
  { figureNumber: 3, label: 'Generation', resource: 'generation/series' },
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
