import { EuropeMap } from '@/components/map/EuropeMap';
import { MapMetricSelector } from '@/components/map/MapMetricSelector';
import { CountryRankings } from '@/components/map/CountryRankings';
import { useDashboardStore } from '@/store/dashboardStore';

export function MapView() {
  const { goToCountry } = useDashboardStore();

  return (
    <div className="grid grid-cols-[300px_1fr] h-[calc(100vh-64px)] bg-background">
      {/* Left sidebar */}
      <aside className="border-r bg-card overflow-hidden flex flex-col">
        {/* Metric selector */}
        <MapMetricSelector vertical />

        {/* Country rankings */}
        <CountryRankings />
      </aside>

      {/* Map area - fills remaining space */}
      <main className="relative overflow-hidden">
        <EuropeMap
          fullScreen
          onCountryClick={goToCountry}
        />
      </main>
    </div>
  );
}
