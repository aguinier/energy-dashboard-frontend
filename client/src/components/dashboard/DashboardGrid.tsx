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
      <h2 className="text-2xl font-bold">{countryName || selectedCountry}</h2>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Current Load"
          value={overview?.currentLoad}
          unit="MW"
          icon={<Zap className="h-5 w-5" />}
          isLoading={isLoading}
          delay={0}
          colorClass="bg-blue-500/15 text-blue-600 dark:text-blue-400"
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
          colorClass="bg-amber-500/15 text-amber-600 dark:text-amber-400"
        />

        <StatCard
          title="Renewable %"
          value={overview?.renewablePercentage}
          unit="%"
          icon={<Leaf className="h-5 w-5" />}
          isLoading={isLoading}
          decimals={1}
          delay={200}
          colorClass="bg-green-500/15 text-green-600 dark:text-green-400"
        />

        <StatCard
          title="Peak Demand"
          value={overview?.peakDemand}
          unit="MW"
          icon={<Activity className="h-5 w-5" />}
          isLoading={isLoading}
          delay={300}
          colorClass="bg-purple-500/15 text-purple-600 dark:text-purple-400"
        />
      </div>
    </div>
  );
}
