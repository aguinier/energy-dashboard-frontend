import { EuropeMap } from '@/components/map/EuropeMap';
import { MapMetricSelector } from '@/components/map/MapMetricSelector';
import { useDashboardStore } from '@/store/dashboardStore';

// Landing view — the choropleth is the hero. No sidebar.
// The metric selector floats at top-center; the legend and hover card live
// inside <EuropeMap />, anchored to bottom-left and top-right respectively.
export function MapView() {
  const { goToCountry } = useDashboardStore();

  return (
    <div className="relative flex-1 overflow-hidden bg-background h-[calc(100vh-58px)]">
      <EuropeMap fullScreen onCountryClick={goToCountry} />
      <MapMetricSelector floating />
    </div>
  );
}
