import { useMemo } from 'react';
import { m } from 'framer-motion';
import { ChartWrapper } from './ChartWrapper';
import { usePriceHeatmap } from '@/hooks/useDashboardData';
import { formatPrice } from '@/lib/formatters';
import { cn } from '@/lib/utils';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function getPriceColor(price: number, min: number, max: number): string {
  if (price < 0) return 'hsl(270, 70%, 50%)'; // Purple for negative

  const normalized = (price - min) / (max - min);

  if (normalized < 0.33) {
    // Green
    const intensity = Math.round(40 + normalized * 3 * 20);
    return `hsl(142, 76%, ${intensity}%)`;
  } else if (normalized < 0.66) {
    // Yellow/Amber
    const intensity = Math.round(40 + (normalized - 0.33) * 3 * 20);
    return `hsl(45, 93%, ${intensity}%)`;
  } else {
    // Red
    const intensity = Math.round(40 + (normalized - 0.66) * 3 * 20);
    return `hsl(0, 84%, ${intensity}%)`;
  }
}

export function PriceHeatmap() {
  const { data, isLoading } = usePriceHeatmap(30);

  const { min, max, grid } = useMemo(() => {
    if (!data || data.length === 0) {
      return { min: 0, max: 100, grid: [] as (number | null)[][] };
    }

    const prices = data.map((d) => d.price).filter((p) => p !== null);
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    // Create 7x24 grid
    const grid: (number | null)[][] = Array.from({ length: 7 }, () =>
      Array(24).fill(null)
    );

    data.forEach((d) => {
      if (d.day >= 0 && d.day < 7 && d.hour >= 0 && d.hour < 24) {
        grid[d.day][d.hour] = d.price;
      }
    });

    return { min, max, grid };
  }, [data]);

  return (
    <ChartWrapper
      title="Price Patterns"
      subtitle="Average hourly prices by day of week (last 30 days)"
      isLoading={isLoading}
      height={280}
    >
      <div className="flex h-full flex-col">
        {/* Hour labels */}
        <div className="flex">
          <div className="w-12" /> {/* Spacer for day labels */}
          <div className="flex flex-1 justify-between px-1">
            {[0, 6, 12, 18, 23].map((hour) => (
              <span
                key={hour}
                className="text-xs text-muted-foreground"
              >
                {hour.toString().padStart(2, '0')}:00
              </span>
            ))}
          </div>
        </div>

        {/* Heatmap grid */}
        <div className="flex-1 space-y-1 mt-2">
          {DAYS.map((day, dayIndex) => (
            <div key={day} className="flex items-center gap-1">
              <span className="w-12 text-xs text-muted-foreground text-right pr-2">
                {day}
              </span>
              <div className="flex flex-1 gap-0.5">
                {HOURS.map((hour) => {
                  const price = grid[dayIndex]?.[hour];
                  const hasData = price !== null;

                  return (
                    <m.div
                      key={`${dayIndex}-${hour}`}
                      className={cn(
                        'flex-1 aspect-square rounded-sm cursor-pointer transition-transform hover:scale-110 hover:z-10',
                        !hasData && 'bg-muted'
                      )}
                      style={{
                        backgroundColor: hasData
                          ? getPriceColor(price!, min, max)
                          : undefined,
                      }}
                      initial={{ opacity: 0, scale: 0 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{
                        delay: (dayIndex * 24 + hour) * 0.002,
                        duration: 0.2,
                      }}
                      title={
                        hasData
                          ? `${day} ${hour}:00 - ${formatPrice(price!)}`
                          : 'No data'
                      }
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 mt-4">
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5">
              <div
                className="h-3 w-6 rounded-sm"
                style={{ background: 'linear-gradient(to right, hsl(142, 76%, 40%), hsl(45, 93%, 50%), hsl(0, 84%, 50%))' }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              €{min.toFixed(0)} - €{max.toFixed(0)}/MWh
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: 'hsl(270, 70%, 50%)' }} />
            <span className="text-xs text-muted-foreground">Negative</span>
          </div>
        </div>
      </div>
    </ChartWrapper>
  );
}
