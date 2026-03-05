import type { ForecastProviderInfo, AvailableProvidersResponse } from '@/types';

/**
 * Provider Registry - Maps forecast providers to display properties
 */

// Model colors for ML providers
export const MODEL_COLORS: Record<string, string> = {
  xgboost: '#0ea5e9',    // sky-500
  lightgbm: '#22c55e',   // green-500
  catboost: '#f97316',    // orange-500
  lstm: '#8b5cf6',        // violet-500
  ensemble: '#ec4899',    // pink-500
};

// TSO color
export const TSO_COLOR = '#10b981'; // emerald-500

// Short labels for models
const MODEL_SHORT_LABELS: Record<string, string> = {
  xgboost: 'XGB',
  lightgbm: 'LGBM',
  catboost: 'CB',
  lstm: 'LSTM',
  ensemble: 'ENS',
};

// Horizon labels
const HORIZON_LABELS: Record<string, string> = {
  day_ahead: 'Day-Ahead',
  week_ahead: 'Week-Ahead',
  d1: 'D+1',
  d2: 'D+2',
};

/**
 * Build provider list from available providers response
 */
export function buildProviderList(
  providersResponse: AvailableProvidersResponse
): ForecastProviderInfo[] {
  const providers: ForecastProviderInfo[] = [];

  // Add TSO providers
  if (providersResponse.tso.available) {
    for (const horizon of providersResponse.tso.horizons) {
      providers.push({
        id: `tso_${horizon}`,
        type: 'tso',
        horizon,
        label: `TSO (${HORIZON_LABELS[horizon] || horizon})`,
        shortLabel: `TSO ${horizon === 'day_ahead' ? 'D+1' : 'D+7'}`,
        color: TSO_COLOR,
      });
    }
  }

  // Add ML providers
  for (const model of providersResponse.ml.models) {
    const modelName = model.model_name;
    const color = MODEL_COLORS[modelName] || '#6b7280'; // gray fallback
    const shortName = MODEL_SHORT_LABELS[modelName] || modelName.toUpperCase().slice(0, 4);

    // D+1 horizon
    providers.push({
      id: `${modelName}_d1`,
      type: 'ml',
      modelName,
      horizon: 'd1',
      label: `${capitalize(modelName)} (D+1)`,
      shortLabel: `${shortName} D+1`,
      color,
    });

    // D+2 horizon
    providers.push({
      id: `${modelName}_d2`,
      type: 'ml',
      modelName,
      horizon: 'd2',
      label: `${capitalize(modelName)} (D+2)`,
      shortLabel: `${shortName} D+2`,
      color: adjustColor(color, -15), // slightly darker for D+2
    });
  }

  return providers;
}

/**
 * Get a provider by ID from the list
 */
export function getProviderById(
  providers: ForecastProviderInfo[],
  id: string
): ForecastProviderInfo | undefined {
  return providers.find((p) => p.id === id);
}

/**
 * Get the color for a provider ID (for use in charts)
 */
export function getProviderColor(providerId: string): string {
  if (providerId.startsWith('tso')) return TSO_COLOR;

  const modelName = providerId.split('_')[0];
  const baseColor = MODEL_COLORS[modelName] || '#6b7280';

  // Slightly darken D+2 colors
  if (providerId.endsWith('_d2')) {
    return adjustColor(baseColor, -15);
  }

  return baseColor;
}

// Helpers

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Adjust a hex color brightness
 */
function adjustColor(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + percent));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
