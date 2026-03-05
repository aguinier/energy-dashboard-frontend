import { Zap, TrendingUp, Leaf, Activity } from 'lucide-react';
import { StatCard } from './StatCard';
import { useDashboardOverview } from '@/hooks/useDashboardData';
import { useCountries } from '@/hooks/useCountries';
import { useDashboardStore } from '@/store/dashboardStore';

export function DashboardGrid() {
  const { selectedCountry } = useDashboardStore();
  const { data: overview, isLoading } = useDashboardOverview();
  const { data: countries } = useCountries();

  const countryName = countries?.find(
    (c) => c.country_code === selectedCountry
  )?.country_name;

  return (
    <div className="space-y-4">
      {/* Country Title */}
      <div className="flex items-center gap-2">
        <h2 className="text-2xl font-bold">{countryName || selectedCountry}</h2>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {selectedCountry}
        </span>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Current Load"
          value={overview?.currentLoad}
          unit="MW"
          icon={<Zap className="h-5 w-5" />}
          isLoading={isLoading}
          delay={0}
          colorClass="bg-blue-500/10 text-blue-500"
        />

        <StatCard
          title="Average Price"
          value={overview?.avgPrice}
          unit="EUR/MWh"
          icon={<TrendingUp className="h-5 w-5" />}
          isLoading={isLoading}
          decimals={2}
          delay={100}
          trend={
            overview?.priceChange24h !== undefined
              ? {
                  value: overview.priceChange24h,
                  isPositive: overview.priceChange24h > 0,
                }
              : undefined
          }
          colorClass="bg-amber-500/10 text-amber-500"
        />

        <StatCard
          title="Renewable %"
          value={overview?.renewablePercentage}
          unit="%"
          icon={<Leaf className="h-5 w-5" />}
          isLoading={isLoading}
          decimals={1}
          delay={200}
          colorClass="bg-green-500/10 text-green-500"
        />

        <StatCard
          title="Peak Demand"
          value={overview?.peakDemand}
          unit="MW"
          icon={<Activity className="h-5 w-5" />}
          isLoading={isLoading}
          delay={300}
          colorClass="bg-purple-500/10 text-purple-500"
        />
      </div>
    </div>
  );
}
