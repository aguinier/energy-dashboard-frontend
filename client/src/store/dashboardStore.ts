import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TimePreset, TimeAnchor, MetricType, TSOForecastType, AppView } from '@/types';
import { DEFAULT_COUNTRY, PRESET_SHIFT_HOURS } from '@/lib/constants';
import { migratePersisted, PERSIST_VERSION } from './migrate';

// Default ML forecast horizons (D+1 and D+2)
const DEFAULT_ML_HORIZONS = [1, 2];

interface DashboardState {
  // App view navigation
  currentView: AppView;
  goToCountry: (countryCode: string, tab?: string) => void;
  goToMap: () => void;

  // Selected country
  selectedCountry: string;
  setSelectedCountry: (country: string) => void;

  // New time navigation
  timePreset: TimePreset;
  timeAnchor: TimeAnchor;
  timeOffset: number; // Hours offset from "now" (for navigation arrows)
  isLive: boolean; // Whether currently viewing live/now data
  setTimePreset: (preset: TimePreset) => void;
  shiftTimeWindow: (direction: 'back' | 'forward') => void;
  jumpToLive: () => void;
  setIsLive: (live: boolean) => void;

  // Map metric
  mapMetric: MetricType;
  setMapMetric: (metric: MetricType) => void;

  // UI state
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;

  // Active chart tab
  activeChartTab: string;
  setActiveChartTab: (tab: string) => void;

  // Forecast model PINNED per forecast type. Absent = no pin, which is what
  // lets the server walk its candidate ladder (production model first, then
  // the other registered ml models) — the only state that renders a forecast
  // for a country the production model does not cover.
  //
  // Hidden lives in `forecastHiddenByType`, not here. The two used to share
  // this slot (`null` meant hidden), so hiding destroyed the pin and showing
  // again had to invent one — it re-pinned the production model, blanking
  // every country that model has no rows for, with no UI way back (ABL-16).
  selectedModelByType: Record<string, string>;
  setSelectedModel: (forecastType: string, modelId: string) => void;
  /** Drop the pin, handing model choice back to the server's candidate ladder. */
  clearSelectedModel: (forecastType: string) => void;

  // Whether the forecast overlay is switched off, per forecast type.
  // Absent = shown.
  forecastHiddenByType: Record<string, boolean>;
  setForecastHidden: (forecastType: string, hidden: boolean) => void;

  // Model that actually served the most recent forecast response, per type.
  // Populated by the data hooks (useLoadChartData, usePriceChartData) from
  // `meta.model`, not persisted — it describes the last network response, not
  // a preference. ModelPicker reads this to show the model that truly served
  // rather than the provisional/production label when the server fell back.
  servedModelByType: Record<string, string | null>;
  setServedModel: (forecastType: string, modelId: string | null) => void;

  // Forecast visibility (ML forecasts)
  showForecast: boolean;
  setShowForecast: (show: boolean) => void;
  toggleForecast: () => void;

  // Forecast comparison mode (ML forecasts)
  showComparisonMode: boolean;
  setShowComparisonMode: (show: boolean) => void;
  toggleComparisonMode: () => void;

  // TSO Forecast visibility (ENTSO-E official forecasts)
  showTSOForecast: boolean;
  setShowTSOForecast: (show: boolean) => void;
  toggleTSOForecast: () => void;

  // TSO Forecast type (day_ahead or week_ahead)
  tsoForecastType: TSOForecastType;
  setTSOForecastType: (type: TSOForecastType) => void;

  // TSO Forecast comparison mode (historical accuracy)
  showTSOComparisonMode: boolean;
  setShowTSOComparisonMode: (show: boolean) => void;
  toggleTSOComparisonMode: () => void;

  // Renewable type visibility (for RenewableMixChart)
  visibleRenewableTypes: string[];
  toggleRenewableType: (type: string) => void;
  setVisibleRenewableTypes: (types: string[]) => void;

