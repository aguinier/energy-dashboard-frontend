import { describe, it, expect } from 'vitest';
import {
  isDesktopGeometry,
  narrowViewBoxHeight,
  selectMapGeometry,
  hoverCardClearsSelector,
  countryAriaLabel,
  DESKTOP_VIEWBOX,
  NARROW_VIEWBOX_WIDTH,
  NARROW_SCALE,
} from './mapGeometry';

// Review finding 1: the viewBox choice must be aspect-aware, not width-only.
describe('isDesktopGeometry (task-11 review finding 1)', () => {
  it('picks the narrow/portrait geometry for a wide-but-tall container (iPad Pro 12.9" portrait)', () => {
    // The exact regression the reviewer measured live: 1024x1366 took the
    // desktop branch under the old width-only gate and letterboxed to
    // 58%/43% ink.
    expect(isDesktopGeometry(1024, 1366)).toBe(false);
  });

  it('stays on the narrow geometry one pixel narrower, same as before', () => {
    expect(isDesktopGeometry(1023, 1366)).toBe(false);
  });

  it('picks desktop geometry for an ordinary landscape browser window at exactly the width gate', () => {
    // 1024x900 is also the width used in finding 2 — the map itself should
    // still be "desktop" there; only the hover card's position is buggy.
    expect(isDesktopGeometry(1024, 900)).toBe(true);
  });

  it('picks desktop geometry for wider ordinary landscape windows', () => {
    expect(isDesktopGeometry(1100, 900)).toBe(true);
    expect(isDesktopGeometry(1440, 900)).toBe(true);
  });

  it('never picks desktop geometry below the width gate, regardless of aspect', () => {
    expect(isDesktopGeometry(390, 200)).toBe(false); // landscape phone, still tiny
    expect(isDesktopGeometry(768, 1024)).toBe(false); // portrait tablet
  });

  it('treats a square container as landscape-enough (width >= height)', () => {
    expect(isDesktopGeometry(1200, 1200)).toBe(true);
  });
});

describe('narrowViewBoxHeight', () => {
  it('derives height from the measured container aspect, not a fixed number', () => {
    expect(narrowViewBoxHeight(390, 844)).toBe(Math.round(420 * (844 / 390)));
    expect(narrowViewBoxHeight(768, 1024)).toBe(Math.round(420 * (1024 / 768)));
  });

  it('falls back to the reference width instead of dividing by zero', () => {
    expect(narrowViewBoxHeight(0, 800)).toBe(NARROW_VIEWBOX_WIDTH);
  });
});

describe('selectMapGeometry', () => {
  it('reproduces the pre-existing 1440x900 desktop geometry byte-for-byte (must not regress)', () => {
    const g = selectMapGeometry(1440, 900, true);
    expect(g).toEqual({
      isDesktop: true,
      projectionScale: DESKTOP_VIEWBOX.scale,
      mapWidth: DESKTOP_VIEWBOX.width,
      mapHeight: DESKTOP_VIEWBOX.height,
    });
  });

  it('gives a portrait iPad Pro (1024x1366) the narrow, self-matching geometry', () => {
    const g = selectMapGeometry(1024, 1366, true);
    expect(g.isDesktop).toBe(false);
    expect(g.projectionScale).toBe(NARROW_SCALE);
    expect(g.mapWidth).toBe(NARROW_VIEWBOX_WIDTH);
    expect(g.mapHeight).toBe(narrowViewBoxHeight(1024, 1366));
  });

  it('gives an ordinary 1024x900 landscape window the desktop geometry', () => {
    const g = selectMapGeometry(1024, 900, true);
    expect(g.isDesktop).toBe(true);
    expect(g.projectionScale).toBe(DESKTOP_VIEWBOX.scale);
  });

  it('docked (non-fullScreen) mode ignores the desktop/narrow split for sizing, as before', () => {
    const g = selectMapGeometry(1024, 1366, false);
    expect(g.projectionScale).toBe(260);
    expect(g.mapWidth).toBe(DESKTOP_VIEWBOX.width);
    expect(g.mapHeight).toBe(420);
  });
});

// Review finding 2: the hover card must not snap to the corner before the
// centered floating selector actually has room for it.
describe('hoverCardClearsSelector (task-11 review finding 2)', () => {
  it('does not clear at 1024px — the measured ~57px x ~33.5px overlap case', () => {
    expect(hoverCardClearsSelector(1024)).toBe(false);
  });

  it('does not clear at 1100px either', () => {
    expect(hoverCardClearsSelector(1100)).toBe(false);
  });

  it('clears well before the 1440px desktop baseline', () => {
    expect(hoverCardClearsSelector(1440)).toBe(true);
  });

  it('the crossover sits close to the ~1150px the reviewer measured', () => {
    // Not clear just below, clear just above — anchors the derived
    // crossover to the reviewer's live measurement instead of drifting.
    expect(hoverCardClearsSelector(1140)).toBe(false);
    expect(hoverCardClearsSelector(1170)).toBe(true);
  });
});

// The map's only screen-reader-facing content per country — every
// `<Geography>` gets this as its `aria-label`. See the doc comment on
// countryAriaLabel for why the two branches (data / no data) exist.
describe('countryAriaLabel', () => {
  it('names the country, metric and value together for a country with data', () => {
    expect(countryAriaLabel('Germany', true, '58.0', 'GW', 'Electricity load')).toBe(
      'Germany, Electricity load: 58.0 GW',
    );
  });

  it('omits a trailing space when the unit is empty (e.g. a unitless share already in the value)', () => {
    expect(countryAriaLabel('France', true, '42', '', 'Renewable share')).toBe(
      'France, Renewable share: 42',
    );
  });

  it('says "no data" and drops the value/unit/metric entirely when the country has none', () => {
    expect(countryAriaLabel('Iceland', false, '58.0', 'GW', 'Electricity load')).toBe(
      'Iceland: no data',
    );
  });

  it('is stable across metrics with negative/signed values (net position)', () => {
    expect(countryAriaLabel('Belgium', true, '−2.1k', 'MW', 'Net position')).toBe(
      'Belgium, Net position: −2.1k MW',
    );
  });
});
