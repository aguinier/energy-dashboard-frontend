import { describe, it, expect } from 'vitest';
import { NET_POSITION_MODEL_COLORS, netPositionModelColor } from './netPositionModelColors';

// Mirrors the ids `server/src/config/forecastModels.ts` registers for
// `net_position` (production chronos-2-V010 plus three shadow candidates).
// Not imported directly — the client can't reach across into the server
// workspace's `src` (outside its own tsconfig `include`) — so this list is
// duplicated knowledge, same as `dashboard/generationSeries.ts`'s
// `WIRE_FIELD` duplicates the server's column grouping. Keep it in step with
// the registry by hand if a model is ever added or removed there.
const REGISTERED_NET_POSITION_MODEL_IDS = [
  'chronos-2-V010',
  'baseline-V012',
  'xgboost-V014',
  'chronos-2-V016',
];

describe('NET_POSITION_MODEL_COLORS', () => {
  it('has an entry for every model the server registers for net_position', () => {
    for (const id of REGISTERED_NET_POSITION_MODEL_IDS) {
      expect(NET_POSITION_MODEL_COLORS[id]).toBeDefined();
    }
  });

  it('assigns a distinct colour to every model — no two share one', () => {
    const colors = Object.values(NET_POSITION_MODEL_COLORS);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('never assigns the house primary teal — that colour already means "actual"', () => {
    expect(Object.values(NET_POSITION_MODEL_COLORS)).not.toContain('#1F6B5C');
  });
});

describe('netPositionModelColor', () => {
  it('returns the registered colour for a known id', () => {
    expect(netPositionModelColor('chronos-2-V010')).toBe('#2a78d6');
  });

  it('falls back to a neutral colour for an unregistered id, never throwing', () => {
    expect(() => netPositionModelColor('some-future-model')).not.toThrow();
    expect(netPositionModelColor('some-future-model')).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
