import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { m } from 'framer-motion';
import { ChartWrapper } from './ChartWrapper';
import { useRenewableMix } from '@/hooks/useDashboardData';
import { formatMW, formatPercentage } from '@/lib/formatters';
import { ENERGY_COLORS } from '@/lib/colors';

const SOURCES = [
  { key: 'solar', label: 'Solar', color: ENERGY_COLORS.solar },
  { key: 'wind_onshore', label: 'Wind Onshore', color: ENERGY_COLORS.wind_onshore },
  { key: 'wind_offshore', label: 'Wind Offshore', color: ENERGY_COLORS.wind_offshore },
  { key: 'hydro', label: 'Hydro', color: ENERGY_COLORS.hydro },
  { key: 'biomass', label: 'Biomass', color: ENERGY_COLORS.biomass },
  { key: 'geothermal', label: 'Geothermal', color: ENERGY_COLORS.geothermal },
];

export function RenewablePieChart() {
  const { data, isLoading } = useRenewableMix();

  const pieData = SOURCES.map((source) => ({
    name: source.label,
    value: data?.[source.key as keyof typeof data] as number || 0,
    color: source.color,
  })).filter((d) => d.value > 0);

  const total = pieData.reduce((sum, d) => sum + d.value, 0);
  const renewablePercentage = data?.renewable_percentage;

  return (
    <ChartWrapper
      title="Renewable Breakdown"
      subtitle="Current energy mix by source"
      isLoading={isLoading}
      height={350}
    >
      <div className="relative h-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              innerRadius={80}
              outerRadius={120}
              paddingAngle={2}
              dataKey="value"
              animationDuration={1500}
              animationBegin={0}
            >
              {pieData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.color}
                  stroke="hsl(var(--background))"
                  strokeWidth={2}
                />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const data = payload[0].payload;
                const percentage = ((data.value / total) * 100).toFixed(1);
                return (
                  <div className="rounded-lg border bg-background p-3 shadow-lg">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: data.color }}
                      />
                      <span className="font-medium">{data.name}</span>
                    </div>
                    <p className="mt-1 text-lg font-bold">{formatMW(data.value)}</p>
                    <p className="text-sm text-muted-foreground">
                      {percentage}% of total
                    </p>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* Center label */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <m.div
            className="text-center"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.5 }}
          >
            <p className="text-3xl font-bold">
              {renewablePercentage !== null && renewablePercentage !== undefined
                ? formatPercentage(renewablePercentage)
                : '-'}
            </p>
            <p className="text-sm text-muted-foreground">Renewable</p>
          </m.div>
        </div>

        {/* Legend */}
        <div className="absolute bottom-0 left-0 right-0">
          <div className="flex flex-wrap justify-center gap-3">
            {pieData.map((entry) => (
              <div key={entry.name} className="flex items-center gap-1.5 text-xs">
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                <span className="text-muted-foreground">{entry.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ChartWrapper>
  );
}
