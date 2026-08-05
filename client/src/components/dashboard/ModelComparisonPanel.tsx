import { AbleCard } from './AbleCard';
import { useModelComparison } from '@/hooks/useModelComparison';
import { cn } from '@/lib/utils';
import type { ModelComparisonRow } from './modelComparison';

/**
 * Per-model accuracy comparison for the active forecast type.
 *
 * Rendered as a table rather than bars on purpose. A bar chart has no honest
 * mark for "this model does not serve this country" — the shortest bar and the
 * absent bar both read as "best" — and that is the common case here, not an
 * edge case: catboost and xgboost cover disjoint country sets. A row can say
 * "no data" in words. A bar cannot.
 */

/** A measured number, or a dash that means "not measurable" — never a zero standing in for one. */
function Metric({ value, digits = 0 }: { value: number | null; digits?: number }) {
  if (value == null) {
    return (
      <span className="font-mono-num text-meta text-ink-dim" title="Not measurable in this window">
        —
      </span>
    );
  }
  return <span className="font-mono-num text-meta text-foreground">{value.toFixed(digits)}</span>;
}

function Row({ row }: { row: ModelComparisonRow }) {
  return (
    <div
      className="grid items-center gap-2.5 border-t border-input py-2.5 first:border-t-0"
      style={{ gridTemplateColumns: 'minmax(0,1fr) 42px 64px 60px 64px 56px' }}
    >
      <span className="truncate text-meta text-foreground" title={row.label}>
        {row.label}
      </span>
      <span className="font-mono-num text-micro text-ink-dim">{row.horizon}</span>

      {row.metrics ? (
        <>
          <Metric value={row.metrics.mae} />
          <Metric value={row.metrics.mape} digits={2} />
          <Metric value={row.metrics.rmse} />
          <span className="font-mono-num text-right text-micro text-ink-dim">
            {row.metrics.dataPoints}
          </span>
        </>
      ) : (
        // Spans every metric column. Leaving four empty cells here would put a
        // blank where a number goes, which reads as a value of nothing.
        <span
          className={cn(
            'col-span-4 text-micro',
            row.state === 'error' ? 'text-down' : 'text-ink-muted',
          )}
        >
          {row.note}
        </span>
      )}
    </div>
  );
}

export function ModelComparisonPanel({ forecastType }: { forecastType: string }) {
  const { rows, summary, mlHorizon, isRegistryLoading } = useModelComparison(forecastType);

  const subtitle = isRegistryLoading
    ? 'loading the model registry…'
    : rows.length === 0
      ? `no models registered for ${forecastType}`
      : `${forecastType} · able-ml at D+${mlHorizon} · measured over the selected window`;

  return (
    <AbleCard title="Compare forecast models" subtitle={subtitle}>
      {rows.length === 0 ? (
        <p className="text-micro text-ink-muted">
          {isRegistryLoading
            ? 'Reading the registry…'
            : `No forecast model is registered for ${forecastType}, so there is nothing to compare.`}
        </p>
      ) : (
        <div className="flex flex-col">
          <div
            className="grid items-center gap-2.5 pb-2"
            style={{ gridTemplateColumns: 'minmax(0,1fr) 42px 64px 60px 64px 56px' }}
          >
            <span className="font-mono-num text-label uppercase text-ink-muted">Model</span>
            <span className="font-mono-num text-label uppercase text-ink-muted">Hzn</span>
            <span className="font-mono-num text-label uppercase text-ink-muted">MAE</span>
            <span className="font-mono-num text-label uppercase text-ink-muted">MAPE</span>
            <span className="font-mono-num text-label uppercase text-ink-muted">RMSE</span>
            <span className="font-mono-num text-right text-label uppercase text-ink-muted">
              Samples
            </span>
          </div>

          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}

          <div className="mt-2 space-y-1 border-t border-input pt-2">
            {summary.measuredCount === 0 && (
              <p className="text-micro text-ink-muted">
                None of the registered models has measured accuracy for this country in this
                window. Widen the range, or pick a country one of them serves — catboost and
                xgboost cover different countries.
              </p>
            )}
            {summary.caveats.map((c) => (
              <p key={c} className="text-micro text-ink-muted">
                {c}
              </p>
            ))}
            <p className="text-micro text-ink-muted">
              MAE and RMSE are in the unit of the forecast type; MAPE is a percentage. Samples is
              the number of forecast/actual pairs each figure was measured over. Nothing here is
              extrapolated — a model with no stored forecast for this country shows no number at
              all, rather than a zero.
            </p>
          </div>
        </div>
      )}
    </AbleCard>
  );
}
