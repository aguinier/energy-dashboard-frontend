import { matchZone } from './searchMatch';

/**
 * The Living Grid's whole state, and the only thing allowed to change it.
 *
 * It lives in a `useReducer` rather than the app's zustand store on purpose:
 * nothing here is persisted (the view is reached by URL and starts fresh every
 * time), it has exactly one consumer, and a pure reducer is directly testable
 * in a suite that runs without a DOM.
 */

export const VIEW_TABS = ['Balance', 'Prices', 'Generation', 'Market'] as const;
export const PANEL_TABS = ['Overview', 'Energy mix', 'Flows', 'Prices'] as const;
export const STEPS = ['15min', '1h', '3h'] as const;

export type ViewTab = (typeof VIEW_TABS)[number];
export type PanelTab = (typeof PANEL_TABS)[number];
export type ColourBy = 'net' | 'price';

export interface LayerToggles {
  net: boolean;
  flows: boolean;
  commercial: boolean;
  grid: boolean;
  plants: boolean;
}

export interface VizToggles {
  anim: boolean;
  values: boolean;
  labels: boolean;
  glow: boolean;
  borders: boolean;
}

export interface LivingGridState {
  code: string | null;
  hour: number;
  playing: boolean;
  step: number;
  tab: ViewTab;
  ptab: PanelTab;
  colourBy: ColourBy;
  query: string;
  L: LayerToggles;
  V: VizToggles;
}

/**
 * What each view sets, in one update.
 *
 * The prototype changes the layer preset, the colour basis and the panel tab
 * together whenever the view changes, so the map and the panel cannot disagree
 * about what is being shown. Keeping that as one action rather than three
 * preserves the property.
 */
const VIEW_PRESETS: Record<ViewTab, { L: LayerToggles; colourBy: ColourBy; ptab: PanelTab }> = {
  Balance: {
    L: { net: true, flows: true, commercial: false, grid: false, plants: true },
    colourBy: 'net',
    ptab: 'Overview',
  },
  Prices: {
    L: { net: true, flows: true, commercial: false, grid: false, plants: false },
    colourBy: 'price',
    ptab: 'Prices',
  },
  Generation: {
    L: { net: true, flows: true, commercial: false, grid: false, plants: true },
    colourBy: 'net',
    ptab: 'Energy mix',
  },
  Market: {
    L: { net: true, flows: true, commercial: true, grid: false, plants: false },
    colourBy: 'net',
    ptab: 'Flows',
  },
};

/** How many hours the play button advances per tick, per step setting. */
export const STEP_HOURS: Record<(typeof STEPS)[number], number> = {
  '15min': 1,
  '1h': 1,
  '3h': 3,
};

export function initialState(currentHour = 12, code: string | null = null): LivingGridState {
  return {
    code,
    hour: Math.max(0, Math.min(23, currentHour)),
    playing: false,
    step: 1,
    tab: 'Balance',
    ptab: 'Overview',
    colourBy: 'net',
    query: '',
    L: { ...VIEW_PRESETS.Balance.L },
    V: { anim: true, values: true, labels: true, glow: true, borders: false },
  };
}

export type LivingGridAction =
  | { type: 'SET_VIEW'; tab: ViewTab }
  | { type: 'SET_PANEL_TAB'; ptab: PanelTab }
  | { type: 'SET_COLOUR_BY'; colourBy: ColourBy }
  | { type: 'PICK_ZONE'; code: string | null }
  | { type: 'SET_HOUR'; hour: number }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'TOGGLE_PLAY' }
  | { type: 'TICK' }
  | { type: 'CYCLE_STEP' }
  | { type: 'SET_QUERY'; query: string; codes: readonly string[] }
  | { type: 'TOGGLE_LAYER'; key: keyof LayerToggles }
  | { type: 'TOGGLE_VIZ'; key: keyof VizToggles };

export function livingGridReducer(
  state: LivingGridState,
  action: LivingGridAction,
): LivingGridState {
  switch (action.type) {
    case 'SET_VIEW': {
      const preset = VIEW_PRESETS[action.tab];
      return {
        ...state,
        tab: action.tab,
        L: { ...preset.L },
        // Labels and values are forced back on: a view switch is a request to
        // read the map, and leaving them off would answer it with a blank one.
        V: { ...state.V, values: true, labels: true },
        colourBy: preset.colourBy,
        ptab: preset.ptab,
      };
    }

    case 'SET_PANEL_TAB':
      return { ...state, ptab: action.ptab };

    case 'SET_COLOUR_BY':
      return { ...state, colourBy: action.colourBy };

    case 'PICK_ZONE':
      return { ...state, code: action.code };

    case 'SET_HOUR':
      return { ...state, hour: Math.max(0, Math.min(23, Math.round(action.hour))) };

    case 'PLAY':
      return { ...state, playing: true };

    case 'PAUSE':
      return { ...state, playing: false };

    case 'TOGGLE_PLAY':
      return { ...state, playing: !state.playing };

    case 'TICK':
      return { ...state, hour: (state.hour + STEP_HOURS[STEPS[state.step]]) % 24 };

    case 'CYCLE_STEP':
      return { ...state, step: (state.step + 1) % STEPS.length };

    case 'SET_QUERY': {
      const match = matchZone(action.query, action.codes);
      return { ...state, query: action.query, code: match ?? state.code };
    }

    case 'TOGGLE_LAYER':
      return { ...state, L: { ...state.L, [action.key]: !state.L[action.key] } };

    case 'TOGGLE_VIZ':
      return { ...state, V: { ...state.V, [action.key]: !state.V[action.key] } };

    default:
      return state;
  }
}
