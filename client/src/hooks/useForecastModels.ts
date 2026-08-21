import { useQuery } from '@tanstack/react-query';
import { fetchForecastModels, fetchRecommendedModel } from '@/services/api';
import { useDashboardStore } from '@/store/dashboardStore';
import { TAB_FORECAST_TYPE } from '@/lib/constants';
import type { ForecastModel, ForecastModelRegistry, RecommendedModel } from '@/types';

/**
 * The server-side model registry. Cached for the session — it changes only
 * when the server is redeployed.
 */
export function useForecastModels() {
  return useQuery<ForecastModelRegistry>({
    queryKey: ['forecast-models'],
    queryFn: fetchForecastModels,
    staleTime: Infinity,
  });
}

/**
 * The best available forecast for the selected country and a given forecast
 * type, measured server-side over a rolling 30-day window across both our ML
 * models and the ENTSO-E series (ABL-469).
 *
 * Keyed on the pair and cached for an hour, not for the session: the registry
 * above is the same for everyone and never changes without a redeploy, while
 * this is a measurement that moves as the window rolls. An hour is well inside
 * the server's own 30-minute response cache, so a tab switch costs nothing.
 */
export function useRecommendedModel(forecastType: string) {
  const country = useDashboardStore((s) => s.selectedCountry);
  return useQuery<RecommendedModel | undefined>({
    queryKey: ['forecast-recommended', country, forecastType],
    queryFn: () => fetchRecommendedModel({ country, type: forecastType }),
    enabled: Boolean(country && forecastType),
    staleTime: 60 * 60 * 1000,
  });
}

export interface ActiveModelSelection {
  forecastType: string;
  models: ForecastModel[];
  /** Model to label the picker with. Provisional until the response names one. */
  selected: ForecastModel | null;
  /**
   * Model id to send as `model=`, i.e. the user's pin. `undefined` means the
   * user expressed no preference — the server then walks its candidate ladder,
   * which is the only way countries without the production model get a
   * forecast at all.
   */
  requestModelId: string | undefined;
  hidden: boolean;
  /**
   * The measured recommendation this default came from, when it came from one
   * (ABL-469). `null` when the user pinned a model, when nothing has a
   * measurable track record for this pair, or before the measurement lands.
   * What the UI needs it for is the label: a default that is the ENTSO-E
   * series must say so, and must say what it beat.
   */
  autoSelected: RecommendedModel | null;
  isLoading: boolean;
}

/**
 * Resolve which model applies to a forecast type, honouring the user's pin and
 * otherwise taking the best available forecast for this country.
 *
 * A stored id that is no longer registered resolves to the default rather than
 * to nothing — otherwise removing a model from the registry would leave anyone
 * who had selected it staring at an empty chart.
 *
 * `pinnedId` and `hidden` are separate inputs on purpose: they used to be one
 * persisted slot (`null` = hidden), so switching the overlay off threw the pin
 * away and switching it back on had to fabricate one. See ABL-16 and the v7
 * clause in store/migrate.ts.
 *
 * ## The default is now per (country, forecast type) — ABL-469
 *
 * `cfg.production` is one hand-picked id per *type*, chosen on 2026-07-26 and
 * never by measurement. Measured on the replica over 30 days, that showed our
 * catboost for DE load at 6.75% WAPE while the ENTSO-E day-ahead series beside
 * it ran 3.45%. `recommended` is the server's ranking across both sources for
 * this exact pair; when it exists it decides the default, and `cfg.production`
 * stays as the fallback for a pair with no track record yet.
 *
 * **A recommended model is never pinned onto the wire, and that is deliberate
 * rather than an omission.** `requestModelId` stays `undefined` for anything
 * the user did not choose, exactly as before. A recommendation is measured
 * over the last 30 days and says nothing about a window the user has shifted
 * back six months; pinning it there would blank the chart in precisely the
 * case the server's fallback ladder exists to cover, and ABL-221 removed the
 * footnote that used to explain such a blank. So the recommendation decides
 * which *source* is displayed — which is what the Board directive is about —
 * and the ladder keeps choosing between our own models by coverage.
 *
 * ## Why `autoSelected` is not simply "a recommendation exists"
 *
 * The label has to be true of what is on screen, and the two paths differ in
 * how sure we can be:
 *
 * - A **tso** recommendation is unambiguous. The tab fetches that horizon
 *   directly off `selected.tsoHorizon`, so what is drawn is exactly what was
 *   recommended.
 * - An **ml** recommendation is not. Nothing is pinned, so the server's
 *   coverage ladder chooses between our models, and if two of ours both had
 *   rows the ladder could serve one while the measurement named the other —
 *   a chart labelled with a model that did not draw it. `servedModelId` is
 *   the response's own answer to "who actually served" (`meta.model`, already
 *   recorded in `servedModelByType`), so the ml label waits for it to agree.
 *
 * Measured on the replica over 2026-07-21..08-20, **no (country, forecast
 * type) pair has rows from more than one of our registered ml models**, so the
 * disagreement is empty today across all eight types. The check is here so the
 * label stays correct by construction rather than by that measurement holding.
 */
