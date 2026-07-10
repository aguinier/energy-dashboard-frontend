import { useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '@/store/dashboardStore';
import { cn } from '@/lib/utils';

// Forecast model selector — visually faithful to the able prototype.
// Reads/writes existing layer state (`layers.tso.enabled`, `layers.ml.enabled`,
// `tsoForecastType`) so toggling the Forecast pill flips the same live overlays
// as the older controls. Multi-model evaluation (Meteologica, Ensemble, etc.)
// is shown but disabled until those providers ship — flagged with a `wired` bit.

export type ModelId = 'able-ml' | 'tso-d1' | 'tso-d7' | 'meteologica' | 'persistence' | 'ensemble';

export interface ForecastModel {
  id: ModelId;
  name: string;
  version: string;
  kind: 'internal' | 'third-party' | 'official' | 'baseline' | 'ensemble';
  mape: number;
  mae: number;
  updated: string;
  recommended?: boolean;
  wired: boolean;
  blurb: string;
}

export const FORECAST_MODELS: ForecastModel[] = [
  {
    id: 'able-ml', name: 'able-ml', version: 'v3.2', kind: 'internal',
    mape: 2.4, mae: 970, updated: '14:30 CET', recommended: true, wired: true,
    blurb: 'Gradient-boosted ensemble trained on 5y of ENTSO-E history with ECMWF weather features.',
  },
  {
    id: 'tso-d1', name: 'ENTSO-E TSO', version: 'D+1', kind: 'official',
    mape: 3.1, mae: 1240, updated: '14:00 CET', wired: true,
    blurb: 'Official day-ahead TSO forecast from the ENTSO-E Transparency Platform.',
  },
  {
    id: 'tso-d7', name: 'ENTSO-E TSO', version: 'D+7', kind: 'official',
    mape: 5.9, mae: 2310, updated: '12:00 CET', wired: true,
    blurb: 'Week-ahead TSO forecast. Daily resolution with min/max band.',
  },
  {
    id: 'meteologica', name: 'Meteologica', version: 'D+1', kind: 'third-party',
    mape: 2.7, mae: 1080, updated: '13:45 CET', wired: false,
    blurb: 'Commercial weather-driven model. Strong on renewables. (Not yet integrated.)',
  },
  {
    id: 'persistence', name: 'Persistence', version: '7-day', kind: 'baseline',
    mape: 8.4, mae: 3360, updated: '14:30 CET', wired: false,
    blurb: 'Repeats the same hour from one week ago. Useful as a floor for benchmarking.',
  },
  {
    id: 'ensemble', name: 'Ensemble', version: 'avg', kind: 'ensemble',
    mape: 2.2, mae: 880, updated: '14:30 CET', wired: false,
    blurb: 'Weighted average of able-ml, Meteologica and the official TSO.',
  },
];

// Validated for colorblind separation (worst adjacent pair ΔE ≥ 22 deutan/protan).
// Ensemble is ochre, not a second green — a deuteranope couldn't split the old
// ensemble green from the baseline gray, or internal teal from ensemble.
export const MODEL_KIND_COLOR: Record<ForecastModel['kind'], string> = {
  internal: '#1F6B5C',
  'third-party': '#5B8BC4',
  official: '#6E4D7E',
  baseline: '#ABA79C',
  ensemble: '#8F6E1F',
};

export const MODEL_KIND_LABEL: Record<ForecastModel['kind'], string> = {
  internal: 'Internal',
  'third-party': 'Third-party',
  official: 'Official',
  baseline: 'Baseline',
  ensemble: 'Ensemble',
};

function currentModelId(layers: { ml: { enabled: boolean }; tso: { enabled: boolean; horizon?: string } }): ModelId {
  if (layers.ml.enabled) return 'able-ml';
  if (layers.tso.enabled) {
    return layers.tso.horizon === 'week_ahead' ? 'tso-d7' : 'tso-d1';
  }
  return 'able-ml';
}

export function ModelPicker() {
  const layers = useDashboardStore((s) => s.layers);
  const toggleLayer = useDashboardStore((s) => s.toggleLayer);
  const setTSOHorizon = useDashboardStore((s) => s.setTSOHorizon);
  const showActualsOnly = useDashboardStore((s) => s.showActualsOnly);

  const enabled = layers.ml.enabled || layers.tso.enabled;
  const activeId = currentModelId(layers);
  const active = FORECAST_MODELS.find((m) => m.id === activeId) ?? FORECAST_MODELS[0];

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const onToggle = () => {
    if (enabled) {
      showActualsOnly();
    } else {
      // Re-enable the previously active model
      if (activeId === 'tso-d1' || activeId === 'tso-d7') toggleLayer('tso');
      else toggleLayer('ml');
    }
  };

  const onPick = (id: ModelId) => {
    setOpen(false);
    const target = FORECAST_MODELS.find((m) => m.id === id);
    if (!target?.wired) return;
    // First, ensure the right layer is enabled
    if (id === 'able-ml') {
      if (!layers.ml.enabled) toggleLayer('ml');
      if (layers.tso.enabled) toggleLayer('tso');
    } else if (id === 'tso-d1' || id === 'tso-d7') {
      if (layers.ml.enabled) toggleLayer('ml');
      if (!layers.tso.enabled) toggleLayer('tso');
      setTSOHorizon(id === 'tso-d7' ? 'week_ahead' : 'day_ahead');
    }
  };

  return (
    <div ref={ref} className="relative inline-flex items-stretch">
      <button
        onClick={onToggle}
        className={cn(
          'flex cursor-pointer items-center gap-1.5 rounded-l-md border border-r-0 px-2.5 py-[5px] text-[12px] font-sans',
          enabled
            ? 'border-primary bg-accent text-primary'
            : 'border-border bg-transparent text-ink-dim',
        )}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            enabled ? 'bg-primary' : 'border-[1.5px] border-ink-muted',
          )}
        />
        Forecast
      </button>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-r-md border border-border bg-card px-2.5 py-[5px] text-[12px] text-foreground',
          !enabled && 'opacity-60',
        )}
      >
        <span className="font-medium">{active.name}</span>
        <span className="font-mono-num text-[10px] text-ink-muted">{active.version}</span>
        <span className="text-[10px] text-ink-muted">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-[110%] z-50 min-w-[380px] rounded-[10px] border border-border bg-card p-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.10)]">
          <div className="flex items-baseline justify-between px-2.5 pb-1.5 pt-2">
            <div className="font-mono-num text-[10px] uppercase tracking-[0.1em] text-ink-muted">
              Forecast model
            </div>
            <div className="font-mono-num text-[10px] text-ink-muted">30-day MAPE</div>
          </div>
          {FORECAST_MODELS.map((m) => {
            const selected = m.id === activeId;
            const disabled = !m.wired;
            return (
              <button
                key={m.id}
                onClick={() => onPick(m.id)}
                disabled={disabled}
                className={cn(
                  'mb-0.5 block w-full cursor-pointer rounded-md border-none p-2.5 text-left font-sans',
                  selected ? 'bg-accent' : 'bg-transparent hover:bg-secondary',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className="rounded-sm px-1.5 py-[1.5px] font-mono-num text-[9px] font-semibold uppercase tracking-[0.08em]"
                    style={{
                      background: `${MODEL_KIND_COLOR[m.kind]}22`,
                      color: MODEL_KIND_COLOR[m.kind],
                    }}
                  >
                    {MODEL_KIND_LABEL[m.kind]}
                  </span>
                  <span className="text-[13px] font-medium text-foreground">{m.name}</span>
                  <span className="font-mono-num text-[10.5px] text-ink-muted">{m.version}</span>
                  {m.recommended && (
                    <span className="rounded-sm bg-foreground px-1.5 py-[1.5px] font-mono-num text-[9px] font-semibold uppercase tracking-[0.08em] text-background">
                      Default
                    </span>
                  )}
                  {!m.wired && (
                    <span className="rounded-sm border border-border bg-secondary px-1.5 py-[1.5px] font-mono-num text-[9px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                      Coming soon
                    </span>
                  )}
                  <div className="flex-1" />
                  <span className="font-mono-num text-[12px] font-medium text-foreground">
                    {m.mape.toFixed(1)}
                    <span className="ml-px text-ink-muted">%</span>
                  </span>
                </div>
                <div className="text-[11.5px] leading-snug text-ink-dim">{m.blurb}</div>
                <div className="mt-1 font-mono-num text-[10px] text-ink-muted">
                  Last update {m.updated} · MAE {m.mae} MW
                </div>
              </button>
            );
          })}
          <div className="mt-1 border-t border-input px-2.5 py-2 font-mono-num text-[10.5px] text-ink-muted">
            Compare on the <span className="text-primary">Forecast accuracy</span> tab →
          </div>
        </div>
      )}
    </div>
  );
}
