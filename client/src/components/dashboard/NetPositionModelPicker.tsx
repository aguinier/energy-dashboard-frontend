import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useMultiModelSelection } from '@/hooks/useForecastModels';
import { netPositionModelColor } from './netPositionModelColors';
import { cn } from '@/lib/utils';

/**
 * Multi-select forecast model picker for the Net position tab (ABL-203),
 * replacing the single-select `ModelPicker` there. Net position is the one
 * type where comparing several registered models on one chart is the actual
 * point — ABL-138/139/175 put four production candidates (Chronos-2 V010 plus
 * three shadow candidates) behind this tab specifically so they could be
 * compared, and until now they could only be viewed one at a time.
 *
 * Two states, same distinction `ModelPicker` draws and for the same reason
 * (ABL-16): "Default" *clears* the selection, every other row *toggles* one
 * model in or out. Absent from the store is the only state that reaches the
 * server's candidate ladder, so it has to stay reachable by a click — here,
 * by unchecking every box or by picking Default directly, whichever the user
 * reaches first.
 */
export function NetPositionModelPicker() {
  const { models, selectedIds, hidden, isLoading } = useMultiModelSelection('net_position');
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
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (isLoading || models.length === 0) return null;

  const enabled = !hidden;
  const isDefault = selectedIds.length === 0;
  const buttonLabel = isDefault
    ? 'Default'
    : selectedIds.length === 1
      ? (models.find((m) => m.id === selectedIds[0])?.label ?? selectedIds[0])
      : `${selectedIds.length} models`;

  return (
    <div ref={ref} className="relative inline-flex items-stretch">
      <button
        onClick={() => setForecastHidden('net_position', enabled)}
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
        <span className="font-medium">{buttonLabel}</span>
        <span aria-hidden="true" className="text-micro text-ink-muted">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="Model · net position"
          className="absolute right-0 top-[110%] z-50 min-w-[320px] rounded-[10px] border border-border bg-card p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.10)]"
        >
          <div className="px-2.5 pb-1.5 pt-2 font-mono-num text-label uppercase text-ink-muted">
            Model · net position
          </div>

          <button
            role="option"
            aria-selected={isDefault}
            onClick={() => {
              clearSelectedModel('net_position');
              setForecastHidden('net_position', false);
              setOpen(false);
            }}
            className={cn(
              'mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md border-none p-2.5 text-left font-sans',
              isDefault ? 'bg-accent' : 'bg-transparent hover:bg-secondary',
            )}
          >
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                isDefault ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
              )}
            >
              {isDefault && '✓'}
            </span>
            <span className="text-body font-medium text-foreground">Default</span>
            <span className="rounded-sm bg-foreground px-1.5 py-px font-mono-num text-label font-semibold uppercase text-background">
              Server picks
            </span>
          </button>

          {models.map((m) => {
            const checked = selectedIds.includes(m.id);
            const color = netPositionModelColor(m.id);
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={checked}
                onClick={() => {
                  toggleSelectedModel('net_position', m.id);
                  setForecastHidden('net_position', false);
                }}
                className={cn(
                  'mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md border-none p-2.5 text-left font-sans',
                  checked ? 'bg-accent' : 'bg-transparent hover:bg-secondary',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                >
                  {checked && '✓'}
                </span>
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: color }}
                />
                <span className="text-body font-medium text-foreground">{m.label}</span>
              </button>
            );
          })}

          <div className="mt-1 border-t border-input px-2.5 py-2 text-micro text-ink-muted">
            Check several to compare them on one chart. <span className="text-foreground">Default</span> lets
            the server pick — the production model first, then the next registered one that has data.
            The p10–p90 band only draws when exactly one model is checked.
          </div>
        </div>
      )}
    </div>
  );
}
