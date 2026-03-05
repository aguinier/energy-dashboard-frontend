import { BarChart3, Map, Zap, TrendingUp, Leaf, X, BarChart2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { cn } from '@/lib/utils';

const navigation = [
  { id: 'overview', name: 'Overview', icon: BarChart3 },
  { id: 'load', name: 'Electricity Load', icon: Zap },
  { id: 'prices', name: 'Energy Prices', icon: TrendingUp },
  { id: 'renewables', name: 'Renewables', icon: Leaf },
  { id: 'analytics', name: 'Forecast Analytics', icon: BarChart2 },
  { id: 'map', name: 'Europe Map', icon: Map },
];

export function Sidebar() {
  const {
    sidebarOpen,
    setSidebarOpen,
    activeChartTab,
    setActiveChartTab,
    selectedCountry,
    setSelectedCountry,
  } = useDashboardStore();

  const { data: countries } = useCountries();

  // Sort countries alphabetically by name
  const sortedCountries = countries?.slice().sort((a, b) =>
    a.country_name.localeCompare(b.country_name)
  );

  return (
    <>
      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 border-r bg-card transition-transform duration-300 lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-full flex-col">
          {/* Mobile close button */}
          <div className="flex h-16 items-center justify-between border-b px-4 lg:hidden">
            <span className="font-semibold">Navigation</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Navigation */}
          <nav className="space-y-1 p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Dashboard
            </p>
            {navigation.map((item) => {
              const Icon = item.icon;
              const isActive = activeChartTab === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveChartTab(item.id);
                    setSidebarOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.name}
                </button>
              );
            })}
          </nav>

          <Separator />

          {/* Countries List */}
          <div className="flex flex-1 min-h-0 flex-col p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Countries
            </p>
            <div className="flex-1 overflow-y-auto space-y-0.5">
              {sortedCountries?.map((country) => (
                <button
                  key={country.country_code}
                  onClick={() => {
                    setSelectedCountry(country.country_code);
                    setSidebarOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                    selectedCountry === country.country_code
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <span className="w-7 font-mono text-xs opacity-70">
                    {country.country_code}
                  </span>
                  <span className="truncate">{country.country_name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t p-4">
            <p className="text-xs text-muted-foreground">
              Data: 2019 - 2025
            </p>
            <p className="text-xs text-muted-foreground">
              39 European Countries
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
