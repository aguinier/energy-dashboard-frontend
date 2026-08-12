import { useDashboardStore } from '@/store/dashboardStore';
import { cn } from '@/lib/utils';
import { NET_POSITION_SCOPE_OPTIONS } from '@/lib/netPositionScope';

/**
 * Which borders the net position views count: all ENTSO-E-coupled borders
 * (the default, and the only view before ABL-234) or the 12-zone Core
 * flow-based region.
 *
 * A two-option segmented control, matching `MapMetricSelector`'s visual
 * pattern rather than `ModelPicker`'s checkbox popover — the two options are
 * mutually exclusive and both are always available, which is what a segmented
 * control means here and what a popover would hide behind a click.
 *
 * `role="radiogroup"` with `aria-checked` rather than `aria-pressed` toggles:
 * these are one choice between two, not two independent switches, and a
 * screen reader announcing "All coupled borders, pressed / Core region only,
 * not pressed" would describe a state that cannot exist.
 *
 * The control renders identically on the map and on the country tab, and both
 * read the same store field — see `dashboardStore.netPositionScope` for why
 * they are not allowed to disagree.
 */
export function NetPositionScopeToggle({
  className,
  floating,
}: {
  className?: string;
  floating?: boolean;
}) {
  const scope = useDashboardStore((s) => s.netPositionScope);
  const setScope = useDashboardStore((s) => s.setNetPositionScope);

  return (
    <div
      role="radiogroup"
      aria-label="Net position border scope"
      className={cn(
        'inline-flex gap-0.5 rounded-[10px] border border-border bg-card p-[3px]',
        floating && 'shadow-[0_4px_16px_rgba(0,0,0,0.05)]',
        className,
      )}
    >
      {NET_POSITION_SCOPE_OPTIONS.map(({ value, label, title }) => {
        const active = scope === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={title}
            onClick={() => setScope(value)}
            className={cn(
              'cursor-pointer whitespace-nowrap rounded-[7px] border-none px-3 py-[5px] text-meta transition-colors',
              active
                ? 'bg-foreground font-medium text-background'
                : 'bg-transparent font-normal text-ink-dim hover:text-foreground',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
