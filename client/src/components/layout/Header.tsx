import { Zap, Menu, RefreshCw, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { TimeNavigator } from '@/components/dashboard/TimeNavigator';
import { TimeContextBar } from '@/components/dashboard/TimeContextBar';
import { CountrySelector } from '@/components/dashboard/CountrySelector';
import { ForecastMetadataBadge } from '@/components/dashboard/ForecastMetadataBadge';
import { useDashboardStore } from '@/store/dashboardStore';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cn, useMediaQuery } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function Header() {
  const { toggleSidebar, showForecast, toggleForecast } = useDashboardStore();
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries();
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center gap-4 px-4 sm:px-6">
        {/* Mobile menu button */}
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={toggleSidebar}
        >
          <Menu className="h-5 w-5" />
        </Button>

        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          <div className="hidden sm:block">
            <h1 className="text-lg font-semibold">Energy Dashboard</h1>
            <p className="text-xs text-muted-foreground">European Electricity Data</p>
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Controls */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* Time Navigator (desktop) - conditionally rendered */}
          {isDesktop && <TimeNavigator />}

          {/* Country Selector */}
          <CountrySelector />

          {/* Forecast Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showForecast ? 'default' : 'ghost'}
                size="icon"
                onClick={toggleForecast}
                className={cn(
                  'relative',
                  showForecast && 'bg-primary text-primary-foreground'
                )}
              >
                <TrendingUp className="h-4 w-4" />
                {showForecast && (
                  <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-green-500" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{showForecast ? 'Hide forecasts' : 'Show forecasts (D+2)'}</p>
            </TooltipContent>
          </Tooltip>

          {/* Forecast Metadata Badge */}
          {showForecast && (
            <div className="hidden xl:block">
              <ForecastMetadataBadge />
            </div>
          )}

          {/* Refresh Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={cn(
                'h-4 w-4 transition-transform',
                isRefreshing && 'animate-spin'
              )}
            />
          </Button>

          {/* Theme Toggle */}
          <ThemeToggle />
        </div>
      </div>

      {/* Mobile time navigator - conditionally rendered */}
      {!isDesktop && (
        <div className="border-t px-4 py-2">
          <TimeNavigator />
        </div>
      )}



      {/* Time Context Bar */}
      <TimeContextBar />
    </header>
  );
}
