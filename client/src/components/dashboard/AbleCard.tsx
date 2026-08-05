import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface AbleCardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

// Minimal card aligned with the able prototype: rounded-xl, single border,
// title on the `title` step of the type scale, subtitle in monospace `micro`.
// Padding is a flat 20px (px-5 / pb-5) on every edge rather than the previous
// 18px sides against a 16px top, so cards sitting side by side in a grid have
// their content on the same gridlines.
export function AbleCard({ title, subtitle, actions, children, className, bodyClassName }: AbleCardProps) {
  return (
    <div className={cn('rounded-xl border border-border bg-card', className)}>
      {(title || subtitle || actions) && (
        <div className="flex items-baseline justify-between gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0">
            {title && <div className="text-title font-medium text-foreground">{title}</div>}
            {subtitle && (
              <div className="mt-0.5 font-mono-num text-micro text-ink-muted">{subtitle}</div>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('px-5 pb-5', !title && !subtitle && !actions && 'pt-5', bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
