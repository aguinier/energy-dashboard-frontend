import { ThemeToggle } from '@/components/ui/theme-toggle';
import { Button } from '@/components/ui/button';
import { useDashboardStore } from '@/store/dashboardStore';
import { Zap, BarChart3 } from 'lucide-react';

export function MapHeader() {
  const { goToComparison } = useDashboardStore();

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-bold">Energy Dashboard</span>
        </div>

        {/* Right: Compare button + Theme toggle */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={goToComparison}
            className="gap-1.5"
          >
            <BarChart3 className="h-4 w-4" />
            Compare Countries
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
