import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboardStore } from '@/store/dashboardStore';
import { useForecastComparisonMetrics, useAnalyticsDateRange } from '@/hooks/useDashboardData';
import { ForecastTypeSelector, FORECAST_TYPE_OPTIONS } from './ForecastTypeSelector';
import { ProviderHorizonSelector } from './ProviderHorizonSelector';
import { AnalyticsTimeSelector } from './AnalyticsTimeSelector';
import { MetricCard, MetricCardSkeleton } from './MetricCard';
import { ComparisonTable, ComparisonTableSkeleton } from './ComparisonTable';
import { AccuracyTrendChart, AccuracyTrendChartSkeleton } from './AccuracyTrendChart';
import { AlertCircle, BarChart2 } from 'lucide-react';
import type { AccuracyMetrics } from '@/types';

/**
 * ForecastAnalyticsPanel - Main container for forecast comparison analytics
 */
export function ForecastAnalyticsPanel() {
  const { analyticsConfig, selectedCountry } = useDashboardStore();
  const { forecastType, selectedProviders, selectedHorizons } = analyticsConfig;
  const { displayRange } = useAnalyticsDateRange();

  // Fetch comparison data
  const { data: comparisonData, isLoading, error } = useForecastComparisonMetrics(forecastType);

  // Get selected option info
  const selectedOption = FORECAST_TYPE_OPTIONS.find((o) => o.value === forecastType);

  // Build table data from comparison response
  const tableData = useMemo(() => {
    if (!comparisonData) return [];

    const rows: Array<{
      id: string;
      provider: 'tso' | 'ml';
      horizon: string;
      horizonLabel: string;
      metrics: AccuracyMetrics;
    }> = [];

    // Add TSO rows
    if (selectedProviders.includes('tso')) {
      if (selectedHorizons.tso.includes('day_ahead') && comparisonData.tso.dayAhead) {
        rows.push({
          id: 'tso-day_ahead',
          provider: 'tso',
          horizon: 'day_ahead',
          horizonLabel: 'Day-Ahead (D+1)',
          metrics: comparisonData.tso.dayAhead,
        });
      }
      if (selectedHorizons.tso.includes('week_ahead') && comparisonData.tso.weekAhead) {
        rows.push({
          id: 'tso-week_ahead',
          provider: 'tso',
          horizon: 'week_ahead',
          horizonLabel: 'Week-Ahead (D+7)',
          metrics: comparisonData.tso.weekAhead,
        });
      }
    }

    // Add ML rows
    if (selectedProviders.includes('ml')) {
      if (selectedHorizons.ml.includes(1) && comparisonData.ml.d1) {
        rows.push({
          id: 'ml-d1',
          provider: 'ml',
          horizon: 'd1',
          horizonLabel: 'D+1 (Day-Ahead)',
          metrics: comparisonData.ml.d1,
        });
      }
      if (selectedHorizons.ml.includes(2) && comparisonData.ml.d2) {
        rows.push({
          id: 'ml-d2',
          provider: 'ml',
          horizon: 'd2',
          horizonLabel: 'D+2 (Two Days Ahead)',
          metrics: comparisonData.ml.d2,
        });
      }
    }

    return rows;
  }, [comparisonData, selectedProviders, selectedHorizons]);

  // Find best MAPE across all selected options
  const bestMAPE = useMemo(() => {
    if (tableData.length === 0) return null;
    return tableData.reduce((best, row) =>
      row.metrics.mape < (best?.metrics.mape ?? Infinity) ? row : best
    );
  }, [tableData]);

  // Build metric cards data
  const metricCards = useMemo(() => {
    if (!comparisonData) return [];

    const cards: Array<{
      provider: 'tso' | 'ml';
      horizon: string;
      metrics: AccuracyMetrics;
      isBest: boolean;
    }> = [];

    // TSO cards
    if (selectedProviders.includes('tso')) {
      if (selectedHorizons.tso.includes('day_ahead') && comparisonData.tso.dayAhead) {
        cards.push({
          provider: 'tso',
          horizon: 'day_ahead',
          metrics: comparisonData.tso.dayAhead,
          isBest: bestMAPE?.id === 'tso-day_ahead',
        });
      }
      if (selectedHorizons.tso.includes('week_ahead') && comparisonData.tso.weekAhead) {
        cards.push({
          provider: 'tso',
          horizon: 'week_ahead',
          metrics: comparisonData.tso.weekAhead,
          isBest: bestMAPE?.id === 'tso-week_ahead',
        });
      }
    }

    // ML cards
    if (selectedProviders.includes('ml')) {
      if (selectedHorizons.ml.includes(1) && comparisonData.ml.d1) {
        cards.push({
          provider: 'ml',
          horizon: 'd1',
          metrics: comparisonData.ml.d1,
          isBest: bestMAPE?.id === 'ml-d1',
        });
      }
      if (selectedHorizons.ml.includes(2) && comparisonData.ml.d2) {
        cards.push({
          provider: 'ml',
          horizon: 'd2',
          metrics: comparisonData.ml.d2,
          isBest: bestMAPE?.id === 'ml-d2',
        });
      }
    }

    return cards;
  }, [comparisonData, selectedProviders, selectedHorizons, bestMAPE]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BarChart2 className="h-6 w-6 text-primary" />
              <div>
                <CardTitle>Forecast Analytics</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  Compare forecast performance across providers and horizons
                </p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium">{selectedCountry}</div>
              <div className="text-xs text-muted-foreground">{displayRange}</div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-6">
            <ForecastTypeSelector />
            <AnalyticsTimeSelector />
            <ProviderHorizonSelector showProviders showHorizons />
          </div>
        </CardContent>
      </Card>

      {/* Loading State */}
      {isLoading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <MetricCardSkeleton key={i} />
            ))}
          </div>
          <ComparisonTableSkeleton />
          <AccuracyTrendChartSkeleton />
        </>
      )}

      {/* Error State */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-8 text-center">
            <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
            <p className="text-destructive font-medium">Failed to load comparison data</p>
            <p className="text-sm text-muted-foreground mt-1">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Data Available */}
      {!isLoading && !error && comparisonData && (
        <>
          {/* Summary Metric Cards */}
          {metricCards.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {metricCards.map((card) => (
                <MetricCard
                  key={`${card.provider}-${card.horizon}`}
                  title="MAPE"
                  value={card.metrics.mape}
                  unit="%"
                  provider={card.provider}
                  horizon={card.horizon}
                  isBest={card.isBest}
                  description={`${card.metrics.dataPoints.toLocaleString()} samples`}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No forecast data available for {selectedOption?.label ?? forecastType} in {selectedCountry}.
                <br />
                <span className="text-xs">
                  Try selecting a different forecast type or check that forecasts have been generated.
                </span>
              </CardContent>
            </Card>
          )}

          {/* Detailed Comparison Table */}
          {tableData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Detailed Metrics Comparison</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ComparisonTable data={tableData} />
              </CardContent>
            </Card>
          )}

          {/* Accuracy Trend Chart */}
          <AccuracyTrendChart forecastType={forecastType} />

          {/* Data Availability Info */}
          {comparisonData && (
            <Card className="bg-muted/30">
              <CardContent className="py-4">
                <div className="flex flex-wrap gap-4 text-xs">
                  <div>
                    <span className="font-medium">TSO Data:</span>{' '}
                    <span className="text-muted-foreground">
                      {comparisonData.meta.dataAvailability.tso.dayAhead ? 'Day-Ahead' : ''}{' '}
                      {comparisonData.meta.dataAvailability.tso.weekAhead ? 'Week-Ahead' : ''}
                      {!comparisonData.meta.dataAvailability.tso.dayAhead &&
                        !comparisonData.meta.dataAvailability.tso.weekAhead && 'Not available'}
                    </span>
                  </div>
                  <div>
                    <span className="font-medium">ML Data:</span>{' '}
                    <span className="text-muted-foreground">
                      {comparisonData.meta.dataAvailability.ml.d1 ? 'D+1' : ''}{' '}
                      {comparisonData.meta.dataAvailability.ml.d2 ? 'D+2' : ''}
                      {!comparisonData.meta.dataAvailability.ml.d1 &&
                        !comparisonData.meta.dataAvailability.ml.d2 && 'Not available'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
