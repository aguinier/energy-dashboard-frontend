import { describe, it, expect } from 'vitest';
import {
  initialState,
  livingGridReducer,
  STEPS,
  VIEW_TABS,
  type LivingGridState,
} from './livingGridState';

const run = (state: LivingGridState, ...actions: Parameters<typeof livingGridReducer>[1][]) =>
  actions.reduce(livingGridReducer, state);

describe('initialState', () => {
  it('opens on the hour it is told, unselected and paused', () => {
    const s = initialState(14);

    expect(s).toMatchObject({ hour: 14, code: null, playing: false, tab: 'Balance', ptab: 'Overview' });
    expect(s.colourBy).toBe('net');
  });

  it('clamps an out-of-range hour', () => {
    expect(initialState(-3).hour).toBe(0);
    expect(initialState(99).hour).toBe(23);
  });
});

describe('SET_VIEW applies the whole preset in one update', () => {
  it('switches the map, the colour basis and the panel together', () => {
    // The point of one action: the map and the panel cannot end up describing
    // different things, which three separate dispatches would allow between
    // renders.
    const s = run(initialState(), { type: 'SET_VIEW', tab: 'Prices' });

    expect(s.tab).toBe('Prices');
    expect(s.colourBy).toBe('price');
    expect(s.ptab).toBe('Prices');
    expect(s.L.plants).toBe(false);
  });

  it('sends Generation to the mix tab and keeps plants on', () => {
    const s = run(initialState(), { type: 'SET_VIEW', tab: 'Generation' });

    expect(s).toMatchObject({ colourBy: 'net', ptab: 'Energy mix' });
    expect(s.L.plants).toBe(true);
  });

  it('turns the commercial layer on only for Market', () => {
    for (const tab of VIEW_TABS) {
      const s = run(initialState(), { type: 'SET_VIEW', tab });
      expect(s.L.commercial).toBe(tab === 'Market');
    }
  });

  it('forces labels and values back on', () => {
    // A view switch is a request to read the map; honouring it with a blank
    // one because the toggles were off earlier would be obtuse.
    const s = run(
      initialState(),
      { type: 'TOGGLE_VIZ', key: 'values' },
      { type: 'TOGGLE_VIZ', key: 'labels' },
      { type: 'SET_VIEW', tab: 'Market' },
    );

    expect(s.V.values).toBe(true);
    expect(s.V.labels).toBe(true);
  });

  it('leaves the other visualization toggles alone', () => {
    const s = run(
      initialState(),
      { type: 'TOGGLE_VIZ', key: 'glow' },
      { type: 'SET_VIEW', tab: 'Prices' },
    );

    expect(s.V.glow).toBe(false);
  });

  it('keeps the selected zone and hour across a view change', () => {
    const s = run(
      initialState(9),
      { type: 'PICK_ZONE', code: 'BE' },
      { type: 'SET_VIEW', tab: 'Generation' },
    );

    expect(s).toMatchObject({ code: 'BE', hour: 9 });
  });
});

describe('the hour', () => {
  it('clamps and rounds what it is given', () => {
    expect(run(initialState(), { type: 'SET_HOUR', hour: -4 }).hour).toBe(0);
    expect(run(initialState(), { type: 'SET_HOUR', hour: 40 }).hour).toBe(23);
    expect(run(initialState(), { type: 'SET_HOUR', hour: 7.6 }).hour).toBe(8);
  });

  it('advances one hour per tick and wraps past midnight', () => {
    expect(run(initialState(22), { type: 'TICK' }).hour).toBe(23);
    expect(run(initialState(23), { type: 'TICK' }).hour).toBe(0);
  });

  it('advances by the step size', () => {
    // step 2 is '3h'.
    const stepped = run(initialState(10), { type: 'CYCLE_STEP' }, { type: 'TICK' });

    expect(STEPS[stepped.step]).toBe('3h');
    expect(stepped.hour).toBe(13);
  });

  it('wraps a 3h step across midnight without overshooting', () => {
    const s = run(initialState(23), { type: 'CYCLE_STEP' }, { type: 'TICK' });

    expect(s.hour).toBe(2);
  });

  it('cycles the step setting back round', () => {
    let s = initialState();
    expect(STEPS[s.step]).toBe('1h');
    s = run(s, { type: 'CYCLE_STEP' });
    expect(STEPS[s.step]).toBe('3h');
    s = run(s, { type: 'CYCLE_STEP' });
    expect(STEPS[s.step]).toBe('15min');
  });
});

describe('playback', () => {
  it('toggles, plays and pauses', () => {
    expect(run(initialState(), { type: 'TOGGLE_PLAY' }).playing).toBe(true);
    expect(run(initialState(), { type: 'PLAY' }, { type: 'TOGGLE_PLAY' }).playing).toBe(false);
    expect(run(initialState(), { type: 'PLAY' }, { type: 'PAUSE' }).playing).toBe(false);
  });

  it('does not move the hour by itself', () => {
    expect(run(initialState(6), { type: 'PLAY' }).hour).toBe(6);
  });
});

describe('selection and search', () => {
  const codes = ['DE', 'FR', 'BE'];

  it('selects and clears a zone', () => {
    const picked = run(initialState(), { type: 'PICK_ZONE', code: 'FR' });
    expect(picked.code).toBe('FR');
    expect(run(picked, { type: 'PICK_ZONE', code: null }).code).toBeNull();
  });

  it('selects on a name prefix once two characters are typed', () => {
    const s = run(initialState(), { type: 'SET_QUERY', query: 'be', codes });

    expect(s.query).toBe('be');
    expect(s.code).toBe('BE');
  });

  it('keeps the current selection while the query is too short to mean anything', () => {
    const s = run(
      initialState(),
      { type: 'PICK_ZONE', code: 'DE' },
      { type: 'SET_QUERY', query: 'f', codes },
    );

    expect(s.code).toBe('DE');
    expect(s.query).toBe('f');
  });

  it('keeps the current selection when nothing matches', () => {
    const s = run(
      initialState(),
      { type: 'PICK_ZONE', code: 'DE' },
      { type: 'SET_QUERY', query: 'zzz', codes },
    );

    expect(s.code).toBe('DE');
  });
});

describe('toggles', () => {
  it('flips one layer without disturbing the others', () => {
    const before = initialState();
    const after = run(before, { type: 'TOGGLE_LAYER', key: 'grid' });

    expect(after.L.grid).toBe(!before.L.grid);
    expect(after.L.plants).toBe(before.L.plants);
    expect(after.L.flows).toBe(before.L.flows);
  });

  it('flips one visualization toggle without disturbing the others', () => {
    const after = run(initialState(), { type: 'TOGGLE_VIZ', key: 'borders' });

    expect(after.V.borders).toBe(true);
    expect(after.V.anim).toBe(true);
  });

  it('never mutates the state it was handed', () => {
    const before = initialState();
    const snapshot = JSON.stringify(before);
    run(before, { type: 'TOGGLE_LAYER', key: 'grid' }, { type: 'SET_VIEW', tab: 'Market' });

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('panel and colour basis', () => {
  it('sets the panel tab directly', () => {
    expect(run(initialState(), { type: 'SET_PANEL_TAB', ptab: 'Flows' }).ptab).toBe('Flows');
  });

  it('sets the colour basis without changing the view', () => {
    const s = run(initialState(), { type: 'SET_COLOUR_BY', colourBy: 'price' });

    expect(s.colourBy).toBe('price');
    expect(s.tab).toBe('Balance');
  });
});
