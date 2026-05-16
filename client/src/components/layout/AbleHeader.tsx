import { useDashboardStore } from '@/store/dashboardStore';
import { useDataFreshness } from '@/hooks/useDashboardData';
import { formatDistanceToNowStrict } from 'date-fns';

// Single top bar used on every view — replaces the older MapHeader / CountryHeader pair.
// Mirrors the structure of the able prototype: triangle logo, "able energy" wordmark,
// Map / Docs / API / Pricing nav, live ENTSO-E pulse, Sign in / Get API key.

export function AbleHeader() {
  const { currentView, goToMap } = useDashboardStore();
  const { data: freshness } = useDataFreshness();

  const navItems: { key: 'map' | 'docs' | 'api' | 'pricing'; label: string }[] = [
    { key: 'map', label: 'Map' },
    { key: 'docs', label: 'Docs' },
    { key: 'api', label: 'API' },
    { key: 'pricing', label: 'Pricing' },
  ];

  // The "Map" tab is considered active for both map and country views.
  const isActive = (k: string) =>
    k === 'map' ? currentView === 'map' || currentView === 'country' : false;

  // Pick the freshest stamp we know of for the pulse indicator.
  const latestStamp = freshness
    ? [
        freshness.load,
        freshness.price,
        freshness.generation,
        freshness.tsoLoadForecast,
        freshness.tsoGenerationForecast,
      ]
        .filter((x): x is string => !!x)
        .sort()
        .at(-1)
    : null;
  const liveLabel = latestStamp
    ? `Live · ENTSO-E sync ${formatDistanceToNowStrict(new Date(latestStamp))} ago`
    : 'Live · ENTSO-E';

  return (
    <header className="flex items-center gap-7 border-b border-border bg-background px-7 py-3.5">
      <button
        onClick={goToMap}
        className="flex items-center gap-2.5 bg-transparent border-none cursor-pointer p-0"
      >
        <Logo />
        <span className="text-[15px] font-medium tracking-[-0.012em] text-foreground">
          able
        </span>
        <span className="ml-0.5 rounded text-[11px] text-ink-muted px-1.5 py-px border border-border bg-card">
          energy
        </span>
      </button>

      <nav className="flex gap-1">
        {navItems.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => key === 'map' && goToMap()}
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
          <span>{liveLabel}</span>
        </span>
      </div>

      <button className="rounded-md border border-border bg-transparent text-foreground px-3 py-1.5 text-[13px] cursor-pointer">
        Sign in
      </button>
      <button className="rounded-md border-none bg-foreground text-background px-3.5 py-[7px] text-[13px] font-medium cursor-pointer">
        Get API key →
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
