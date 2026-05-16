import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AbleHeader } from '@/components/layout/AbleHeader';
import { useDashboardStore } from '@/store/dashboardStore';
import { lazy, Suspense, useEffect } from 'react';
import { useThemeStore } from '@/store/themeStore';

const MapView = lazy(() => import('@/views/MapView').then(m => ({ default: m.MapView })));
const CountryDashboardView = lazy(() => import('@/views/CountryDashboardView').then(m => ({ default: m.CountryDashboardView })));
const ComparisonView = lazy(() => import('@/views/ComparisonView'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

function ViewSkeleton() {
  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-ink-dim">Loading…</p>
      </div>
    </div>
  );
}

function AppRouter() {
  const { currentView } = useDashboardStore();

  if (currentView === 'country') {
    return (
      <Suspense fallback={<ViewSkeleton />}>
        <CountryDashboardView />
      </Suspense>
    );
  }

  if (currentView === 'comparison') {
    return (
      <Suspense fallback={<ViewSkeleton />}>
        <ComparisonView />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<ViewSkeleton />}>
      <MapView />
    </Suspense>
  );
}

function AppContent() {
  const { theme } = useThemeStore();

  useEffect(() => {
    const root = document.documentElement;
    const effectiveTheme =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    root.classList.remove('light', 'dark');
    root.classList.add(effectiveTheme);
  }, [theme]);

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground">
      <AbleHeader />
      <main className="flex flex-1 flex-col overflow-hidden">
        <AppRouter />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={domAnimation} strict>
        <TooltipProvider>
          <AppContent />
        </TooltipProvider>
      </LazyMotion>
    </QueryClientProvider>
  );
}
