import { describe, it, expect } from 'vitest';
import {
  initialState,
  livingGridReducer,
  STEP_HOURS,
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

describe('whether an hour change eases', () => {
  // The map eases its colours and its numbers between hours, and `hourEases`
  // is the only thing that tells it when. Getting this wrong is visible: a
  // tween chasing a drag trails the knob, and a tween across a jump wipes
  // slowly through hours nobody asked to see.

  it('eases a play tick, which is what the tween is for', () => {
    expect(run(initialState(12), { type: 'TICK' }).hourEases).toBe(true);
  });

  it('eases a tick across midnight — 23 to 0 is a step, not a jump', () => {
    expect(run(initialState(23), { type: 'TICK' }).hourEases).toBe(true);
  });

  it('eases a single step to a neighbouring hour', () => {
    expect(run(initialState(12), { type: 'SET_HOUR', hour: 13 }).hourEases).toBe(true);
    expect(run(initialState(0), { type: 'SET_HOUR', hour: 23 }).hourEases).toBe(true);
  });

  it('snaps a drag, so the map tracks the knob rather than trailing it', () => {
    expect(run(initialState(12), { type: 'SET_HOUR', hour: 13, via: 'drag' }).hourEases).toBe(false);
  });

  it('snaps a jump far down the timeline', () => {
    expect(run(initialState(3), { type: 'SET_HOUR', hour: 19 }).hourEases).toBe(false);
  });

  it('snaps the view adopting the server clock', () => {
    expect(
      run(initialState(12), { type: 'SET_HOUR', hour: 13, adopting: true }).hourEases,
    ).toBe(false);
  });

  it('snaps back to Live, which can be most of a day away', () => {
    const played = run(initialState(3), { type: 'TICK' });
    expect(played.hourEases).toBe(true);
    expect(run(played, { type: 'GO_LIVE', hour: 20 }).hourEases).toBe(false);
  });

  it('snaps a view switch — the palette changes, not the hour', () => {
    // Easing from a net-position colour into a price colour would pass through
    // colours that describe neither.
    const played = run(initialState(12), { type: 'TICK' });
    expect(run(played, { type: 'SET_VIEW', tab: 'Prices' }).hourEases).toBe(false);
    expect(run(played, { type: 'SET_COLOUR_BY', colourBy: 'price' }).hourEases).toBe(false);
  });

  it('has nothing to ease from on the first paint', () => {
    expect(initialState(12).hourEases).toBe(false);
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
    // one cycle from the default '1h' is '3h'.
    const stepped = run(initialState(10), { type: 'CYCLE_STEP' }, { type: 'TICK' });

    expect(STEPS[stepped.step]).toBe('3h');
    expect(stepped.hour).toBe(13);
  });

  it('wraps a 3h step across midnight without overshooting', () => {
    const s = run(initialState(23), { type: 'CYCLE_STEP' }, { type: 'TICK' });

    expect(s.hour).toBe(2);
  });

  it('adopts the server clock while the reader has not moved the timeline', () => {
    expect(run(initialState(12), { type: 'SET_HOUR', hour: 15, adopting: true }).hour).toBe(15);
  });

  it('stops adopting the server clock once the reader has scrubbed', () => {
    // A refetch landing in a new clock hour must not yank a reader who is
    // inspecting 03:00 back to now.
    const scrubbed = run(initialState(12), { type: 'SET_HOUR', hour: 3 });

    expect(run(scrubbed, { type: 'SET_HOUR', hour: 16, adopting: true }).hour).toBe(3);
  });

  it('stops adopting the server clock once playback has moved the hour', () => {
    const played = run(initialState(12), { type: 'TICK' });

    expect(run(played, { type: 'SET_HOUR', hour: 16, adopting: true }).hour).toBe(13);
  });

  it('adopts the server clock again once the reader asks to go live', () => {
    // Going live is the reader handing the timeline back to the clock, so it
    // has to CLEAR the pin. Reaching it through a plain SET_HOUR would set one
    // instead, and the button named Live would be the one thing that ends
    // liveness for the rest of the session.
    const scrubbed = run(initialState(12), { type: 'SET_HOUR', hour: 3 });
    const live = run(scrubbed, { type: 'GO_LIVE', hour: 14 });

    expect(live.hour).toBe(14);
    expect(run(live, { type: 'SET_HOUR', hour: 15, adopting: true }).hour).toBe(15);
  });

  it('stops playback when the reader goes live', () => {
    const playing = run(initialState(12), { type: 'PLAY' });

    expect(run(playing, { type: 'GO_LIVE', hour: 14 }).playing).toBe(false);
  });

  it('returns the same state when a scrub lands on the hour already showing', () => {
    // A drag dispatches at pointer resolution but resolves to whole hours, so
    // most of its dispatches ask for the hour already on screen. The identical
    // reference is the point: React skips the subtree, and the map element is
    // spared a field rebuild measured in hundreds of milliseconds.
    const scrubbed = run(initialState(12), { type: 'SET_HOUR', hour: 3 });

    expect(run(scrubbed, { type: 'SET_HOUR', hour: 3 })).toBe(scrubbed);
    expect(run(scrubbed, { type: 'SET_HOUR', hour: 3.4 })).toBe(scrubbed);
  });

  it('marks a zone found through search as the reader\'s own choice', () => {
    // Typing a country name is as deliberate as clicking it. Without `touched`
    // the state still claims the reader never chose, and the opening-zone
    // default is allowed to override the searched selection.
    const searched = run(initialState(12), { type: 'SET_QUERY', query: 'fr', codes: ['FR', 'DE'] });

    expect(searched.code).toBe('FR');
    expect(searched.touched).toBe(true);
  });

  it('does not claim a choice for a search that matched nothing', () => {
    const missed = run(initialState(12), { type: 'SET_QUERY', query: 'zz', codes: ['FR', 'DE'] });

    expect(missed.touched).toBe(false);
  });

  it('still pins the hour when the reader first taps the one already showing', () => {
    // Same hour, but `hourPinned` goes false -> true, so this is a real change
    // and must not be swallowed by the guard above.
    const fresh = initialState(12);
    const tapped = run(fresh, { type: 'SET_HOUR', hour: 12 });

    expect(tapped).not.toBe(fresh);
    expect(tapped.hourPinned).toBe(true);
    expect(run(tapped, { type: 'SET_HOUR', hour: 16, adopting: true }).hour).toBe(12);
  });

  it('offers no two steps that advance the timeline by the same amount', () => {
    // A step the payload cannot serve is a chip that changes its label and
    // nothing else. The series is hourly, so every offered step must differ.
    const advances = STEPS.map((s) => STEP_HOURS[s]);

    expect(new Set(advances).size).toBe(advances.length);
  });

  it('cycles the step setting back round', () => {
    let s = initialState();
    expect(STEPS[s.step]).toBe('1h');
    s = run(s, { type: 'CYCLE_STEP' });
    expect(STEPS[s.step]).toBe('3h');
    s = run(s, { type: 'CYCLE_STEP' });
    expect(STEPS[s.step]).toBe('1h');
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

  it('marks the selection as the reader own once they choose', () => {
    expect(initialState().touched).toBe(false);
    expect(run(initialState(), { type: 'PICK_ZONE', code: 'FR' }).touched).toBe(true);
  });

  it('does not mark the view opening on a zone as a choice', () => {
    // The view fills the panel on load; that must not count, or the default
    // could never be distinguished from a click.
    expect(run(initialState(), { type: 'PICK_ZONE', code: 'BE', opening: true }).touched).toBe(false);
  });

  it('treats closing the panel as a choice, so the default does not return', () => {
    const s = run(
      initialState(),
      { type: 'PICK_ZONE', code: 'BE', opening: true },
      { type: 'PICK_ZONE', code: null },
    );

    expect(s.code).toBeNull();
    expect(s.touched).toBe(true);
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

describe('stepping days', () => {
  const TODAY = '2026-09-19';
  const step = (state: LivingGridState, delta: number) =>
    run(state, { type: 'STEP_DAY', delta, today: TODAY });

  it('opens on the rolling today rather than on a pinned date', () => {
    expect(initialState().date).toBeNull();
  });

  it('steps forward and back from today', () => {
    expect(step(initialState(), 1).date).toBe('2026-09-20');
    expect(step(initialState(), -1).date).toBe('2026-09-18');
  });

  it('steps from the pinned day, not from today', () => {
    const s = step(step(step(initialState(), 1), 1), 1);

    expect(s.date).toBe('2026-09-22');
  });

  /**
   * One representation of now. A pinned '2026-09-19' would look like a chosen
   * day to everything downstream — the poll would stop and the Live chip would
   * go dark on the live day.
   */
  it('collapses back to null when a step lands on today', () => {
    const s = step(step(initialState(), 1), -1);

    expect(s.date).toBeNull();
  });

  it('reaches exactly seven days either side', () => {
    let forward = initialState();
    for (let i = 0; i < 7; i++) forward = step(forward, 1);
    expect(forward.date).toBe('2026-09-26');

    let back = initialState();
    for (let i = 0; i < 7; i++) back = step(back, -1);
    expect(back.date).toBe('2026-09-12');
  });

  it('refuses the step past the bound, returning the same reference', () => {
    let s = initialState();
    for (let i = 0; i < 7; i++) s = step(s, 1);

    expect(step(s, 1)).toBe(s);
    expect(step(s, -1).date).toBe('2026-09-25');
  });

  it('keeps the hour, the pin and the selected zone across a day', () => {
    const chosen = run(
      initialState(),
      { type: 'SET_HOUR', hour: 6 },
      { type: 'PICK_ZONE', code: 'FR' },
    );
    const s = step(chosen, 1);

    expect(s.hour).toBe(6);
    expect(s.hourPinned).toBe(true);
    expect(s.code).toBe('FR');
  });

  it('cuts rather than eases — two days are not neighbouring hours', () => {
    const eased = run(initialState(12), { type: 'SET_HOUR', hour: 13 });
    expect(eased.hourEases).toBe(true);

    expect(step(eased, 1).hourEases).toBe(false);
  });

  it('stops playback, because the payload is about to change under it', () => {
    const playing = run(initialState(), { type: 'PLAY' });

    expect(step(playing, 1).playing).toBe(false);
  });
});

describe('GO_LIVE and the day', () => {
  it('clears the pinned day as well as the hour pin', () => {
    const away = run(
      initialState(12),
      { type: 'STEP_DAY', delta: 3, today: '2026-09-19' },
      { type: 'SET_HOUR', hour: 4 },
    );
    expect(away.date).toBe('2026-09-22');

    const home = run(away, { type: 'GO_LIVE', hour: 14 });

    expect(home.date).toBeNull();
    expect(home.hour).toBe(14);
    expect(home.hourPinned).toBe(false);
  });

  /**
   * The button is never disabled now, so pressing it while already live must
   * be free — otherwise every press rebuilds the map's whole field.
   */
  it('returns the same reference when already live', () => {
    const live = initialState(14);

    expect(livingGridReducer(live, { type: 'GO_LIVE', hour: 14 })).toBe(live);
  });

  it('still moves when only the hour differs', () => {
    const scrubbed = run(initialState(14), { type: 'SET_HOUR', hour: 3 });

    expect(livingGridReducer(scrubbed, { type: 'GO_LIVE', hour: 14 }).hour).toBe(14);
  });
});
