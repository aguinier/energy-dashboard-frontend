import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useMultiModelSelection, useActiveForecastType, useRecommendedModel } from '@/hooks/useForecastModels';
import { forecastLineToken } from './forecastLineTokens';
import { describeAutoSelectionHint } from './autoSelection';
import { cn } from '@/lib/utils';

/**
 * Multi-select forecast model picker for Load and Price (ABL-204).
 *
 * Was a single-select dropdown until this change — one pin, one line. It now
 * follows net position's shipped baseline (`NetPositionModelPicker.tsx`,
 * ABL-203: a "Default" state that clears the pin, plus additive checkboxes)
 * with the refinements from ABL-205's Design Consultant pass, since coverage
 * on these two tabs makes a selected-but-empty model the ordinary outcome of
 * checking two boxes rather than a rare edge case (catboost/xgboost cover
 * near-disjoint country sets on `load`):
 *
 * - Collapsed trigger label is `Models · Default` / `Models · N selected`
 *   rather than naming the single selected model — with several models
 *   checked there is no one label to show, and the design doc asks for
 *   names to live in a tooltip instead of header chips (this uses the
 *   native `title` attribute for that).
 * - Real `<input type="checkbox">` rows instead of `role="option"` buttons in
 *   a `role="listbox"` — the design doc calls the listbox pattern out
 *   specifically, because it reads as one more multi-select option rather
 *   than the mutually-exclusive "Default" mode sitting beside an additive
 *   checkbox group. Native checkboxes also give Tab/Space/Enter for free.
 * - Each row previews the model's categorical colour + dash pattern
 *   (`forecastLineTokens.ts`) so the picker and the chart's legend agree
 *   before the user even opens the chart.
 *
 * "Default" still clears the pin rather than being one checkbox among
 * others (ABL-16): unpinned is the only state that reaches the server's
 * fallback ladder, so it has to stay reachable by a single click, and
 * `toggleSelectedModel` already returns to it automatically when the last
 * checked box is unchecked (store/dashboardStore.ts).
 *
 * Since ABL-469 that "Default" is auto-selected per (country, forecast type)
 * from measured accuracy across both sources, so the row says which model it
 * currently resolves to and on what evidence (`describeAutoSelectionHint`).
 * Naming it is the point: on the pairs where the ENTSO-E series wins, the
 * default silently changes source, and a reader who assumes the dashed line is
 * always ours would be wrong without anything on screen to correct them.
 *
 * Deliberately not applied here: a per-row "not available in <country>"
 * hint while the dropdown is open. That needs this component to know the
 * current query results, which today live in the tab's own data hook, not
 * here — see the CLAUDE.md note on ABL-204 for why that plumbing was left
 * for a follow-up. The chart's legend and the per-model footnote below the
 * chart already say it once the user closes the dropdown and looks at the
 * chart, which is what the acceptance criteria for this change requires.
 */
export function ModelPicker() {
  const forecastType = useActiveForecastType();
  const { models, selectedIds, hidden, isLoading } = useMultiModelSelection(forecastType);
  // The measured best forecast for this (country, type) pair — what "Default"
  // actually resolves to since ABL-469. Undefined until it lands, and on an
  // older server, in which case the row keeps its pre-ABL-469 wording.
  const { data: recommended } = useRecommendedModel(forecastType);
  const toggleSelectedModel = useDashboardStore((s) => s.toggleSelectedModel);
  const clearSelectedModel = useDashboardStore((s) => s.clearSelectedModel);
  const setForecastHidden = useDashboardStore((s) => s.setForecastHidden);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A control that cannot act should not be shown.
  if (isLoading || models.length === 0) return null;

  const enabled = !hidden;
  const isDefault = selectedIds.length === 0;
  const buttonLabel = isDefault ? 'Default' : `${selectedIds.length} selected`;
  const selectedNames = selectedIds.map((id) => models.find((m) => m.id === id)?.label ?? id).join(', ');

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
        aria-haspopup="true"
        aria-expanded={open}
        title={isDefault ? undefined : selectedNames}
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-r-md border border-border bg-card px-2.5 text-meta text-foreground',
          !enabled && 'opacity-60',
        )}
      >
        <span className="font-medium">Models · {buttonLabel}</span>
        <span aria-hidden="true" className="text-micro text-ink-muted">▾</span>
      </button>

      {open && (
        <div
          role="group"
          aria-label={`Forecast models · ${forecastType.replace('_', ' ')}`}
          className="absolute right-0 top-[110%] z-50 min-w-[320px] rounded-[10px] border border-border bg-card p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.10)]"
        >
          <div className="px-2.5 pb-1.5 pt-2 font-mono-num text-label uppercase text-ink-muted">
            Forecast models · {forecastType.replace('_', ' ')}
          </div>

          <button
            role="radio"
            aria-checked={isDefault}
            onClick={() => {
              clearSelectedModel(forecastType);
              setForecastHidden(forecastType, false);
              setOpen(false);
            }}
            className={cn(
              'mb-0.5 flex w-full cursor-pointer items-start gap-2 rounded-md border-none p-2.5 text-left font-sans',
              isDefault ? 'bg-accent' : 'bg-transparent hover:bg-secondary',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                isDefault ? 'border-primary' : 'border-border',
              )}
            >
              {isDefault && <span className="h-2 w-2 rounded-full bg-primary" />}
            </span>
            <span>
              <span className="block text-body font-medium text-foreground">Default — automatic</span>
              <span className="block text-micro text-ink-muted">
                {describeAutoSelectionHint(recommended)}
              </span>
            </span>
          </button>

          <div className="my-1 border-t border-input" />

          {models.map((m) => {
            const checked = selectedIds.includes(m.id);
            const token = forecastLineToken(m.id);
            return (
              <label
                key={m.id}
                className={cn(
                  'mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md p-2.5 text-left font-sans',
                  checked ? 'bg-accent' : 'bg-transparent hover:bg-secondary',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    toggleSelectedModel(forecastType, m.id);
                    setForecastHidden(forecastType, false);
                  }}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    'rounded-sm px-1.5 py-px font-mono-num text-label font-semibold uppercase',
                    m.source === 'tso' ? 'bg-secondary text-ink-dim' : 'bg-accent text-primary',
                  )}
                >
                  {m.source === 'tso' ? 'TSO' : 'ML'}
                </span>
                <span className="flex-1 text-body font-medium text-foreground">{m.label}</span>
                <svg aria-hidden="true" width="20" height="8" className="shrink-0">
                  <line x1="0" y1="4" x2="20" y2="4" stroke={token.color} strokeWidth={2} strokeDasharray={token.dash} />
                </svg>
              </label>
            );
          })}

          <div className="mt-1 border-t border-input px-2.5 py-2 text-micro text-ink-muted">
            Check one or more to compare them on one chart. <span className="text-foreground">Default</span> shows
            whichever forecast — ours or the TSO&rsquo;s — has measured most accurately for this country
            over the last 30 days, and falls back to the production model where there is no track record yet.
            A checked model with nothing to show for this country stays listed, marked unavailable.
          </div>
        </div>
      )}
    </div>
  );
}
