import { useMemo } from 'react';
import {
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TrendingUp, Loader2 } from 'lucide-react';
import { useDashboardStore } from '@/store/dashboardStore';
import { useRollingAccuracy } from '@/hooks/useDashboardData';
import { cn } from '@/lib/utils';
import type { AnalyticsForecastType } from '@/types';

// Colors matching the MetricCard provider colors
const CHART_COLORS = {
  tso: '#10b981',       // emerald-500
  ml_d1: '#0ea5e9',     // sky-500
  ml_d2: '#0284c7',     // sky-600 (slightly darker for D+2)
};

interface AccuracyTrendChartProps {
  forecastType?: AnalyticsForecastType;
  className?: string;
}

/**
 * AccuracyTrendChart - Line chart showing rolling accuracy (MAPE) over time
 */
export function AccuracyTrendChart({
  forecastType,
  className,
}: AccuracyTrendChartProps) {
  const { analyticsConfig, setAnalyticsRollingWindow } = useDashboardStore();
  const type = forecastType ?? analyticsConfig.forecastType;
  const { selectedProviders, selectedHorizons, rollingWindow } = analyticsConfig;

  // Fetch rolling accuracy data
  const { data: rollingData, isLoading, error } = useRollingAccuracy(type);

  // Transform data for Recharts
  const chartData = useMemo(() => {
    if (!rollingData?.data) return [];

    return rollingData.data.map((point) => ({
      date: point.date,
      displayDate: formatChartDate(point.date),
      tso: point.tso?.mape,
      ml_d1: point.ml_d1?.mape,
      ml_d2: point.ml_d2?.mape,
    }));
  }, [rollingData]);

  // Determine which lines to show based on selections
  const showLines = useMemo(() => {
    const lines: { key: string; color: string; label: string; show: boolean }[] = [];

    // TSO line
    if (selectedProviders.includes('tso') && selectedHorizons.tso.includes('day_ahead')) {
      lines.push({
        key: 'tso',
        color: CHART_COLORS.tso,
        label: 'TSO (D+1)',
        show: true,
      });
    }

    // ML D+1 line
    if (selectedProviders.includes('ml') && selectedHorizons.ml.includes(1)) {
      lines.push({
        key: 'ml_d1',
        color: CHART_COLORS.ml_d1,
        label: 'ML (D+1)',
        show: true,
      });
    }

    // ML D+2 line
    if (selectedProviders.includes('ml') && selectedHorizons.ml.includes(2)) {
      lines.push({
        key: 'ml_d2',
        color: CHART_COLORS.ml_d2,
        label: 'ML (D+2)',
        show: true,
      });
    }

    return lines;
  }, [selectedProviders, selectedHorizons]);

  // No data state
  if (!isLoading && (!chartData || chartData.length === 0)) {
    return (
      <Card className={className}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Accuracy Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
            No trend data available for the selected time range
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Accuracy Trend
          </CardTitle>
          {/* Rolling window selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Rolling:</span>
            <div className="flex gap-1">
              <Button
                variant={rollingWindow === 7 ? 'default' : 'outline'}
                size="sm"
                onClick={() => setAnalyticsRollingWindow(7)}
                className={cn(
                  'text-xs px-2 h-7',
                  rollingWindow === 7 && 'bg-primary hover:bg-primary/90'
                )}
              >
                7d
              </Button>
              <Button
                variant={rollingWindow === 14 ? 'default' : 'outline'}
                size="sm"
                onClick={() => setAnalyticsRollingWindow(14)}
                className={cn(
                  'text-xs px-2 h-7',
                  rollingWindow === 14 && 'bg-primary hover:bg-primary/90'
                )}
              >
                14d
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-[200px] flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="h-[200px] flex items-center justify-center text-destructive text-sm">
            Failed to load trend data
          </div>
        ) : (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="displayDate"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}%`}
                  domain={['auto', 'auto']}
                  width={45}
                />
                <Tooltip
                  content={({ active, payload, label }) => (
                    <CustomTooltip active={active} payload={payload} label={label} />
                  )}
                />
                <Legend
                  verticalAlign="top"
                  height={30}
                  iconType="line"
                  wrapperStyle={{ fontSize: '11px' }}
                />
                {showLines.map((line) => (
                  <Line
                    key={line.key}
                    type="monotone"
                    dataKey={line.key}
                    name={line.label}
                    stroke={line.color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Custom tooltip component
 */
function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="bg-background border rounded-lg shadow-lg p-3 text-sm">
      <div className="font-medium mb-2">{label}</div>
      <div className="space-y-1">
        {payload.map((entry, index) => (
          <div key={entry.dataKey ?? index} className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color ?? '#888' }}
            />
            <span className="text-muted-foreground">{entry.name ?? 'Unknown'}:</span>
            <span className="font-medium tabular-nums">
              {entry.value !== undefined ? `${Number(entry.value).toFixed(2)}%` : 'N/A'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Format date for chart x-axis
 */
function formatChartDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Loading skeleton for AccuracyTrendChart
 */
export function AccuracyTrendChartSkeleton({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="h-5 w-32 bg-muted rounded animate-pulse" />
      </CardHeader>
      <CardContent>
        <div className="h-[200px] bg-muted/30 rounded animate-pulse" />
      </CardContent>
    </Card>
  );
}
