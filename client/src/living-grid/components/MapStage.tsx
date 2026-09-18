import { WorldMapHost } from '../map/WorldMapHost';
import { EXPORT_RAMP, FUEL_COLORS, FUEL_LABELS, IMPORT_RAMP, PRICE_RAMP } from '../logic/ramps';
import { euro, signedGw } from '../logic/format';
import { GRID_FUEL_KEYS } from '@/types';
import type { MapAttrs } from '../logic/mapAttrs';
import type { ViewTab } from '../logic/livingGridState';

interface MapStageProps {
  attrs: MapAttrs;
  tab: ViewTab;
  /** Cheapest and dearest zone price at this hour, for the price legend's ends. */
  priceRange: { min: number; max: number } | null;
  /** Largest absolute net position at this hour, for the balance legend's ends. */
  netExtent: number | null;
  onPick: (code: string | null) => void;
  onFlows: (detail: { flows: Record<string, number>; net: Record<string, number> }) => void;
}

/** The two-tone net ramp, laid out importing-to-exporting for the legend. */
const NET_GRADIENT = `linear-gradient(90deg, ${[...IMPORT_RAMP].reverse().join(', ')}, ${EXPORT_RAMP.join(', ')})`;
const PRICE_GRADIENT = `linear-gradient(90deg, ${PRICE_RAMP.join(', ')})`;

function NetLegend({ extent }: { extent: number | null }) {
  // The scale is derived from the hour actually on screen, so the numbers
  // under the ramp describe this map rather than a fixed range the data may
  // never reach.
  const top = extent === null ? null : Math.max(1, Math.round(extent / 1000));
  return (
    <div className="lg-legend">
      <div className="lg-label" style={{ marginBottom: 9, fontSize: 9.5, letterSpacing: '0.18em' }}>
        Net position (GW)
      </div>
      <div className="lg-legend-bar" style={{ background: NET_GRADIENT }} />
      <div className="lg-legend-scale">
        <span>{top === null ? '—' : signedGw(-top * 1000, 0)}</span>
        <span>0</span>
        <span>{top === null ? '—' : signedGw(top * 1000, 0)}</span>
      </div>
    </div>
  );
}

function PriceLegend({ range }: { range: { min: number; max: number } | null }) {
  return (
    <div className="lg-legend">
      <div className="lg-label" style={{ marginBottom: 9, fontSize: 9.5, letterSpacing: '0.18em' }}>
        Day-ahead price (€/MWh)
      </div>
      <div className="lg-legend-bar" style={{ background: PRICE_GRADIENT }} />
      <div className="lg-legend-scale">
        <span>{range ? euro(range.min) : '—'}</span>
        <span>{range ? euro(range.max) : '—'}</span>
      </div>
    </div>
  );
}

function GenerationLegend() {
  return (
    <div className="lg-legend">
      <div className="lg-label" style={{ marginBottom: 10, fontSize: 9.5, letterSpacing: '0.18em' }}>
        Generation mix
      </div>
      <div className="lg-legend-fuels">
        {GRID_FUEL_KEYS.map((fuel) => (
          <div key={fuel} className="lg-legend-fuel">
            <span className="lg-legend-dot" style={{ background: FUEL_COLORS[fuel] }} />
            {FUEL_LABELS[fuel]}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MapStage({ attrs, tab, priceRange, netExtent, onPick, onFlows }: MapStageProps) {
  const byPrice = attrs.scalars !== '';
  return (
    <div className="lg-stage">
      <WorldMapHost attrs={attrs} onPick={onPick} onFlows={onFlows} />
      {tab === 'Generation' ? (
        <GenerationLegend />
      ) : byPrice ? (
        <PriceLegend range={priceRange} />
      ) : (
        <NetLegend extent={netExtent} />
      )}
    </div>
  );
}
