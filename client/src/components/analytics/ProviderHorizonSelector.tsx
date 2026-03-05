import { Button } from '@/components/ui/button';
import { useDashboardStore } from '@/store/dashboardStore';
import { cn } from '@/lib/utils';

interface ProviderHorizonSelectorProps {
  className?: string;
  showProviders?: boolean;
  showHorizons?: boolean;
}

/**
 * ProviderHorizonSelector - Toggle buttons for selecting providers and horizons
 */
export function ProviderHorizonSelector({
  className,
  showProviders = true,
  showHorizons = true,
}: ProviderHorizonSelectorProps) {
  const {
    analyticsConfig,
    toggleAnalyticsProvider,
    toggleAnalyticsTSOHorizon,
    toggleAnalyticsMLHorizon,
  } = useDashboardStore();

  const { selectedProviders, selectedHorizons } = analyticsConfig;

  return (
    <div className={cn('space-y-4', className)}>
      {/* Provider Selection */}
      {showProviders && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Providers
          </label>
          <div className="flex gap-2">
            <Button
              variant={selectedProviders.includes('tso') ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggleAnalyticsProvider('tso')}
              className={cn(
                'min-w-[80px]',
                selectedProviders.includes('tso') &&
                  'bg-emerald-600 hover:bg-emerald-700 text-white'
              )}
            >
              TSO
            </Button>
            <Button
              variant={selectedProviders.includes('ml') ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggleAnalyticsProvider('ml')}
              className={cn(
                'min-w-[80px]',
                selectedProviders.includes('ml') &&
                  'bg-sky-600 hover:bg-sky-700 text-white'
              )}
            >
              ML
            </Button>
          </div>
        </div>
      )}

      {/* Horizon Selection */}
      {showHorizons && (
        <div className="flex gap-6">
          {/* TSO Horizons */}
          {selectedProviders.includes('tso') && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                TSO Horizons
              </label>
              <div className="flex gap-1">
                <Button
                  variant={selectedHorizons.tso.includes('day_ahead') ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleAnalyticsTSOHorizon('day_ahead')}
                  className={cn(
                    'text-xs px-2',
                    selectedHorizons.tso.includes('day_ahead') &&
                      'bg-emerald-600 hover:bg-emerald-700 text-white'
                  )}
                >
                  D+1
                </Button>
                <Button
                  variant={selectedHorizons.tso.includes('week_ahead') ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleAnalyticsTSOHorizon('week_ahead')}
                  className={cn(
                    'text-xs px-2',
                    selectedHorizons.tso.includes('week_ahead') &&
                      'bg-emerald-600 hover:bg-emerald-700 text-white'
                  )}
                >
                  D+7
                </Button>
              </div>
            </div>
          )}

          {/* ML Horizons */}
          {selectedProviders.includes('ml') && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                ML Horizons
              </label>
              <div className="flex gap-1">
                <Button
                  variant={selectedHorizons.ml.includes(1) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleAnalyticsMLHorizon(1)}
                  className={cn(
                    'text-xs px-2',
                    selectedHorizons.ml.includes(1) &&
                      'bg-sky-600 hover:bg-sky-700 text-white'
                  )}
                >
                  D+1
                </Button>
                <Button
                  variant={selectedHorizons.ml.includes(2) ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleAnalyticsMLHorizon(2)}
                  className={cn(
                    'text-xs px-2',
                    selectedHorizons.ml.includes(2) &&
                      'bg-sky-600 hover:bg-sky-700 text-white'
                  )}
                >
                  D+2
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
