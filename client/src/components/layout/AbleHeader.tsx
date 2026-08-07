import { useDashboardStore } from '@/store/dashboardStore';
import { useDataFreshness } from '@/hooks/useDashboardData';
import { describeFreshness, type FreshnessTone } from './freshnessPill';

// Single top bar used on every view — replaces the older MapHeader / CountryHeader pair.
// Mirrors the structure of the able prototype: triangle logo, "able energy" wordmark,
// view nav, live ENTSO-E pulse, API docs CTA.
// Every control here does something real — no decorative dead buttons.
//
// The nav holds *views* only. It used to also carry "Docs" and "API": "Docs"
// opened the same README as the "API docs →" button two elements to its right
// (one destination, two controls, styled as if they were different things),
// and "API" opened the raw /api/health JSON — a liveness probe, not a
// destination for an analyst. Both are gone; the button is the single door to
// the docs, and the real per-tab endpoint is still surfaced by ApiCta at the
// foot of the country page, where it has context.

const REPO_URL = 'https://github.com/aguinier/energy-dashboard-frontend';

export function AbleHeader() {
  const { currentView, goToMap, goToComparison } = useDashboardStore();
  const { data: freshness } = useDataFreshness();

  const navItems: { key: 'map' | 'compare'; label: string; onClick: () => void }[] = [
    { key: 'map', label: 'Map', onClick: goToMap },
    { key: 'compare', label: 'Compare', onClick: goToComparison },
  ];

  const isActive = (k: string) =>
    k === 'map' ? currentView === 'map' || currentView === 'country' : currentView === 'comparison';

  // The pill states whether the data is current, rather than asserting that it
  // is. Which streams count, how the age is chosen and how staleness is worded
  // all live in `freshnessPill.ts`, next to the tests that pin them; the
  // thresholds behind `status` live server-side in `services/freshness.ts`,
  // next to the ingest schedule that sizes them (ABL-60).
  //
  // The visible text stays abbreviated so it survives down to a tablet width
  // instead of being hidden below `lg` — "how current is this" is the first
  // thing a trader checks, and it was the first thing the layout dropped. The
  // full sentence is read out for assistive tech and on hover.
  const pill = describeFreshness(freshness);

  return (
    <header className="flex items-center gap-4 border-b border-border bg-background px-4 py-3 md:gap-6 md:px-7">
      <button
        onClick={goToMap}
        className="flex items-center gap-2.5 bg-transparent border-none cursor-pointer p-0"
      >
        <Logo />
        <span className="text-title font-medium tracking-[-0.012em] text-foreground">
          able
        </span>
        <span className="ml-0.5 hidden rounded border border-border bg-card px-1.5 py-px text-micro text-ink-muted sm:inline">
          energy
        </span>
      </button>

      <nav className="flex gap-0.5">
        {navItems.map(({ key, label, onClick }) => {
          const active = isActive(key);
          return (
            <button
              key={key}
              onClick={onClick}
              aria-current={active ? 'page' : undefined}
              className={
                'h-7 cursor-pointer rounded-md border-none px-2.5 text-meta font-sans transition-colors ' +
                (active
                  ? 'bg-secondary font-medium text-foreground'
                  : 'bg-transparent font-normal text-ink-dim hover:text-foreground')
              }
            >
              {label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      <span
        className={
          'flex items-center gap-1.5 font-mono-num text-micro ' +
          (pill.tone === 'stale' ? 'text-dirty' : 'text-ink-muted')
        }
        title={pill.title}
      >
        <Pulse tone={pill.tone} />
        <span className="sr-only">{pill.title}</span>
        <span aria-hidden="true" className="hidden whitespace-nowrap sm:inline">
          {pill.label}
        </span>
      </span>

      <button
        onClick={() => window.open(`${REPO_URL}#readme`, '_blank')}
        className="h-7 cursor-pointer whitespace-nowrap rounded-md border-none bg-foreground px-3 text-meta font-medium text-background"
      >
        API docs →
      </button>
    </header>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 18 L12 4 L20 18 Z" fill="hsl(var(--primary))" />
      <path d="M9 14 L15 14" stroke="hsl(var(--background))" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The mark, and the only one on the page that claims the data is live.
 *
 * The animation *is* the claim, so a stale or absent series gets a still dot
 * rather than a differently-coloured pulse — a pulsing amber still reads as "a
 * running pipeline, in a mood".
 *
 * `dirty` (terracotta) rather than `medium` (amber) for stale, on contrast:
 * measured against the light tokens, `medium` is 2.55:1 on `--background`,
 * failing both the 4.5:1 text bar and the 3:1 non-text bar, while `dirty` is
 * 6.97:1 on background and 5.26:1 in dark mode. It is also already the far end
 * of this repo's teal → amber → terracotta data scale, and deliberately not
 * red-on-green, the one pair a colour blind viewer cannot separate.
 */
function Pulse({ tone }: { tone: FreshnessTone }) {
  if (tone === 'live') {
    return (
      <span className="relative inline-flex w-2 h-2" aria-hidden="true">
        <span
          className="absolute inset-0 rounded-full bg-clean"
          style={{ animation: 'pulseDot 2.4s ease-in-out infinite' }}
        />
        <span className="absolute inset-0.5 rounded-full bg-clean" />
      </span>
    );
  }

  return (
    <span className="relative inline-flex w-2 h-2" aria-hidden="true">
      <span
        className={
          'absolute inset-0 rounded-full ' + (tone === 'stale' ? 'bg-dirty' : 'bg-ink-faint')
        }
      />
    </span>
  );
}
