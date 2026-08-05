import { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { useDashboardStore } from '@/store/dashboardStore';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getDateRangeForPreset } from '@/hooks/useDashboardData';
import { cn } from '@/lib/utils';
import { QUICK_ACCESS_PRESETS, PRESET_GROUPS } from './timePresets';
import { formatWindowRange } from './windowLabel';

// The categorised time picker (ABL-12, option A). Replaces `RangeSegment`, the
// five hardcoded buttons that were the only writer of `timePreset` in the
// client, and adds back the window navigation the store had actions for but no
// controls: `shiftTimeWindow` (the arrows) and `jumpToLive` (Now).
//
// Layout keeps the clarity pass's rule that everything on the control bar is
// h-8 and reads as one bar: [‹ Now ›] [7d | Today | Tomorrow | +7d | More].

// Shared segment styling so the two pills read as one control family.
const SEG = 'cursor-pointer border-none px-2.5 font-mono-num text-micro transition-colors disabled:cursor-not-allowed disabled:opacity-40';
const SEG_ON = 'bg-foreground text-background';
const SEG_OFF = 'bg-transparent text-ink-dim hover:bg-secondary hover:text-foreground';

export function TimePicker() {
  const timePreset = useDashboardStore((s) => s.timePreset);
  const timeOffset = useDashboardStore((s) => s.timeOffset);
  const isLive = useDashboardStore((s) => s.isLive);
  const setTimePreset = useDashboardStore((s) => s.setTimePreset);
  const shiftTimeWindow = useDashboardStore((s) => s.shiftTimeWindow);
  const jumpToLive = useDashboardStore((s) => s.jumpToLive);
  const [open, setOpen] = useState(false);

  const shifted = timeOffset !== 0;

  // The window this describes is the one the hooks fetch on: same pure
  // function, same two store fields. It re-reads `new Date()`, so a window
  // anchored to now can differ from the fetch's by the render gap — bounded by
  // a frame, and invisible at the minute precision shown. What it cannot do is
  // describe a *different window* the way a label keyed off a separate field
  // could (see windowLabel.ts).
  const { start, end } = getDateRangeForPreset(timePreset, timeOffset);

  const choose = (value: typeof timePreset) => {
    setTimePreset(value);
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-2">
      {/* Shifted windows say so, in words, next to the control that shifted
          them. Every preset label ("7d", "next 24h") is a claim about a window
          anchored to now and is false once the window moves; the explicit
          bounds are the only honest caption for a shifted window. */}
      {shifted && (
        <span className="font-mono-num text-micro text-ink-dim" data-testid="shifted-window">
          {formatWindowRange(start, end)}
        </span>
      )}

      <div className="flex h-8 overflow-hidden rounded-md border border-border" role="group" aria-label="Window navigation">
        <button
          onClick={() => shiftTimeWindow('back')}
          aria-label="Shift window earlier"
          title="Shift window earlier"
          className={cn(SEG, SEG_OFF, 'flex items-center')}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          onClick={jumpToLive}
          disabled={isLive}
          aria-pressed={isLive}
          title="Jump to the current market day"
          className={cn(SEG, 'border-l border-border', isLive ? SEG_ON : SEG_OFF)}
        >
          Now
        </button>
        <button
          onClick={() => shiftTimeWindow('forward')}
          // Disabled at the live position: forward walks back toward now after
          // going back, it does not run the window past now. The store clamps
          // this too — this is the visible half of that rule.
          disabled={timeOffset >= 0}
          aria-label="Shift window later"
          title="Shift window later"
          className={cn(SEG, SEG_OFF, 'flex items-center border-l border-border')}
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex h-8 overflow-hidden rounded-md border border-border" role="group" aria-label="Time range">
        {QUICK_ACCESS_PRESETS.map((item, i) => {
          // A shifted window is not the preset any more, so no quick button
          // reads as active while `timeOffset` is non-zero — the explicit
          // range beside it is what is being shown.
          const active = !shifted && timePreset === item.value;
          return (
            <button
              key={item.value}
              onClick={() => choose(item.value)}
              aria-pressed={active}
              className={cn(SEG, i > 0 && 'border-l border-border', active ? SEG_ON : SEG_OFF)}
            >
              {item.label}
            </button>
          );
        })}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              aria-label="More time ranges"
              className={cn(SEG, 'flex items-center gap-1 border-l border-border', SEG_OFF)}
            >
              More
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            {PRESET_GROUPS.map((group) => (
              <div key={group.id} className="mb-2 last:mb-0">
                <p className="px-2 py-1 text-micro uppercase tracking-wide text-ink-muted">
                  {group.label}
                </p>
                {group.items.map((item) => {
                  const active = !shifted && timePreset === item.value;
                  return (
                    <button
                      key={`${group.id}-${item.value}`}
                      onClick={() => choose(item.value)}
                      aria-pressed={active}
                      className={cn(
                        'block w-full cursor-pointer rounded px-2 py-1.5 text-left text-meta transition-colors',
                        active
                          ? 'bg-foreground text-background'
                          : 'text-ink-dim hover:bg-secondary hover:text-foreground',
                      )}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
