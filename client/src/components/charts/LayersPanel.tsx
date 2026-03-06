import { Layers, Eye, EyeOff, BarChart3, Brain, Radio } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useDashboardStore } from '@/store/dashboardStore';
import type { AvailableLayers } from '@/types';
import { cn } from '@/lib/utils';

interface LayersPanelProps {
  /** Configuration of which layers are available for this chart */
  availableLayers: AvailableLayers;
  /** Optional class name */
  className?: string;
}

/**
 * Unified Data Layers panel for controlling forecast visibility
 * Replaces scattered TSO/ML toggle buttons with a single panel
 */
export function LayersPanel({ availableLayers, className }: LayersPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const {
    layers,
    toggleLayer,
    setLayerAccuracy,
    setTSOHorizon,
    showActualsOnly,
    showAllLayers,
    selectedMLHorizons,
    toggleMLHorizon,
  } = useDashboardStore();

  // Count active layers for badge
  const activeCount = [
    layers.tso.enabled && availableLayers.tso?.available,
    layers.ml.enabled && availableLayers.ml?.available,
  ].filter(Boolean).length;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'gap-1.5',
            activeCount > 0 && 'border-emerald-500/50 bg-emerald-500/10',
            className
          )}
        >
          <Layers className="h-4 w-4" />
          <span>Layers</span>
          {activeCount > 0 && (
            <span className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-medium text-white">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <h4 className="font-medium text-sm">Data Layers</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure visible data sources
          </p>
        </div>

        <div className="p-2 space-y-1">
          {/* Actual Data Layer (always shown) */}
          <LayerItem
            icon={<Radio className="h-4 w-4 text-blue-500" />}
            label="Actual Data"
            description="Live measured values"
            enabled={layers.showActuals}
            color="blue"
            lineStyle="solid"
          />

          {/* TSO Forecast Layer */}
          {availableLayers.tso?.available && (
            <LayerItem
              icon={<BarChart3 className="h-4 w-4 text-emerald-500" />}
              label="Grid Operator Forecast"
              description="Official ENTSO-E forecast"
              enabled={layers.tso.enabled}
              onToggle={() => toggleLayer('tso')}
              color="emerald"
              lineStyle="dashed"
              expanded={layers.tso.enabled}
            >
              {/* Horizon selector */}
              {availableLayers.tso.horizons.length > 1 && (
                <div className="mt-2 ml-6">
                  <span className="text-xs text-muted-foreground">Horizon</span>
                  <div className="flex gap-1 mt-1">
                    {availableLayers.tso.horizons.map((horizon) => (
                      <button
                        key={horizon}
                        onClick={() => setTSOHorizon(horizon)}
                        className={cn(
                          'px-2 py-1 text-xs rounded-md transition-colors',
                          layers.tso.horizon === horizon
                            ? 'bg-emerald-500 text-white'
                            : 'bg-muted hover:bg-muted/80'
                        )}
                      >
                        {horizon === 'day_ahead' ? 'Day-Ahead (D+1)' : 'Week Ahead'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Accuracy toggle */}
              {availableLayers.tso.hasAccuracy && (
                <label className="flex items-center gap-2 mt-2 ml-6 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={layers.tso.showAccuracy}
                    onChange={(e) => setLayerAccuracy('tso', e.target.checked)}
                    className="rounded border-gray-300 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span className="text-xs">Compare to actuals</span>
                </label>
              )}
            </LayerItem>
          )}

          {/* ML Forecast Layer */}
          {availableLayers.ml?.available && (
            <LayerItem
              icon={<Brain className="h-4 w-4 text-orange-500" />}
              label="AI Prediction"
              description="Machine learning forecast"
              enabled={layers.ml.enabled}
              onToggle={() => toggleLayer('ml')}
              color="orange"
              lineStyle="dashed"
              expanded={layers.ml.enabled}
            >
              {/* ML Horizon selector (multi-select) */}
              {availableLayers.ml.horizons && availableLayers.ml.horizons.length > 0 && (
                <div className="mt-2 ml-6">
                  <span className="text-xs text-muted-foreground">Horizons (multi-select)</span>
                  <div className="flex gap-1 mt-1">
                    {availableLayers.ml.horizons.map((horizon) => (
                      <button
                        key={horizon}
                        onClick={() => toggleMLHorizon(horizon)}
                        className={cn(
                          'px-2 py-1 text-xs rounded-md transition-colors',
                          selectedMLHorizons.includes(horizon)
                            ? horizon === 1
                              ? 'bg-orange-500 text-white'
                              : 'bg-purple-500 text-white'
                            : 'bg-muted hover:bg-muted/80'
                        )}
                      >
                        D+{horizon}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Accuracy toggle */}
              {availableLayers.ml.hasAccuracy && (
                <label className="flex items-center gap-2 mt-2 ml-6 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={layers.ml.showAccuracy}
                    onChange={(e) => setLayerAccuracy('ml', e.target.checked)}
                    className="rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                  />
                  <span className="text-xs">Compare to actuals</span>
                </label>
              )}
            </LayerItem>
          )}
        </div>

        {/* Quick actions */}
        <div className="border-t px-3 py-2 flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-xs h-7"
            onClick={() => {
              showActualsOnly();
              setIsOpen(false);
            }}
          >
            Actuals Only
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-xs h-7"
            onClick={() => {
              showAllLayers();
              setIsOpen(false);
            }}
          >
            Show All
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface LayerItemProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  enabled: boolean;
  onToggle?: () => void;
  color: 'blue' | 'emerald' | 'sky' | 'purple' | 'orange';
  lineStyle: 'solid' | 'dashed' | 'dotted';
  expanded?: boolean;
  children?: React.ReactNode;
}

function LayerItem({
  icon,
  label,
  description,
  enabled,
  onToggle,
  color,
  lineStyle,
  expanded,
  children,
}: LayerItemProps) {
  const colorClasses = {
    blue: 'border-blue-500',
    emerald: 'border-emerald-500',
    sky: 'border-sky-500',
    purple: 'border-purple-500',
    orange: 'border-orange-500',
  };

  const lineStyleClass = {
    solid: '',
    dashed: 'border-dashed',
    dotted: 'border-dotted',
  };

  return (
    <div
      className={cn(
        'rounded-lg p-2 transition-colors',
        enabled ? 'bg-muted/50' : 'hover:bg-muted/30'
      )}
    >
      <div className="flex items-center gap-3">
        {/* Line style indicator */}
        <div
          className={cn(
            'w-6 h-0.5 border-t-2',
            colorClasses[color],
            lineStyleClass[lineStyle],
            !enabled && 'opacity-40'
          )}
        />

        {/* Icon */}
        <div className={cn(!enabled && 'opacity-40')}>{icon}</div>

        {/* Label and description */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground truncate">
            {description}
          </div>
        </div>

        {/* Toggle button */}
        {onToggle && (
          <button
            onClick={onToggle}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              enabled
                ? 'bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}
          >
            {enabled ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </button>
        )}
      </div>

      {/* Expandable children */}
      {expanded && children && <div className="mt-1">{children}</div>}
    </div>
  );
}

export default LayersPanel;
