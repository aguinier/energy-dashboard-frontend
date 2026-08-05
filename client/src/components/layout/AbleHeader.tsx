import { useDashboardStore } from '@/store/dashboardStore';
import { useDataFreshness } from '@/hooks/useDashboardData';
import { formatDistanceToNowStrict } from 'date-fns';

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

  // Pulse recency comes from the MEASURED series only (load/generation).
  // Price and TSO-forecast stamps sit up to a day in the future by design
  // (day-ahead auction), so "max of all stamps" produced nonsense like
  // "sync 23 hours ago" while holding tomorrow's prices — and clamping
  // future stamps to now would mask a genuinely dead pipeline instead.
  const latestMeasured = freshness
    ? [freshness.load, freshness.generation]
        .filter((x): x is string => !!x)
        .sort()
        .at(-1)
    : null;
  const syncAge = latestMeasured ? formatDistanceToNowStrict(new Date(latestMeasured)) : null;
  // Read out in full for assistive tech and on hover; the visible text is
  // abbreviated so it can survive down to a tablet width instead of being
  // hidden below `lg` — "when was this last refreshed" is the first thing a
  // trader checks, and it was the first thing the layout dropped.
  const liveTitle = syncAge
    ? `Live data from ENTSO-E — last measured value synced ${syncAge} ago`
    : 'Live data from ENTSO-E';

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
        className="flex items-center gap-1.5 font-mono-num text-micro text-ink-muted"
        title={liveTitle}
      >
        <Pulse />
        <span className="sr-only">{liveTitle}</span>
        <span aria-hidden="true" className="hidden whitespace-nowrap sm:inline">
          {syncAge ? `ENTSO-E · ${syncAge} ago` : 'ENTSO-E'}
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

function Pulse() {
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
