import { useIngestFreshness } from '@/hooks/useDashboardData';
import { REFRESH_PANEL_CAPTION, describeAllRefreshes } from './lastRefreshed';

/**
 * The "Last refreshed" disclosure behind the header's ENTSO-E pill (ABL-295).
 *
 * The pill states one fleet-level verdict for the country. This says, per
 * stream, when our ingest last stored new rows — and, separately, when it last
 * ran. Those two are different numbers often enough that showing only one would
 * be a confident wrong answer: measured 2026-08-12, every country was checked
 * during the 00:30 UTC pass, while GB and UA load and 14 of 36 zones' net
 * position have never had a pass return a row.
 *
 * All wording lives in `lastRefreshed.ts`, next to the tests that pin it.
 *
 * `open` is threaded in from the trigger so the query is only issued once
 * someone asks — see `useIngestFreshness`.
 */
export function LastRefreshedPanel({ open }: { open: boolean }) {
  const { data, isLoading, isError } = useIngestFreshness(open);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-meta font-medium text-foreground">Last refreshed</h2>
        <p className="mt-1 text-micro leading-snug text-ink-muted">{REFRESH_PANEL_CAPTION}</p>
      </div>

      {isLoading && <p className="text-micro text-ink-muted">Reading the ingest log…</p>}

      {isError && (
        <p className="text-micro text-ink-muted">
          The ingest log could not be read. No refresh time is shown rather than a guessed one.
        </p>
      )}

      {data && (
        <ul className="space-y-2.5">
          {describeAllRefreshes(data).map((row) => (
            <li key={row.label} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-micro font-medium text-foreground">{row.label}</span>
                <span
                  className={
                    'font-mono-num text-micro whitespace-nowrap ' +
                    (row.attention ? 'text-dirty' : 'text-ink-muted')
                  }
                >
                  {/*
                    The mark is a glyph, not a colour. `dirty` clears the
                    contrast bar where `medium` does not, but colour alone still
                    excludes a reader who cannot see it — the same rule the
                    pill's wording follows.
                  */}
                  {row.attention ? '⚠ ' : ''}
                  {row.refreshed}
                </span>
              </div>
              <p className="mt-0.5 text-micro leading-snug text-ink-dim">{row.checked}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
