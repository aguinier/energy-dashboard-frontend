import { matchZone } from './searchMatch';
import { shiftDate, withinReach } from './dayRange';

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
// The payload is hourly, so an offered step finer than an hour would change
// the chip's label and nothing else.
export const STEPS = ['1h', '3h'] as const;

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
  /**
   * The day on screen, or null for the rolling "today".
   *
   * Null is not a missing value — it is the live day, and it is what keeps the
   * five-minute poll pointed at a moving target and the Live chip meaningful.
   * Stepping onto today collapses back to null rather than pinning today's own
   * date, so there is exactly one representation of now and a pinned today
   * cannot drift from the rolling one.
   */
  date: string | null;
  /**
   * True once the reader has chosen a zone for themselves, including choosing
   * to close one. The view opens on a zone so the panel is not empty, and this
   * is what stops that default from re-applying itself over a deliberate
   * dismissal.
   */
  touched: boolean;
  /**
   * True once the reader has moved the timeline themselves, by scrubbing or by
   * playing it. The view follows the server's clock until then; afterwards a
   * refetch landing in a new hour must not drag them off what they are reading.
   */
  hourPinned: boolean;
  hour: number;
  /**
   * Whether the hour on screen arrived by a step worth animating.
   *
   * The map eases its colours and its numbers from one hour to the next, and
   * this is the only thing that can tell it when to. A play tick or a single
   * step is a move between neighbouring hours and reads well eased; a drag
   * along the timeline is the reader steering, and a tween there only lags the
   * knob. Everything else — adopting the server's clock, jumping back to Live —
   * is a jump rather than a step, and cuts.
   */
  hourEases: boolean;
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
  '1h': 1,
  '3h': 3,
};

/**
 * Whether two hours are close enough that moving between them is a step.
 *
 * The largest deliberate step is a 3h play tick, and the day is a ring, so 23
 * to 0 is one hour apart and not twenty-three. Anything further is a jump —
 * a click far down the timeline, or the clock being adopted — and cuts.
 */
function neighbouring(from: number, to: number): boolean {
  const gap = Math.abs(to - from);
  return Math.min(gap, 24 - gap) <= STEP_HOURS['3h'];
}

