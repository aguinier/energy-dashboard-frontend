import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MapHeader } from '@/components/layout/MapHeader';
import { useDashboardStore } from '@/store/dashboardStore';
import { lazy, Suspense, useEffect } from 'react';
import { useThemeStore } from '@/store/themeStore';

// Lazy load heavy views for code splitting
const MapView = lazy(() => import('@/views/MapView').then(m => ({ default: m.MapView })));
const CountryDashboardView = lazy(() => import('@/views/CountryDashboardView').then(m => ({ default: m.CountryDashboardView })));
const ComparisonView = lazy(() => import('@/views/ComparisonView'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// Loading skeleton for lazy loaded views
function ViewSkeleton() {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-64px)] bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Loading...</p>
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

  // Default: map view
  return (
    <>
      <MapHeader />
      <Suspense fallback={<ViewSkeleton />}>
        <MapView />
      </Suspense>
    </>
  );
}

function AppContent() {
  const { theme } = useThemeStore();

  // Apply theme on mount and changes
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

  return <AppRouter />;
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
