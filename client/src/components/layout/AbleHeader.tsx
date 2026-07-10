import { useDashboardStore } from '@/store/dashboardStore';
import { useDataFreshness } from '@/hooks/useDashboardData';
import { formatDistanceToNowStrict } from 'date-fns';

// Single top bar used on every view — replaces the older MapHeader / CountryHeader pair.
// Mirrors the structure of the able prototype: triangle logo, "able energy" wordmark,
// Map / Docs / API nav, live ENTSO-E pulse, API docs CTA.
// Every control here does something real — no decorative dead buttons.

const REPO_URL = 'https://github.com/aguinier/energy-dashboard-frontend';

export function AbleHeader() {
  const { currentView, goToMap } = useDashboardStore();
  const { data: freshness } = useDataFreshness();

  const navItems: { key: 'map' | 'docs' | 'api'; label: string; onClick: () => void }[] = [
    { key: 'map', label: 'Map', onClick: goToMap },
    { key: 'docs', label: 'Docs', onClick: () => window.open(`${REPO_URL}#readme`, '_blank') },
    { key: 'api', label: 'API', onClick: () => window.open('/api/health', '_blank') },
  ];

  // The "Map" tab is considered active for both map and country views.
  const isActive = (k: string) =>
    k === 'map' ? currentView === 'map' || currentView === 'country' : false;

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
  const liveLabel = latestMeasured
    ? `Live · ENTSO-E sync ${formatDistanceToNowStrict(new Date(latestMeasured))} ago`
    : 'Live · ENTSO-E';

  return (
    <header className="flex items-center gap-4 border-b border-border bg-background px-4 py-3.5 md:gap-7 md:px-7">
      <button
        onClick={goToMap}
        className="flex items-center gap-2.5 bg-transparent border-none cursor-pointer p-0"
      >
        <Logo />
        <span className="text-[15px] font-medium tracking-[-0.012em] text-foreground">
          able
        </span>
        <span className="ml-0.5 hidden rounded text-[11px] text-ink-muted px-1.5 py-px border border-border bg-card sm:inline">
          energy
        </span>
      </button>

      <nav className="flex gap-1">
        {navItems.map(({ key, label, onClick }) => (
          <button
            key={key}
            onClick={onClick}
            className={
              'rounded-md px-2.5 py-1.5 text-[13px] font-sans bg-transparent border-none cursor-pointer ' +
              (isActive(key) ? 'text-foreground font-medium' : 'text-ink-dim font-normal')
            }
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      <div className="font-mono-num text-[11.5px] text-ink-muted flex items-center gap-3.5">
        <span className="flex items-center gap-1.5">
          <Pulse />
          <span className="hidden lg:inline">{liveLabel}</span>
        </span>
      </div>

      <button
        onClick={() => window.open(`${REPO_URL}#readme`, '_blank')}
        className="rounded-md border-none bg-foreground text-background px-3.5 py-[7px] text-[13px] font-medium cursor-pointer whitespace-nowrap"
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
