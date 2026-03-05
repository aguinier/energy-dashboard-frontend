import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TimeRange, TimePreset, TimeAnchor, MetricType, TSOForecastType, LayersState, TSOHorizon, AppView, AnalyticsForecastType } from '@/types';
import { DEFAULT_COUNTRY, PRESET_DURATIONS_HOURS } from '@/lib/constants';

// Default layers state
const DEFAULT_LAYERS: LayersState = {
  showActuals: true,
  tso: {
    enabled: false,
    showAccuracy: false,
    horizon: 'day_ahead',
  },
  ml: {
    enabled: false,
    showAccuracy: false,
  },
};

// Default ML forecast horizons (D+1 and D+2)
const DEFAULT_ML_HORIZONS = [1, 2];

// Analytics time range presets
export type AnalyticsTimeRange = '7d' | '30d' | '90d' | 'all';

// Default analytics configuration
export interface AnalyticsConfig {
  forecastType: AnalyticsForecastType;
  selectedProviders: ('tso' | 'ml')[];
  selectedHorizons: {
    tso: ('day_ahead' | 'week_ahead')[];
    ml: (1 | 2)[];
  };
  // Independent time range for analytics (not linked to global dashboard time)
  timeRange: AnalyticsTimeRange;
  // Rolling window for accuracy trend chart (days)
  rollingWindow: 7 | 14;
}

const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  forecastType: 'load',
  selectedProviders: ['tso', 'ml'],
  selectedHorizons: {
    tso: ['day_ahead'],
    ml: [1, 2],
  },
  timeRange: '30d',     // Default: 30 days for sufficient statistical samples
  rollingWindow: 7,     // Default: 7-day rolling window
};

interface DashboardState {
  // App view navigation
  currentView: AppView;
  goToCountry: (countryCode: string) => void;
  goToMap: () => void;

  // Selected country
  selectedCountry: string;
  setSelectedCountry: (country: string) => void;

  // Time range (legacy - kept for backward compatibility)
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;

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

  // Countries for comparison
  comparisonCountries: string[];
  addComparisonCountry: (country: string) => void;
  removeComparisonCountry: (country: string) => void;
  setComparisonCountries: (countries: string[]) => void;

  // UI state
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;

  // Active chart tab
  activeChartTab: string;
  setActiveChartTab: (tab: string) => void;

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

  // ============================================================================
  // Unified Data Layers (new system)
  // ============================================================================
  layers: LayersState;

  // Layer actions
  toggleLayer: (layer: 'tso' | 'ml') => void;
  setLayerAccuracy: (layer: 'tso' | 'ml', show: boolean) => void;
  setTSOHorizon: (horizon: TSOHorizon) => void;
  showActualsOnly: () => void;
  showAllLayers: () => void;

  // ============================================================================
  // Analytics Configuration
  // ============================================================================
  analyticsConfig: AnalyticsConfig;
  setAnalyticsForecastType: (forecastType: AnalyticsForecastType) => void;
  toggleAnalyticsProvider: (provider: 'tso' | 'ml') => void;
  toggleAnalyticsTSOHorizon: (horizon: 'day_ahead' | 'week_ahead') => void;
  toggleAnalyticsMLHorizon: (horizon: 1 | 2) => void;
  setAnalyticsTimeRange: (timeRange: AnalyticsTimeRange) => void;
  setAnalyticsRollingWindow: (window: 7 | 14) => void;
  resetAnalyticsConfig: () => void;

  // ============================================================================
  // Cross-Country Comparison
  // ============================================================================
  comparisonMetric: 'mape' | 'mae' | 'rmse';
  comparisonForecastType: string;
  comparisonTimeRange: '7d' | '30d' | '90d';
  setComparisonMetric: (m: 'mape' | 'mae' | 'rmse') => void;
  setComparisonForecastType: (t: string) => void;
  setComparisonTimeRange: (r: '7d' | '30d' | '90d') => void;
  goToComparison: () => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      // App view navigation
      currentView: 'map',
      goToCountry: (countryCode) => set({
        currentView: 'country',
        selectedCountry: countryCode,
        activeChartTab: 'load', // Reset to default tab when entering country view
      }),
      goToMap: () => set({ currentView: 'map' }),

      // Selected country
      selectedCountry: DEFAULT_COUNTRY,
      setSelectedCountry: (country) => set({ selectedCountry: country }),