  // ML Forecast horizon selection (for multi-horizon overlay)
  selectedMLHorizons: number[];
  toggleMLHorizon: (horizon: number) => void;
  setSelectedMLHorizons: (horizons: number[]) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      // App view navigation
      currentView: 'map',
      goToCountry: (countryCode, tab = 'load') => set({
        currentView: 'country',
        selectedCountry: countryCode,
        activeChartTab: tab,
      }),
      goToMap: () => set({ currentView: 'map' }),

      // Selected country
      selectedCountry: DEFAULT_COUNTRY,
      setSelectedCountry: (country) => set({ selectedCountry: country }),

      // New time navigation
      timePreset: '7d',
      timeAnchor: 'past',
      timeOffset: 0,
      isLive: false,
      setTimePreset: (preset) => {
        // Determine anchor from preset
        let anchor: TimeAnchor = 'past';
        if (['today', 'thisWeek'].includes(preset)) {
          anchor = 'now';
        } else if (['next1d', 'next24h', 'next48h', 'next7d'].includes(preset)) {
          anchor = 'future';
        }

        // Check if this brings us to "live" view
        const isLivePreset = ['today', 'thisWeek'].includes(preset);

        // Auto-enable ML forecast for future presets (since no actual data exists)
        const isFuturePreset = ['next1d', 'next24h', 'next48h', 'next7d'].includes(preset);

        set({
          timePreset: preset,
          timeAnchor: anchor,
          timeOffset: 0, // Reset offset when changing preset
          isLive: isLivePreset,
          // Auto-enable ML forecast for future presets
          ...(isFuturePreset && { showForecast: true }),
        });
      },
      // Move the window by one step of the current preset (PRESET_SHIFT_HOURS).
      //
      // `timeOffset` is clamped at 0 rather than allowed to go positive: 0 is
      // the live position, where every preset already means exactly what its
      // label says, and "forward" exists to walk back toward it after going
      // back. A positive offset would push a historical window past now into a
      // region with no actuals yet — a chart guaranteed to be empty on its
      // right-hand side — and would let a forecast window run past the ~D+2
      // horizon anything is actually stored for. The clamp lives here rather
      // than only in the control so the invariant holds for every caller; the
      // forward arrow's disabled state (TimePicker.tsx) is the visible half of
      // the same rule.
      shiftTimeWindow: (direction) => {
        set((state) => {
          // Typed access always hits; `?? 168` covers a `timePreset` that
          // reached the store from a persisted blob without passing migration.
          const shiftAmount = PRESET_SHIFT_HOURS[state.timePreset] ?? 168;
          const newOffset = Math.min(
            0,
            direction === 'back'
              ? state.timeOffset - shiftAmount
              : state.timeOffset + shiftAmount,
          );
          return {
            timeOffset: newOffset,
            isLive: newOffset === 0 && ['today', 'thisWeek'].includes(state.timePreset),
          };
        });
      },
      jumpToLive: () => set({
        timePreset: 'today',
        timeAnchor: 'now',
        timeOffset: 0,
        isLive: true,
      }),
      setIsLive: (live) => set({ isLive: live }),

      // Map metric
      mapMetric: 'load',
      setMapMetric: (metric) => set({ mapMetric: metric }),

      // UI state
      sidebarOpen: true,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      // Active chart tab
      activeChartTab: 'load',
      setActiveChartTab: (tab) => set({ activeChartTab: tab }),

      selectedModelByType: {},
      setSelectedModel: (forecastType, modelId) =>
        set((state) => ({
          selectedModelByType: { ...state.selectedModelByType, [forecastType]: modelId },
        })),
      clearSelectedModel: (forecastType) =>
        set((state) => {
          if (state.selectedModelByType[forecastType] === undefined) return state;
          const next = { ...state.selectedModelByType };
          delete next[forecastType];
          return { selectedModelByType: next };
        }),

