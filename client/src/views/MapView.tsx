import { EuropeMap } from '@/components/map/EuropeMap';
import { MapMetricSelector } from '@/components/map/MapMetricSelector';
import { useDashboardStore } from '@/store/dashboardStore';
import { NetPositionScopeToggle } from '@/components/dashboard/NetPositionScopeToggle';

// Landing view — the choropleth is the hero. No sidebar.
// The metric selector floats at top-center; the legend and hover card live
// inside <EuropeMap />, anchored to bottom-left and top-right respectively.
//
// Height comes from `flex-1` inside App's h-screen flex column, not from a
// `calc(100vh - 58px)`: 58px was a hardcoded guess at the header's height,
// so it was wrong the moment the header's padding changed and wrong at any
// width where the header wraps — leaving either a dead strip under the map
// or a scrollbar on a view that is supposed to fill the viewport exactly.
export function MapView() {
  const goToCountry = useDashboardStore((s) => s.goToCountry);
  const mapMetric = useDashboardStore((s) => s.mapMetric);

  return (
    <div className="relative flex-1 overflow-hidden bg-background">
      <EuropeMap fullScreen onCountryClick={goToCountry} />
      <MapMetricSelector floating />
      {/* Scope toggle, beneath the metric selector (ABL-231's placement) and
          only for the one metric that has two scopes. Rendering it beside the
          other three would imply a choice that does not apply to them. */}
      {mapMetric === 'net_position' && (
        <NetPositionScopeToggle
          floating
          className="absolute left-1/2 top-[3.6rem] z-[5] -translate-x-1/2"
        />
      )}
    </div>
  );
}
