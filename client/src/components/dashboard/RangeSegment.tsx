import { useDashboardStore } from '@/store/dashboardStore';
import type { TimePreset } from '@/types';
import { cn } from '@/lib/utils';

// Tight five-button range pill: 24h / 7d / 30d / +24h / +7d.
// Maps onto the existing TimePreset state.
const ITEMS: { value: TimePreset; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'next24h', label: '+24h' },
  { value: 'next7d', label: '+7d' },
];

export function RangeSegment() {
  const { timePreset, setTimePreset } = useDashboardStore();

  return (
    // h-8 matches TabsList and ModelPicker so the three controls on the
    // country dashboard's bar share one height instead of three.
    <div className="flex h-8 overflow-hidden rounded-md border border-border" role="group" aria-label="Time range">
      {ITEMS.map((it, i) => {
        const active = timePreset === it.value;
        return (
          <button
            key={it.value}
            onClick={() => setTimePreset(it.value)}
            aria-pressed={active}
            className={cn(
              'cursor-pointer border-none px-2.5 font-mono-num text-micro transition-colors',
              i > 0 && 'border-l border-border',
              active
                ? 'bg-foreground text-background'
                : 'bg-transparent text-ink-dim hover:bg-secondary hover:text-foreground',
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