      forecastHiddenByType: {},
      setForecastHidden: (forecastType, hidden) =>
        set((state) => {
          const current = state.forecastHiddenByType[forecastType] ?? false;
          if (current === hidden) return state;
          const next = { ...state.forecastHiddenByType };
          // Absent rather than `false`, so the persisted blob only ever carries
          // the types the user actually switched off.
          if (hidden) next[forecastType] = true;
          else delete next[forecastType];
          return { forecastHiddenByType: next };
        }),

      servedModelByType: {},
      setServedModel: (forecastType, modelId) =>
        set((state) =>
          state.servedModelByType[forecastType] === modelId
            ? state
            : { servedModelByType: { ...state.servedModelByType, [forecastType]: modelId } },
        ),

      // Forecast visibility
      showForecast: false,
      setShowForecast: (show) => set({ showForecast: show }),
      toggleForecast: () => set((state) => ({ showForecast: !state.showForecast })),

      // Forecast comparison mode
      showComparisonMode: false,
      setShowComparisonMode: (show) => set({ showComparisonMode: show }),
      toggleComparisonMode: () => set((state) => ({ showComparisonMode: !state.showComparisonMode })),

      // TSO Forecast visibility (ENTSO-E official forecasts)
      showTSOForecast: false,
      setShowTSOForecast: (show) => set({ showTSOForecast: show }),
      toggleTSOForecast: () => set((state) => ({ showTSOForecast: !state.showTSOForecast })),

      // TSO Forecast type
      tsoForecastType: 'day_ahead',
      setTSOForecastType: (type) => set({ tsoForecastType: type }),

      // TSO Forecast comparison mode
      showTSOComparisonMode: false,
      setShowTSOComparisonMode: (show) => set({ showTSOComparisonMode: show }),
      toggleTSOComparisonMode: () => set((state) => ({ showTSOComparisonMode: !state.showTSOComparisonMode })),

      // Renewable type visibility (default: main types only - solar and wind)
      visibleRenewableTypes: ['solar', 'wind_onshore', 'wind_offshore'],
      toggleRenewableType: (type) =>
        set((state) => ({
          visibleRenewableTypes: state.visibleRenewableTypes.includes(type)
            ? state.visibleRenewableTypes.filter((t) => t !== type)
            : [...state.visibleRenewableTypes, type],
        })),
      setVisibleRenewableTypes: (types) => set({ visibleRenewableTypes: types }),

      // ML Forecast horizon selection (default: both D+1 and D+2)
      selectedMLHorizons: DEFAULT_ML_HORIZONS,
      toggleMLHorizon: (horizon) =>
        set((state) => {
          const current = state.selectedMLHorizons;
          if (current.includes(horizon)) {
            // Don't allow deselecting all horizons
            if (current.length === 1) return state;
            return { selectedMLHorizons: current.filter((h) => h !== horizon) };
          }
          return { selectedMLHorizons: [...current, horizon].sort() };
        }),
      setSelectedMLHorizons: (horizons) => set({ selectedMLHorizons: horizons }),
    }),
    {
      name: 'energy-dashboard-storage',
      version: PERSIST_VERSION,
      migrate: (persisted, from) => migratePersisted(persisted as Record<string, unknown>, from),
      partialize: (state) => ({
        currentView: state.currentView,
        selectedCountry: state.selectedCountry,
        timePreset: state.timePreset,
        timeAnchor: state.timeAnchor,
        mapMetric: state.mapMetric,
        activeChartTab: state.activeChartTab,
        selectedModelByType: state.selectedModelByType,
        forecastHiddenByType: state.forecastHiddenByType,
        sidebarOpen: state.sidebarOpen,
        // Legacy forecast state (kept for backward compatibility)
        showForecast: state.showForecast,
        showComparisonMode: state.showComparisonMode,
        showTSOForecast: state.showTSOForecast,
        tsoForecastType: state.tsoForecastType,
        showTSOComparisonMode: state.showTSOComparisonMode,
        visibleRenewableTypes: state.visibleRenewableTypes,
        // ML Forecast horizons
        selectedMLHorizons: state.selectedMLHorizons,
      }),
    }
  )
);
