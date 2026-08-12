import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AbleHeader } from '@/components/layout/AbleHeader';
import { useDashboardStore } from '@/store/dashboardStore';
import { lazy, Suspense, useEffect } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { shouldRetryQuery } from '@/lib/queryRetry';

const MapView = lazy(() => import('@/views/MapView').then(m => ({ default: m.MapView })));
const CountryDashboardView = lazy(() => import('@/views/CountryDashboardView').then(m => ({ default: m.CountryDashboardView })));
const ComparisonView = lazy(() => import('@/views/ComparisonView'));
const OpsStatusView = lazy(() => import('@/views/OpsStatusView'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,
      // The API is single-threaded and synchronous; a slow query blocks every
      // other request. shouldRetryQuery caps retries at exactly one (and never
      // retries a 4xx), so a failure adds at most one extra request instead of
      // compounding load on a server that's already struggling.
      retry: shouldRetryQuery,
      retryDelay: (attempt) => Math.min(4000, 1000 * 2 ** attempt),
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

  // Internal acceptance/prod status comparison (ABL-238). Reached only by
  // visiting /ops-status directly — deliberately outside `currentView`'s
  // persisted store and AbleHeader's nav, so it stays off the main-nav
  // surface entirely rather than something a normal visit could land on.
  if (window.location.pathname === '/ops-status') {
    return (
      <main className="flex h-screen flex-1 flex-col overflow-hidden bg-background text-foreground">
        <Suspense fallback={<ViewSkeleton />}>
          <OpsStatusView />
        </Suspense>
      </main>
    );
  }

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
