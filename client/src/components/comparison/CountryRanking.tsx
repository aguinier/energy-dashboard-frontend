import { useDashboardStore } from '@/store/dashboardStore';
import { FORECAST_TYPE_CONFIG } from '@/lib/comparisonConstants';
import { wapeColor } from './accuracyScale';
import { basisNoticesFromRows, divergentBasisNote, NOT_COMPARABLE } from './basisNotice';
import { activatesCountryDetail, rankingState, responsePresentTypes } from './portfolioHome';
import { SkillCell } from './SkillCell';
import type { CrossCountryMetrics } from '@/types';

export function CountryRanking({ data }: { data: CrossCountryMetrics }) {
  const { comparisonForecastType, setComparisonForecastType, goToCountry } = useDashboardStore();
  const state = rankingState(data, comparisonForecastType);
  if (state.kind === 'choose') {
    const types = responsePresentTypes(data);
    return <section className="rounded-lg border bg-card p-5" aria-labelledby="ranking-heading"><h2 id="ranking-heading" className="m-0 text-base font-medium">Country ranking</h2><p className="mt-1 max-w-2xl text-sm text-ink-dim">No portfolio-wide ranking is shown: WAPE is comparable only within one forecast type. Choose a response-present type to rank countries.</p><div className="mt-4 flex flex-wrap gap-2">{types.map((type) => <button key={type} onClick={() => setComparisonForecastType(type)} className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium hover:bg-background">{FORECAST_TYPE_CONFIG[type]?.label ?? type}</button>)}</div></section>;
  }
  const max = state.scale.max;
  const notices = basisNoticesFromRows(state.rows);
  return <section className="rounded-lg border bg-card p-4" aria-labelledby="ranking-heading"><div className="flex flex-wrap items-baseline justify-between gap-2"><div><h2 id="ranking-heading" className="m-0 text-base font-medium">Country ranking</h2><p className="mt-1 text-sm text-ink-dim">{FORECAST_TYPE_CONFIG[comparisonForecastType]?.label ?? comparisonForecastType} WAPE, lowest first.</p></div>{!state.scale.usable && <p className="text-xs text-ink-dim">{state.scale.count === 0 ? 'WAPE is not measurable in this window.' : `Only ${state.scale.count} measurable values — neutral treatment, not a ranking.`}</p>}</div><div className="mt-4 space-y-2">{state.rows.map((row) => { const colour = wapeColor(row.wape, state.scale); const width = row.wape !== null && state.scale.usable && max > 0 ? Math.max(4, (row.wape / max) * 100) : 0; const activate = () => goToCountry(row.country, 'analytics');
    // Withheld because the two series are not on the same basis (ABL-493), not
    // because the window was empty. The value column is too narrow for the
    // distinction, so it carries the marker and the footnote below carries the
    // sentence — and the aria-label carries the whole thing, because a reader
    // who cannot see the footnote must not be left with a bare dash either.
    const note = divergentBasisNote(row);
    return <div key={row.country} role="button" tabIndex={0} aria-label={`Open ${row.country} forecast quality detail${note !== null ? `, WAPE not comparable: ${note}` : row.wape === null ? ', WAPE not measurable' : `, WAPE ${row.wape.toFixed(1)} percent`}`} onClick={activate} onKeyDown={(event) => { if (activatesCountryDetail(event)) { event.preventDefault(); activate(); } }} className="grid cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_4rem_4.5rem] items-center gap-2 rounded px-1 py-1 hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><span className="font-mono text-xs font-medium">{row.country}</span><span className="h-5 overflow-hidden rounded bg-muted" aria-hidden="true">{width > 0 && <span className="block h-full rounded" style={{ width: `${width}%`, backgroundColor: colour ?? 'hsl(var(--muted-foreground) / .35)' }} />}</span><span className="text-right font-mono-num text-xs" title={note ?? undefined}>{row.wape === null ? '—' : `${row.wape.toFixed(1)}%`}</span>{note !== null ? <span className="text-micro text-ink-dim" title={note}>{NOT_COMPARABLE}</span> : <SkillCell skill={row.skill} compact />}</div>; })}</div>{notices.length > 0 && <ul className="mt-3 m-0 list-none space-y-1 text-micro text-ink-dim">{notices.map((notice) => <li key={notice.country}><span className="font-mono font-medium">{notice.country}</span> — {notice.note}</li>)}</ul>}</section>;
}