export function initialState(currentHour = 12, code: string | null = null): LivingGridState {
  return {
    code,
    date: null,
    touched: false,
    hourPinned: false,
    hour: Math.max(0, Math.min(23, currentHour)),
    // The first paint has nothing to ease from.
    hourEases: false,
    playing: false,
    step: STEPS.indexOf('1h'),
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
  | { type: 'PICK_ZONE'; code: string | null; opening?: boolean }
  // `adopting` is the view taking the server's clock, not the reader choosing
  // an hour — the same distinction `opening` draws for the zone panel.
  // `via: 'drag'` marks a pointer scrub, which snaps rather than eases: the
  // reader is steering, and a tween chasing them only trails the knob.
  | { type: 'SET_HOUR'; hour: number; adopting?: boolean; via?: 'drag' | 'step' }
  // The reader handing the timeline back to the clock. Distinct from SET_HOUR
  // because it is the only thing that CLEARS the pin — and now the day too.
  | { type: 'GO_LIVE'; hour: number }
  // `today` comes from the payload's own `meta.today`, which the server sends
  // on every response whatever date it describes. The reducer stays pure and
  // the reach is measured against the server's clock, not the viewer's.
  | { type: 'STEP_DAY'; delta: number; today: string }
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
        // A view switch changes what the colours mean, not which hour they
        // describe. Easing between two palettes would blend a net position
        // into a price and pass through colours that say neither.
        hourEases: false,
      };
    }

    case 'SET_PANEL_TAB':
      return { ...state, ptab: action.ptab };

    case 'SET_COLOUR_BY':
      // Same reason as SET_VIEW: the basis changes, not the hour.
      return { ...state, colourBy: action.colourBy, hourEases: false };

    case 'PICK_ZONE':
      // `opening` is the view filling the panel on first load; only a real
      // choice marks the selection as the reader's.
      return { ...state, code: action.code, touched: state.touched || !action.opening };

    case 'SET_HOUR': {
      // Stays first and separate from the guard below: a pinned reader is never
      // moved by an adopting dispatch, whatever hour it carries.
      if (action.adopting && state.hourPinned) return state;
      const hour = Math.max(0, Math.min(23, Math.round(action.hour)));
      const hourPinned = state.hourPinned || !action.adopting;
      // A drag dispatches at pointer resolution but resolves to whole hours, so
      // most of its dispatches ask for the hour already on screen. Handing back
      // the same reference makes React skip the subtree — and spares the map
      // element a field rebuild that costs hundreds of milliseconds.
      if (hour === state.hour && hourPinned === state.hourPinned) return state;
      // Adopting the clock can land anywhere, and a drag is the reader
      // steering; only a deliberate step between neighbouring hours eases.
      const hourEases = !action.adopting && action.via !== 'drag' && neighbouring(state.hour, hour);
      return { ...state, hour, hourPinned, hourEases };
    }

    case 'GO_LIVE': {
      // Clearing the pin is the whole point. Expressing this as a SET_HOUR
      // would set one instead — the reader is moving the timeline, as far as
      // that case can tell — and every later adopting dispatch would be
      // discarded, so pressing Live would end liveness until a reload.
      //
      // Clearing `date` matters as much: now is a day as well as an hour, and
      // this is the single "put me back on it" action. The button is never
      // disabled, so it is also the only way back from a day that has nothing
      // on it to say.
      const hour = Math.max(0, Math.min(23, Math.round(action.hour)));
      // Already live: hand back the same reference so React skips the subtree,
      // exactly as SET_HOUR does for a scrub landing on the hour on screen.
      // That is what makes an always-enabled button free to press twice.
      if (state.date === null && state.hour === hour && !state.hourPinned && !state.playing) {
        return state;
      }
      return {
        ...state,
        date: null,
        hour,
        hourPinned: false,
        // Live is a jump to now, which can be most of a day away. Easing across
        // that would be a long slow wipe through hours nobody asked to see.
        hourEases: false,
        playing: false,
      };
    }

    case 'STEP_DAY': {
      // The step's origin is the pinned day, or today when nothing is pinned.
      // Never the payload's date: while a step is in flight the payload in
      // hand is still the previous day's, and stepping from it would stall.
      const from = state.date ?? action.today;
      const target = shiftDate(from, action.delta);
      // Refuse rather than clamp. The arrow offering this step is already
      // disabled at the bound, so a clamp here could only silently swallow a
      // held key and make the control feel stuck rather than stopped.
      if (!withinReach(target, action.today)) return state;
      // `hour`, `hourPinned` and `code` are deliberately untouched: reading the
      // same hour, and the same country, across two days is the whole point of
      // the control. Leaving `hourPinned` alone also means a reader who never
      // scrubbed still lands on the current hour when they step back onto
      // today, while one who did keeps the hour they chose.
      return {
        ...state,
        // One representation of now, so `date === null` alone answers "is this
        // the live day" everywhere downstream.
        date: target === action.today ? null : target,
        // A day change swaps the whole dataset under the same hour. Easing
        // would cross-fade one day's colours into another's, which describes
        // no hour that ever happened — the same reason SET_VIEW cuts.
        hourEases: false,
        // The payload is about to change under the play loop.
        playing: false,
      };
    }

    case 'PLAY':
      return { ...state, playing: true };

    case 'PAUSE':
      return { ...state, playing: false };

    case 'TOGGLE_PLAY':
      return { ...state, playing: !state.playing };

    case 'TICK':
      return {
        ...state,
        hour: (state.hour + STEP_HOURS[STEPS[state.step]]) % 24,
        hourPinned: true,
        // The whole reason the tween exists: playback is a sequence of steps,
        // and it is what makes the day read as one movement rather than a
        // slideshow. True even across the midnight wrap — 23 to 0 is a step.
        hourEases: true,
      };

    case 'CYCLE_STEP':
      return { ...state, step: (state.step + 1) % STEPS.length };

    case 'SET_QUERY': {
      const match = matchZone(action.query, action.codes);
      // A zone reached by typing its name is as much the reader's choice as one
      // reached by clicking it — without `touched` the opening-zone default was
      // still allowed to override a searched selection.
      return {
        ...state,
        query: action.query,
        code: match ?? state.code,
        touched: state.touched || match !== null,
      };
    }

    case 'TOGGLE_LAYER':
      return { ...state, L: { ...state.L, [action.key]: !state.L[action.key] } };

    case 'TOGGLE_VIZ':
      return { ...state, V: { ...state.V, [action.key]: !state.V[action.key] } };

    default:
      return state;
  }
}