export function resolveSelection(
  registry: ForecastModelRegistry | undefined,
  forecastType: string,
  pinnedId: string | null | undefined,
  hidden: boolean,
  recommended?: RecommendedModel,
  servedModelId?: string | null,
): Omit<ActiveModelSelection, 'isLoading'> {
  const cfg = registry?.[forecastType];
  const models = cfg?.models ?? [];

  if (hidden || !cfg) {
    return { forecastType, models, selected: null, requestModelId: undefined, hidden, autoSelected: null };
  }

  const explicit = pinnedId ? models.find((m) => m.id === pinnedId) : undefined;

  // A recommendation only applies when the user has not chosen for themselves,
  // and only when the model it names is still registered — the same leniency a
  // stale pin already gets.
  const auto = explicit || !recommended
    ? undefined
    : models.find((m) => m.id === recommended.modelId);

  const selected =
    explicit ?? auto ?? models.find((m) => m.id === cfg.production) ?? models[0] ?? null;

  // A fallback is today's hand-picked default, not a measured winner, and must
  // never be labelled as one.
  const measured = auto && recommended && !recommended.fallback ? recommended : null;
  const displaysWhatWasMeasured =
    measured?.source === 'tso' || (measured != null && servedModelId === measured.modelId);

  // Only an id the user actually pinned goes on the wire. A default is a
  // preference, not an instruction, and pinning one blanks every country and
  // every window that has no data for that model.
  return {
    forecastType,
    models,
    selected,
    requestModelId: explicit?.id,
    hidden,
    autoSelected: displaysWhatWasMeasured ? measured : null,
  };
}

export function useModelSelection(forecastType: string): ActiveModelSelection {
  const { data: registry, isLoading } = useForecastModels();
  const { data: recommended } = useRecommendedModel(forecastType);
  // Single-select callers (Load, Price, Wind) only ever write a one-element
  // selection (`setSelectedModel`) — see dashboardStore.ts. This reads just its
  // first (only) entry, so `resolveSelection` above is unchanged from before
  // the store moved to an array shape.
  const pinnedId = useDashboardStore((s) => s.selectedModelsByType[forecastType]?.[0]);
  const hidden = useDashboardStore((s) => s.forecastHiddenByType[forecastType] ?? false);
  // `meta.model` from the last response for this type — the only thing that
  // knows which of our models the server's ladder actually served. Written by
  // each tab's data hook; this is its first reader.
  const servedModelId = useDashboardStore((s) => s.servedModelByType[forecastType]);
  return {
    ...resolveSelection(registry, forecastType, pinnedId, hidden, recommended, servedModelId),
    isLoading,
  };
}

export interface ActiveModelsSelection {
  forecastType: string;
  models: ForecastModel[];
  /**
   * Registered ids the user has checked, in no particular order. Empty means
   * "Default" — nothing pinned, so no `model=` goes on the wire and the
   * server's own candidate ladder picks. An id that was pinned but has since
   * been removed from the registry is dropped rather than sent, the same
   * leniency `resolveSelection` gives a single pin.
   */
  selectedIds: string[];
  hidden: boolean;
}

/**
 * Multi-select counterpart of `resolveSelection`, for net position's picker
 * (ABL-203). Every other forecast type still only ever gets a single pin —
 * this exists because comparing several of net position's shadow-candidate
 * models at once is the actual point of that tab's picker.
 */
export function resolveMultiSelection(
  registry: ForecastModelRegistry | undefined,
  forecastType: string,
  pinnedIds: string[] | undefined,
  hidden: boolean,
): ActiveModelsSelection {
  const cfg = registry?.[forecastType];
  const models = cfg?.models ?? [];

  if (hidden || !cfg) {
    return { forecastType, models, selectedIds: [], hidden };
  }

  const validIds = new Set(models.map((m) => m.id));
  // De-dup and drop ids no longer registered, so removing a model from the
  // registry empties that part of the selection instead of sending an id the
  // server has never heard of.
  const selectedIds = [...new Set((pinnedIds ?? []).filter((id) => validIds.has(id)))];

  return { forecastType, models, selectedIds, hidden };
}

export function useMultiModelSelection(forecastType: string): ActiveModelsSelection & { isLoading: boolean } {
  const { data: registry, isLoading } = useForecastModels();
  const pinnedIds = useDashboardStore((s) => s.selectedModelsByType[forecastType]);
  const hidden = useDashboardStore((s) => s.forecastHiddenByType[forecastType] ?? false);
  return { ...resolveMultiSelection(registry, forecastType, pinnedIds, hidden), isLoading };
}

/** The forecast type the active country-view tab is about. */
export function useActiveForecastType(): string {
  const activeChartTab = useDashboardStore((s) => s.activeChartTab);
  return TAB_FORECAST_TYPE[activeChartTab] ?? 'load';
}
