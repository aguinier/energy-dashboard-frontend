import { PANEL_TABS, type PanelTab } from '../logic/livingGridState';
import { basisLabel, ZONE_BY_CODE, zoneAvailability } from '../logic/zoneRegistry';
import { dayRelation } from '../logic/dayRange';
import { basisNote, resolveNetSeries } from '../logic/netFromFlows';
import { dayLabel, euro, gw, seriesRange, signedGw } from '../logic/format';
import { TOKENS } from '../logic/ramps';
import type { GridDay } from '@/types';

interface ZonePanelProps {
  day: GridDay;
  code: string | null;
  hour: number;
  ptab: PanelTab;
  onPanelTab: (tab: PanelTab) => void;
  onClose: () => void;
  children?: React.ReactNode;
}

function BasisPill({ basis, label }: { basis: string; label: string }) {
  const colour =
    basis === 'full' ? TOKENS.teal : basis === 'partial' ? TOKENS.orange : TOKENS.textMuted;
  return (
    <span className="lg-pill" style={{ color: colour }}>
      {label}
    </span>
  );
}

export function ZonePanel({ day, code, hour, ptab, onPanelTab, onClose, children }: ZonePanelProps) {
  const relation = dayRelation(day.meta.date, day.meta.today);

  if (!code) {
    // A day with no zones has nothing to pick, so the usual invitation would
    // point at an affordance that is not there — the reader clicks an inert
    // map and concludes the view is broken. Say which day is empty instead,
    // and name the two ways out.
    const nothingToPick = day.meta.zoneCount === 0;
    return (
      <aside className="lg-panel">
        <div className="lg-empty">
          <div style={{ font: "400 15px 'IBM Plex Sans'", color: TOKENS.textSecondary }}>
            {nothingToPick ? 'Nothing published' : 'No zone selected'}
          </div>
          <div className="lg-note">
            {nothingToPick
              ? `Nothing is published for ${dayLabel(day.meta.date)}${
                  relation === 'future' ? ' yet' : ''
                }, so there is no country to open. Step back to a day with data, or press Live.`
              : 'Pick a country on the map to read its net position, generation mix, day-ahead price and cross-border flows for the selected hour.'}
          </div>
        </div>
      </aside>
    );
  }

  const info = ZONE_BY_CODE[code];
  const zone = day.zones[code];
  const availability = zoneAvailability(code, zone, day.meta.sharedZones);
  const { series: netSeries, basis: netBasis } = resolveNetSeries(day, code);

  const net = netSeries[hour];
  const load = zone?.load[hour] ?? null;
  const price = zone?.price[hour] ?? null;
  const priceRange = zone ? seriesRange(zone.price) : null;
  const exporting = net !== null && net !== undefined && net >= 0;

  return (
    <aside className="lg-panel">
      <div className="lg-zone-header">
        <span className="lg-flag" style={{ background: info?.flag ?? TOKENS.border }} aria-hidden />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="lg-zone-name">{info?.name ?? code}</div>
          <div className="lg-zone-sub">
            Bidding zone
            {availability.sharedWith ? ` · ${availability.sharedWith}` : ''}
          </div>
        </div>
        <BasisPill basis={availability.basis} label={basisLabel(availability)} />
        <button type="button" className="lg-close" onClick={onClose} aria-label="Clear selection">
          ×
        </button>
      </div>

      <div className="lg-panel-tabs" role="tablist" aria-label="Zone detail">
        {PANEL_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === ptab}
            className="lg-panel-tab"
            onClick={() => onPanelTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="lg-kpis">
        <div className="lg-kpi">
          <div className="lg-kpi-label">Net position</div>
          <div
            className="lg-kpi-value"
            style={{ color: net === null ? TOKENS.textMuted : exporting ? TOKENS.teal : TOKENS.orange }}
          >
            {net === null ? '—' : `${signedGw(net)} GW`}
          </div>
          <div className="lg-kpi-note">
            {net === null ? 'Not published' : exporting ? 'Exporting' : 'Importing'}
          </div>
        </div>
        <div className="lg-kpi">
          <div className="lg-kpi-label">Load</div>
          <div className="lg-kpi-value">{load === null ? '—' : `${gw(load)} GW`}</div>
          <div className="lg-kpi-note">{load === null ? 'Not published' : 'Actual demand'}</div>
        </div>
        <div className="lg-kpi">
          <div className="lg-kpi-label">Day-ahead</div>
          <div className="lg-kpi-value">{euro(price)}</div>
          <div className="lg-kpi-note">
            {priceRange ? `${euro(priceRange.min)} – ${euro(priceRange.max)} day range` : 'Not published'}
          </div>
        </div>
      </div>

      {netBasis !== 'scheduled' && (
        <div className="lg-section" style={{ paddingTop: 14, paddingBottom: 14 }}>
          <div className="lg-note">{basisNote(netBasis, relation)}</div>
        </div>
      )}

      {children}
    </aside>
  );
}
