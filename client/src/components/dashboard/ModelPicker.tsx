import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useModelSelection, useActiveForecastType, useForecastModels } from '@/hooks/useForecastModels';
import { servedLabel } from '@/lib/servedModel';
import { cn } from '@/lib/utils';

/**
 * Forecast model selector, driven by the server-side registry.
 *
 * Renders the models registered for whichever tab is active, so the choices
 * always match the data on screen: price has no TSO forecast, net position has
 * only the Chronos run, load has both ml models plus TSO D+1/D+7. It used to be
 * a hardcoded ml-vs-TSO toggle rendered on every tab, which meant it appeared
 * to control charts it never touched — net position ignored it entirely.
 *
 * Selection is stored per forecast type, so a choice does not silently carry
 * across to a type where that model does not exist.
 *
 * Two states, not one: the "Default" entry *clears* the pin and the rest set
 * one. That distinction is the whole point — the server honours an explicit
 * `model=` strictly (forecastModels.ts `resolveModelCandidates`), so a pin on
 * the production model blanks every country that model has no rows for, and
 * before ABL-16 every entry here wrote a pin, "Default" included. There was no
 * UI path back to the unpinned ladder; clearing localStorage was the only
 * recovery.
 *
 * Deliberately shows no accuracy numbers. The previous version displayed a
 * "30-day MAPE" column from hardcoded constants (2.4, 3.1, 5.9 …) that were
 * never measured. Real per-model accuracy lives in the Forecast accuracy tab,
 * computed from actuals.
 */
export function ModelPicker() {
  const forecastType = useActiveForecastType();
  const { models, selected, hidden, isLoading, requestModelId } = useModelSelection(forecastType);
  const { data: registry } = useForecastModels();
  const setSelectedModel = useDashboardStore((s) => s.setSelectedModel);
  const clearSelectedModel = useDashboardStore((s) => s.clearSelectedModel);
  const setForecastHidden = useDashboardStore((s) => s.setForecastHidden);
  // Set by the data hooks (useLoadChartData, usePriceChartData) from the
  // forecast response's `meta.model` — the model that actually served, which
  // can differ from `selected` (the provisional/production label) when the
  // server's candidate ladder fell back to a different model for this country.
  const servedModelId = useDashboardStore((s) => s.servedModelByType[forecastType] ?? null);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // A control that cannot act should not be shown.
  if (isLoading || models.length === 0) return null;

  const production = registry?.[forecastType]?.production;
  const enabled = !hidden;

  return (
    <div ref={ref} className="relative inline-flex items-stretch">
      <button
        onClick={() => setForecastHidden(forecastType, enabled)}
        aria-pressed={enabled}
        className={cn(
          'flex h-8 cursor-pointer items-center gap-1.5 rounded-l-md border border-r-0 px-2.5 text-meta font-sans',
          enabled ? 'border-primary bg-accent text-primary' : 'border-border bg-transparent text-ink-dim',
        )}
      >
        <span
          className={cn('h-1.5 w-1.5 rounded-full', enabled ? 'bg-primary' : 'border-[1.5px] border-ink-muted')}
        />
        Forecast
      </button>
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-r-md border border-border bg-card px-2.5 text-meta text-foreground',
          !enabled && 'opacity-60',
        )}
      >
        <span className="font-medium">{servedLabel(models, servedModelId, selected) || 'none'}</span>
        <span aria-hidden="true" className="text-micro text-ink-muted">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={`Model · ${forecastType.replace('_', ' ')}`}
          className="absolute right-0 top-[110%] z-50 min-w-[300px] rounded-[10px] border border-border bg-card p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.10)]"
        >
          <div className="px-2.5 pb-1.5 pt-2 font-mono-num text-label uppercase text-ink-muted">
            Model · {forecastType.replace('_', ' ')}
          </div>

          {models.map((m) => {
            const isDefault = m.id === production;
            const isSelected = enabled && selected?.id === m.id;
            const isPinned = isSelected && requestModelId === m.id;
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  // The default entry clears the pin rather than writing one.
                  // Unpinned is the only state that reaches the server's
                  // fallback ladder, and so the only one that renders for a
                  // country the production model does not cover.
                  if (isDefault) clearSelectedModel(forecastType);
                  else setSelectedModel(forecastType, m.id);
                  // Picking a model is also how you switch the overlay back on.
                  setForecastHidden(forecastType, false);
                  setOpen(false);
                }}
                className={cn(
                  'mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md border-none p-2.5 text-left font-sans',
                  isSelected ? 'bg-accent' : 'bg-transparent hover:bg-secondary',
                )}
              >
                <span
                  className={cn(
                    'rounded-sm px-1.5 py-px font-mono-num text-label font-semibold uppercase',
                    m.source === 'tso'
                      ? 'bg-secondary text-ink-dim'
                      : 'bg-accent text-primary',
                  )}
                >
                  {m.source === 'tso' ? 'TSO' : 'ML'}
                </span>
                <span className="text-body font-medium text-foreground">{m.label}</span>
                {isDefault && (
                  <span className="rounded-sm bg-foreground px-1.5 py-px font-mono-num text-label font-semibold uppercase text-background">
                    Default
                  </span>
                )}
                {isPinned && (
                  <span className="rounded-sm border border-border px-1.5 py-px font-mono-num text-label font-semibold uppercase text-ink-dim">
                    Pinned
                  </span>
                )}
              </button>
            );
          })}

          <div className="mt-1 border-t border-input px-2.5 py-2 text-micro text-ink-muted">
            Coverage differs by country. <span className="text-foreground">Default</span> lets the
            server pick — the production model first, then the next registered one that has data,
            and the chart says which served. Any other choice is pinned to that model alone, and
            stays empty for a country it does not cover.
          </div>
        </div>
      )}
    </div>
  );
}