      // Time range (legacy)
      timeRange: '7d',
      setTimeRange: (range) => set({ timeRange: range }),

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

        // Also update legacy timeRange for backward compatibility
        const legacyTimeRange = ['24h', '7d', '30d', '90d', '1y'].includes(preset)
          ? preset as TimeRange
          : '7d';

        set({
          timePreset: preset,
          timeAnchor: anchor,
          timeOffset: 0, // Reset offset when changing preset
          isLive: isLivePreset,
          timeRange: legacyTimeRange,
          // Auto-enable ML forecast for future presets
          ...(isFuturePreset && { showForecast: true }),
        });
      },
      shiftTimeWindow: (direction) => {
        set((state) => {
          const durationHours = PRESET_DURATIONS_HOURS[state.timePreset] || 168;
          const shiftAmount = Math.floor(durationHours / 2); // Shift by half the window
          const newOffset = direction === 'back'
            ? state.timeOffset - shiftAmount
            : state.timeOffset + shiftAmount;
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

      // Comparison countries
      comparisonCountries: ['DE', 'FR'],
      addComparisonCountry: (country) =>
        set((state) => ({
          comparisonCountries: state.comparisonCountries.includes(country)
            ? state.comparisonCountries
            : [...state.comparisonCountries, country].slice(0, 5), // Max 5
        })),
      removeComparisonCountry: (country) =>
        set((state) => ({
          comparisonCountries: state.comparisonCountries.filter((c) => c !== country),
        })),
      setComparisonCountries: (countries) =>
        set({ comparisonCountries: countries.slice(0, 5) }),

      // UI state
      sidebarOpen: true,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      // Active chart tab
      activeChartTab: 'load',
      setActiveChartTab: (tab) => set({ activeChartTab: tab }),

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

      // ============================================================================
      // Unified Data Layers (new system)
      // ============================================================================
      layers: DEFAULT_LAYERS,

      toggleLayer: (layer) =>
        set((state) => {
          const newEnabled = !state.layers[layer].enabled;
          const newLayers = {
            ...state.layers,
            [layer]: {
              ...state.layers[layer],
              enabled: newEnabled,
              // Reset accuracy when disabling
              showAccuracy: newEnabled ? state.layers[layer].showAccuracy : false,
            },
          };
          // Sync with legacy state (including comparison modes)
          return {
            layers: newLayers,
            showTSOForecast: newLayers.tso.enabled,
            showForecast: newLayers.ml.enabled,
            showTSOComparisonMode: newLayers.tso.showAccuracy,
            showComparisonMode: newLayers.ml.showAccuracy,
          };
        }),

      setLayerAccuracy: (layer, show) =>
        set((state) => {
          // If enabling accuracy for one layer, disable for others (exclusive)
          const newLayers = {
            ...state.layers,
            tso: {
              ...state.layers.tso,
              showAccuracy: layer === 'tso' ? show : (show ? false : state.layers.tso.showAccuracy),
            },
            ml: {
              ...state.layers.ml,
              showAccuracy: layer === 'ml' ? show : (show ? false : state.layers.ml.showAccuracy),
            },
          };
          // Sync with legacy state
          return {
            layers: newLayers,
            showTSOComparisonMode: newLayers.tso.showAccuracy,
            showComparisonMode: newLayers.ml.showAccuracy,
          };
        }),

      setTSOHorizon: (horizon) =>
        set((state) => ({
          layers: {
            ...state.layers,
            tso: {
              ...state.layers.tso,
              horizon,
            },
          },
          // Sync with legacy state
          tsoForecastType: horizon,
        })),

      showActualsOnly: () =>
        set((state) => ({
          layers: {
            ...state.layers,
            showActuals: true,
            tso: { ...state.layers.tso, enabled: false, showAccuracy: false },
            ml: { ...state.layers.ml, enabled: false, showAccuracy: false },
          },
          // Sync with legacy state
          showTSOForecast: false,
          showForecast: false,
          showTSOComparisonMode: false,
          showComparisonMode: false,
        })),

      showAllLayers: () =>
        set((state) => ({
          layers: {
            ...state.layers,
            showActuals: true,
            tso: { ...state.layers.tso, enabled: true },
            ml: { ...state.layers.ml, enabled: true },
          },
          // Sync with legacy state (including comparison modes)
          showTSOForecast: true,
          showForecast: true,
          showTSOComparisonMode: state.layers.tso.showAccuracy,
          showComparisonMode: state.layers.ml.showAccuracy,
        })),

      // ============================================================================
      // Analytics Configuration
      // ============================================================================
      analyticsConfig: DEFAULT_ANALYTICS_CONFIG,

      setAnalyticsForecastType: (forecastType) =>
        set((state) => ({
          analyticsConfig: { ...state.analyticsConfig, forecastType },
        })),

      toggleAnalyticsProvider: (provider) =>
        set((state) => {
          const current = state.analyticsConfig.selectedProviders;
          if (current.includes(provider)) {
            // Don't allow deselecting all providers
            if (current.length === 1) return state;
            return {
              analyticsConfig: {
                ...state.analyticsConfig,
                selectedProviders: current.filter((p) => p !== provider),
              },
            };
          }
          return {
            analyticsConfig: {
              ...state.analyticsConfig,
              selectedProviders: [...current, provider],
            },
          };
        }),

      toggleAnalyticsTSOHorizon: (horizon) =>
        set((state) => {
          const current = state.analyticsConfig.selectedHorizons.tso;
          if (current.includes(horizon)) {
            // Don't allow deselecting all horizons
            if (current.length === 1) return state;
            return {
              analyticsConfig: {
                ...state.analyticsConfig,
                selectedHorizons: {
                  ...state.analyticsConfig.selectedHorizons,
                  tso: current.filter((h) => h !== horizon),
                },
              },
            };
          }
          return {
            analyticsConfig: {
              ...state.analyticsConfig,
              selectedHorizons: {
                ...state.analyticsConfig.selectedHorizons,
                tso: [...current, horizon],
              },
            },
          };
        }),

      toggleAnalyticsMLHorizon: (horizon) =>
        set((state) => {
          const current = state.analyticsConfig.selectedHorizons.ml;
          if (current.includes(horizon)) {
            // Don't allow deselecting all horizons
            if (current.length === 1) return state;
            return {
              analyticsConfig: {
                ...state.analyticsConfig,
                selectedHorizons: {
                  ...state.analyticsConfig.selectedHorizons,
                  ml: current.filter((h) => h !== horizon),
                },
              },
            };
          }
          return {
            analyticsConfig: {
              ...state.analyticsConfig,
              selectedHorizons: {
                ...state.analyticsConfig.selectedHorizons,
                ml: [...current, horizon].sort((a, b) => a - b) as (1 | 2)[],
              },
            },
          };
        }),

      setAnalyticsTimeRange: (timeRange) =>
        set((state) => ({
          analyticsConfig: { ...state.analyticsConfig, timeRange },
        })),

      setAnalyticsRollingWindow: (rollingWindow) =>
        set((state) => ({
          analyticsConfig: { ...state.analyticsConfig, rollingWindow },
        })),

      resetAnalyticsConfig: () =>
        set({ analyticsConfig: DEFAULT_ANALYTICS_CONFIG }),

      // ============================================================================
      // Cross-Country Comparison
      // ============================================================================
      comparisonMetric: 'mape',
      comparisonForecastType: 'all',
      comparisonTimeRange: '30d',
      setComparisonMetric: (m) => set({ comparisonMetric: m }),
      setComparisonForecastType: (t) => set({ comparisonForecastType: t }),
      setComparisonTimeRange: (r) => set({ comparisonTimeRange: r }),
      goToComparison: () => set({ currentView: 'comparison' }),
    }),
    {
      name: 'energy-dashboard-storage',
      partialize: (state) => ({
        currentView: state.currentView,
        selectedCountry: state.selectedCountry,
        timeRange: state.timeRange,
        timePreset: state.timePreset,
        timeAnchor: state.timeAnchor,
        mapMetric: state.mapMetric,
        comparisonCountries: state.comparisonCountries,
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
        // New unified layers state
        layers: state.layers,
        // Analytics configuration
        analyticsConfig: state.analyticsConfig,
        // Cross-country comparison
        comparisonMetric: state.comparisonMetric,
        comparisonForecastType: state.comparisonForecastType,
        comparisonTimeRange: state.comparisonTimeRange,
      }),
    }
  )
);
