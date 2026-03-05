import { ReactNode, memo } from 'react';
import { m } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnimatedValue } from '@/hooks/useAnimatedValue';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: number | null | undefined;
  unit: string;
  icon: ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  isLoading?: boolean;
  decimals?: number;
  delay?: number;
  colorClass?: string;
}

export const StatCard = memo(function StatCard({
  title,
  value,
  unit,
  icon,
  trend,
  isLoading,
  decimals = 0,
  delay = 0,
  colorClass,
}: StatCardProps) {
  const animatedValue = useAnimatedValue(value, { decimals, delay });

  if (isLoading) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-10 w-10 rounded-lg" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: delay / 1000 }}
    >
      <Card className="overflow-hidden transition-all hover:shadow-lg">
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                {title}
              </p>
              <div className="flex items-baseline gap-1">
                <m.span
                  key={value}
                  className="text-3xl font-bold tracking-tight"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  {value !== null && value !== undefined
                    ? animatedValue.toLocaleString()
                    : <span className="text-muted-foreground/50">N/A</span>}
                </m.span>
                <span className="text-sm text-muted-foreground">{unit}</span>
              </div>
              {trend && (
                <div
                  className={cn(
                    'flex items-center gap-1 text-sm font-medium',
                    trend.isPositive ? 'text-green-600' : 'text-red-600'
                  )}
                >
                  <span>{trend.isPositive ? '↑' : '↓'}</span>
                  <span>{Math.abs(trend.value).toFixed(1)}%</span>
                  <span className="text-muted-foreground font-normal">vs 24h</span>
                </div>
              )}
            </div>
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg',
                colorClass || 'bg-primary/10 text-primary'
              )}
            >
              {icon}
            </div>
          </div>
        </CardContent>
      </Card>
    </m.div>
  );
});
