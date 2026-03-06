import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useDashboardStore } from '@/store/dashboardStore';
import { TIME_PRESETS } from '@/lib/constants';
import type { TimePreset } from '@/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TimeNavigatorProps {
  className?: string;
}

export function TimeNavigator({ className }: TimeNavigatorProps) {
  const {
    timePreset,
    isLive,
    setTimePreset,
    shiftTimeWindow,
    jumpToLive,
  } = useDashboardStore();

  const quickPresets = TIME_PRESETS.quickAccess;

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {/* Back Navigation */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => shiftTimeWindow('back')}
        title="Shift time window back"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      {/* Quick Presets */}
      <div className="flex items-center gap-1 rounded-md border bg-muted/50 p-1">
        {quickPresets.map((preset) => (
          <Button
            key={preset.value}
            variant={timePreset === preset.value ? 'secondary' : 'ghost'}
            size="sm"
            className={cn(
              'h-7 px-3 text-xs font-medium',
              timePreset === preset.value && 'bg-primary/15 text-primary shadow-sm'
            )}
            onClick={() => setTimePreset(preset.value as TimePreset)}
          >
            {preset.label}
          </Button>
        ))}

        {/* More Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs font-medium"
            >
              More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Historical
            </DropdownMenuLabel>
            {TIME_PRESETS.historical.map((preset) => (
              <DropdownMenuItem
                key={preset.value}
                onClick={() => setTimePreset(preset.value as TimePreset)}
                className={cn(
                  timePreset === preset.value && 'bg-accent'
                )}
              >
                {preset.label}
              </DropdownMenuItem>
            ))}

            <DropdownMenuSeparator />

            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Around Now
            </DropdownMenuLabel>
            {TIME_PRESETS.aroundNow.map((preset) => (
              <DropdownMenuItem
                key={preset.value}
                onClick={() => setTimePreset(preset.value as TimePreset)}
                className={cn(
                  timePreset === preset.value && 'bg-accent'
                )}
              >
                {preset.label}
              </DropdownMenuItem>
            ))}

            <DropdownMenuSeparator />

            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Forecast
            </DropdownMenuLabel>
            {TIME_PRESETS.forecast.map((preset) => (
              <DropdownMenuItem
                key={preset.value}
                onClick={() => setTimePreset(preset.value as TimePreset)}
                className={cn(
                  timePreset === preset.value && 'bg-accent'
                )}
              >
                {preset.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Forward Navigation */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => shiftTimeWindow('forward')}
        title="Shift time window forward"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {/* Live Indicator */}
      <Button
        variant={isLive ? 'default' : 'outline'}
        size="sm"
        className={cn(
          'ml-2 h-7 gap-1.5 px-2 text-xs',
          isLive && 'bg-red-500 hover:bg-red-600'
        )}
        onClick={jumpToLive}
      >
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            isLive ? 'bg-white animate-pulse' : 'bg-muted-foreground'
          )}
        />
        Live
      </Button>
    </div>
  );
}

export default TimeNavigator;
