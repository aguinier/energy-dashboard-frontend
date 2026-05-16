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
    <div className="flex overflow-hidden rounded-md border border-border">
      {ITEMS.map((it, i) => {
        const active = timePreset === it.value;
        return (
          <button
            key={it.value}
            onClick={() => setTimePreset(it.value)}
            className={cn(
              'cursor-pointer border-none px-2.5 py-1 font-mono-num text-[11px]',
              i > 0 && 'border-l border-border',
              active ? 'bg-foreground text-background' : 'bg-transparent text-ink-dim',
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
