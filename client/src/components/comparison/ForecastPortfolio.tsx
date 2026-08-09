import type { CrossCountryMetrics } from '@/types';
import { buildPortfolioRows } from './portfolioRows';

export function ForecastPortfolio({ data }: { data: CrossCountryMetrics }) {
  const rows = buildPortfolioRows(data);

  return (
    <section aria-labelledby="forecast-portfolio-heading" className="rounded-lg border bg-card p-4">
      <div className="mb-4">
        <h2 id="forecast-portfolio-heading" className="m-0 text-base font-medium text-foreground">
          Forecast performance by variable
        </h2>
        <p className="mt-1 text-sm text-ink-dim">
          WAPE compares stored forecasts with actuals in this period. Each range is across countries for that variable;
          variables are not compared with each other.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.type} className="rounded-md border border-border bg-background px-3 py-2.5">
            <p className="m-0 text-sm font-medium text-foreground">{row.label}</p>
            {row.coverage === 'measured' ? (
              <>
                <p className="mt-1 font-mono-num text-lg text-foreground">
                  {row.minWape!.toFixed(1)}–{row.maxWape!.toFixed(1)}%
                </p>
                <p className="text-xs text-ink-dim">
                  WAPE across {row.measuredCountries} {row.measuredCountries === 1 ? 'country' : 'countries'}
                </p>
              </>
            ) : row.coverage === 'unmeasurable' ? (
              <>
                <p className="mt-1 text-sm font-medium text-ink-dim">WAPE not measurable</p>
                <p className="mt-1 text-xs text-ink-dim">
                  {row.pairedCountries} paired {row.pairedCountries === 1 ? 'country has' : 'countries have'} zero total actuals.
                </p>
              </>
            ) : (
              <>
                <p className="mt-1 text-sm font-medium text-ink-dim">No cross-country measure</p>
                <p className="mt-1 text-xs text-ink-dim">
                  No paired forecast-versus-actual measure is returned for this variable in this period.
                </p>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
