import { useEffect, useMemo, useReducer } from 'react';
import { useGridDay } from '@/hooks/useGridDay';
import { useMediaQuery } from '@/lib/utils';
import { GridHeader } from '@/living-grid/components/GridHeader';
import { LeftRail } from '@/living-grid/components/LeftRail';
import { MapStage } from '@/living-grid/components/MapStage';
import { FooterTimeline } from '@/living-grid/components/FooterTimeline';
import { ZonePanel } from '@/living-grid/components/ZonePanel';
import { ZoneSections } from '@/living-grid/components/ZoneSections';
import { buildMapAttrs, netScaleTop } from '@/living-grid/logic/mapAttrs';
import { initialState, livingGridReducer } from '@/living-grid/logic/livingGridState';
import { resolveNetSeries } from '@/living-grid/logic/netFromFlows';
import { describeGridError } from '@/living-grid/logic/gridError';
import { openingZone, ZONES } from '@/living-grid/logic/zoneRegistry';
import '@/living-grid/plex-fonts.css';
import '@/living-grid/living-grid.css';

/** How long one hour lasts while the timeline plays. */
const PLAY_INTERVAL_MS = 900;

export default function LivingGridView() {
  const { data: day, isLoading, isError, error, refetch } = useGridDay();
  const [state, dispatch] = useReducer(livingGridReducer, undefined, () => initialState());

  // The server knows what hour it is where the data lives; adopt it so the
  // timeline opens on "now" rather than on noon, and keeps up with the clock
  // as the poll brings newer payloads. `adopting` makes the reducer drop this
  // the moment the reader scrubs or plays, so it cannot pull them off an hour
  // they are reading.
  const currentHour = day?.meta.currentHour ?? 12;
  const isToday = day?.meta.isToday ?? false;
  useEffect(() => {
    if (day?.meta.isToday) {
      dispatch({ type: 'SET_HOUR', hour: day.meta.currentHour, adopting: true });
    }
  }, [day?.meta.isToday, day?.meta.currentHour]);

  // Open on a zone rather than on an empty third of the screen, as the design
  // does. Only before the reader has chosen for themselves — `openingZone`
  // returns null once anything is selected, so this cannot fight a click or
  // re-select a zone the reader has just closed.
  const opening = day && state.code === null && !state.touched ? openingZone(day) : null;
  useEffect(() => {
    if (opening) dispatch({ type: 'PICK_ZONE', code: opening, opening: true });
  }, [opening]);

  useEffect(() => {
    if (!state.playing) return;
    const timer = window.setInterval(() => dispatch({ type: 'TICK' }), PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [state.playing]);

  // Reduced motion skips the panel's entry animation outright rather than
  // slowing it, as the splash spinner does: a spinner that turns more slowly is
  // still a spinner, but a panel-wide draw-on is exactly the kind of motion the
  // setting exists to refuse.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  // Depends on the six fields `buildMapAttrs` actually reads, not on the whole
  // state object. The reducer returns a new object for nearly every action, so
  // `[state, day]` rebuilt 28 zones and re-serialised six JSON blobs when the
  // reader typed in the search box or switched panel tab. `state.L` and
  // `state.V` are safe to name here because `{ ...state }` copies their
  // references — they only change identity when a toggle or a view preset
  // actually replaces them.
  const attrs = useMemo(
    () => buildMapAttrs(state, day),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.hour, state.tab, state.colourBy, state.code, state.L, state.V, day],
  );

  const availableCodes = useMemo(
    () => (day ? ZONES.map((z) => z.code).filter((c) => day.zones[c] !== undefined) : []),
    [day],
  );

  // Legend extents are read off the hour on screen, so the scale describes
  // this map rather than a fixed range the data may never reach. The net
  // legend prints the ramp's saturation point, not the hour's largest zone:
  // the fill stops brightening well below the maximum, so labelling the
  // maximum would describe a gradient the map never draws.
  const { priceRange, netExtent } = useMemo(() => {
    if (!day) return { priceRange: null, netExtent: null };
    const prices: number[] = [];
    const nets: number[] = [];
    for (const code of availableCodes) {
      const price = day.zones[code]?.price[state.hour];
      if (price !== null && price !== undefined) prices.push(price);
      const net = resolveNetSeries(day, code).series[state.hour];
      if (net !== null && net !== undefined) nets.push(Math.abs(net));
    }
    return {
      priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      netExtent: nets.length ? netScaleTop(nets) : null,
    };
  }, [day, availableCodes, state.hour]);

  if (isLoading) {
    return (
      <div className="lg-splash">
        <div className="lg-spinner" />
        <div style={{ font: "400 12.5px 'IBM Plex Mono', monospace", color: '#5D7688', letterSpacing: '0.16em' }}>
          LOADING THE GRID
        </div>
      </div>
    );
  }

  if (isError || !day) {
    return (
      <div className="lg-splash">
        <div style={{ font: "400 15px 'IBM Plex Sans'", color: '#DCEEF5' }}>
          The grid data could not be loaded.
        </div>
        <div style={{ font: "400 12px 'IBM Plex Sans'", color: '#6E8A9C', maxWidth: 420, textAlign: 'center' }}>
          {describeGridError(error)}
        </div>
        <button type="button" className="lg-chip-button" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="living-grid">
      <GridHeader
        tab={state.tab}
        onTab={(tab) => dispatch({ type: 'SET_VIEW', tab })}
        query={state.query}
        onQuery={(query) => dispatch({ type: 'SET_QUERY', query, codes: availableCodes })}
        date={day.meta.date}
        hour={state.hour}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <LeftRail
          colourBy={state.colourBy}
          onColourBy={(colourBy) => dispatch({ type: 'SET_COLOUR_BY', colourBy })}
          layers={state.L}
          onLayer={(key) => dispatch({ type: 'TOGGLE_LAYER', key })}
          viz={state.V}
          onViz={(key) => dispatch({ type: 'TOGGLE_VIZ', key })}
        />

        <MapStage
          attrs={attrs}
          tab={state.tab}
          priceRange={priceRange}
          netExtent={netExtent}
          onPick={(code) => dispatch({ type: 'PICK_ZONE', code })}
          onFlows={() => undefined}
        />

        {/*
          Keyed on the zone code alone, so picking a country remounts the panel
          and its entry animation runs again. Without a key React reconciles the
          same `<aside>` in place and the animation would fire once, on the
          first zone ever opened. The key must NOT include `ptab` or `hour`:
          those change while a zone stays selected, and replaying a 500ms draw
          on every timeline tick is the opposite of what this is for. Remounting
          also resets the panel's scroll, which is wanted — a new country is
          read from the top.
        */}
        <ZonePanel
          key={state.code ?? 'none'}
          day={day}
          code={state.code}
          hour={state.hour}
          ptab={state.ptab}
          onPanelTab={(ptab) => dispatch({ type: 'SET_PANEL_TAB', ptab })}
          onClose={() => dispatch({ type: 'PICK_ZONE', code: null })}
        >
          {state.code && (
            <ZoneSections
              day={day}
              code={state.code}
              hour={state.hour}
              ptab={state.ptab}
              onHour={(hour) => dispatch({ type: 'SET_HOUR', hour })}
              onPick={(code) => dispatch({ type: 'PICK_ZONE', code })}
              reduced={reducedMotion}
            />
          )}
        </ZonePanel>
      </div>

      <FooterTimeline
        hour={state.hour}
        playing={state.playing}
        step={state.step}
        date={day.meta.date}
        currentHour={currentHour}
        isToday={isToday}
        onHour={(hour, via) => dispatch({ type: 'SET_HOUR', hour, via })}
        onTogglePlay={() => dispatch({ type: 'TOGGLE_PLAY' })}
        onCycleStep={() => dispatch({ type: 'CYCLE_STEP' })}
        onLive={() => dispatch({ type: 'GO_LIVE', hour: currentHour })}
      />
    </div>
  );
}
