import { VIEW_TABS, type ViewTab } from '../logic/livingGridState';
import { dayLabel, hourLabel } from '../logic/format';

interface GridHeaderProps {
  tab: ViewTab;
  onTab: (tab: ViewTab) => void;
  query: string;
  onQuery: (query: string) => void;
  date: string;
  hour: number;
}

export function GridHeader({ tab, onTab, query, onQuery, date, hour }: GridHeaderProps) {
  return (
    <header className="lg-header">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div className="lg-wordmark">LIVING GRID</div>
        <div className="lg-wordmark-sub">EUROPE&rsquo;S ELECTRICITY IN MOTION</div>
      </div>

      <nav className="lg-nav" role="tablist" aria-label="Map view">
        {VIEW_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className="lg-nav-tab"
            onClick={() => onTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 22 }}>
        <div className="lg-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5D7688" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M16.5 16.5L21 21" />
          </svg>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search a country, zone…"
            aria-label="Search for a zone"
          />
        </div>
        <div className="lg-clock">
          <div>{dayLabel(date)}</div>
          <strong>{hourLabel(hour)}</strong>
        </div>
      </div>
    </header>
  );
}
