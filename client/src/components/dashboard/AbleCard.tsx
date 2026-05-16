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
// title in 13.5px medium, subtitle in monospace 11px muted.
export function AbleCard({ title, subtitle, actions, children, className, bodyClassName }: AbleCardProps) {
  return (
    <div className={cn('rounded-xl border border-border bg-card', className)}>
      {(title || subtitle || actions) && (
        <div className="flex items-baseline justify-between px-[18px] pb-2.5 pt-4">
          <div>
            {title && <div className="text-[13.5px] font-medium text-foreground">{title}</div>}
            {subtitle && (
              <div className="mt-0.5 font-mono-num text-[11px] text-ink-muted">{subtitle}</div>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('px-[18px] pb-[18px]', !title && !subtitle && !actions && 'pt-[18px]', bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
