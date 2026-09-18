import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AbleHeader } from '@/components/layout/AbleHeader';
import { useDashboardStore } from '@/store/dashboardStore';
import { lazy, Suspense, useEffect } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { shouldRetryQuery } from '@/lib/queryRetry';

const MapView = lazy(() => import('@/views/MapView').then(m => ({ default: m.MapView })));
const ComparisonView = lazy(() => import('@/views/ComparisonView'));
const OpsStatusView = lazy(() => import('@/views/OpsStatusView'));
const CountryDocumentView = lazy(() => import('@/views/CountryDocumentView').then(m => ({ default: m.CountryDocumentView })));
const LivingGridView = lazy(() => import('@/views/LivingGridView'));

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

/**
 * The Living Grid's own fallback.
 *
 * `ViewSkeleton` paints the cream `bg-background`, which would flash white
 * across a full-screen near-black view every time its lazy chunk loads. These
 * colours are literals rather than the view's CSS variables because that
 * stylesheet arrives with the chunk this is waiting for.
 */
function GridSkeleton() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#07121C',
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          border: '2px solid rgba(47,211,192,0.25)',
          borderTopColor: '#2FD3C0',
          animation: 'spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

function AppRouter() {
  const { currentView } = useDashboardStore();

  if (currentView === 'country') {
    return (
      <Suspense fallback={<ViewSkeleton />}>
        <CountryDocumentView />
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

  // The previous dashboard, kept whole at its own path.
  //
  // Living Grid is the landing screen now, but it is not a replacement for
  // everything here: the country document's forecast and accuracy figures, and
  // the comparison portfolio, have no equivalent in its design. Retiring them
  // is a separate decision with its own evidence, so until then they stay one
  // URL away rather than being deleted to make the swap look clean.
  if (window.location.pathname === '/classic') {
    return (
      <div className="flex h-screen w-full flex-col bg-background text-foreground">
        <AbleHeader />
        <main className="flex flex-1 flex-col overflow-hidden">
          <AppRouter />
        </main>
      </div>
    );
  }

  return (
    <Suspense fallback={<GridSkeleton />}>
      <LivingGridView />
    </Suspense>
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
