import { useDashboardStore } from '@/store/dashboardStore';
import { useCountries } from '@/hooks/useCountries';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export function CountryHeader() {
  const { selectedCountry, goToMap } = useDashboardStore();
  const { data: countries } = useCountries();
  const queryClient = useQueryClient();

  const countryName = countries?.find(c => c.country_code === selectedCountry)?.country_name || selectedCountry;

  const handleRefresh = () => {
    queryClient.invalidateQueries();
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        {/* Left: Back button */}
        <Button
          variant="ghost"
          onClick={goToMap}
          className="flex items-center gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back to Map</span>
        </Button>

        {/* Center: Country name */}
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold">{countryName}</span>
          <span className="rounded-md bg-primary/10 px-2 py-1 text-sm font-mono font-semibold text-primary">
            {selectedCountry}
          </span>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            title="Refresh data"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
