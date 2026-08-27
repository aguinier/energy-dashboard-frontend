import { describe, it, expect } from 'vitest';
import { evaluateAlerts, EMPTY_ALERT_STATE, type AlertState, type RecordedState } from './opsAlertEngine.js';
import type { AlertObservation } from './opsAlertRules.js';
import type { ThresholdState } from './opsStatusThresholds.js';

const NOW = new Date('2026-08-12T12:36:00.000Z');

function obs(
  key: string,
  state: ThresholdState,
  overrides: Partial<AlertObservation> = {},
): AlertObservation {
  return {
    key,
    lane: 'local',
    kpi: 'disk',
    state,
    detail: `${key} is ${state}`,
    blackoutSensitive: false,
    ...overrides,
  };
}

function stateWith(key: string, state: RecordedState, firedAt = '2026-08-12T00:00:00.000Z'): AlertState {
  return { version: 1, entries: [{ key, state, firedAt }] };
}

function evaluate(observations: AlertObservation[], previous: AlertState, blackoutActive = false) {
  return evaluateAlerts(observations, previous, { now: NOW, blackoutActive });
}

describe('evaluateAlerts — first run', () => {
  it('fires for a KPI already in breach when there is no prior state (the boot-into-a-breached-world case)', () => {
    // The live case this rule exists for: acceptance disk at 85.11% and
    // freshness stale on both lanes at the moment the engine first runs.
    const { notifications, state } = evaluate(
      [
        obs('local:disk', 'warn'),
        obs('local:freshness', 'warn', { kpi: 'freshness' }),
      ],
      EMPTY_ALERT_STATE,
    );

    expect(notifications).toHaveLength(2);
    expect(notifications.map((n) => n.kind)).toEqual(['breach', 'breach']);
    expect(notifications.map((n) => n.previousState)).toEqual([null, null]);
    expect(state.entries).toEqual([
      { key: 'local:disk', state: 'warn', firedAt: NOW.toISOString() },
      { key: 'local:freshness', state: 'warn', firedAt: NOW.toISOString() },
    ]);
  });

  it('does not fire a second time on an identical follow-up evaluation', () => {
    const first = evaluate([obs('local:disk', 'warn')], EMPTY_ALERT_STATE);
    const second = evaluate([obs('local:disk', 'warn')], first.state);

    expect(first.notifications).toHaveLength(1);
    expect(second.notifications).toEqual([]);
  });

  it('records a first-run ok silently, so the next breach still reads as a transition', () => {
    const first = evaluate([obs('local:disk', 'ok')], EMPTY_ALERT_STATE);
    expect(first.notifications).toEqual([]);
    expect(first.state.entries).toEqual([
      { key: 'local:disk', state: 'ok', firedAt: NOW.toISOString() },
    ]);

    const second = evaluate([obs('local:disk', 'error')], first.state);
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0]).toMatchObject({ kind: 'breach', previousState: 'ok', state: 'error' });
  });

  it('fires on first run for error just as it does for warn', () => {
    const { notifications } = evaluate([obs('local:disk', 'error')], EMPTY_ALERT_STATE);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind: 'breach', severity: 'error', previousState: null });
  });
});

describe('evaluateAlerts — transitions', () => {
  const cases: Array<[RecordedState, RecordedState, string, string]> = [
    ['ok', 'warn', 'breach', 'warn'],
    ['ok', 'error', 'breach', 'error'],
    ['warn', 'error', 'escalation', 'error'],
    ['error', 'warn', 'improvement', 'warn'],
    ['warn', 'ok', 'recovery', 'info'],
    ['error', 'ok', 'recovery', 'info'],
  ];

  it.each(cases)('%s -> %s fires a %s at severity %s', (from, to, kind, severity) => {
    const { notifications } = evaluate([obs('local:disk', to)], stateWith('local:disk', from));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kind, severity, previousState: from, state: to });
  });

  it.each(['ok', 'warn', 'error'] as const)('%s -> %s is silent (de-duplication)', (state) => {
    const { notifications } = evaluate([obs('local:disk', state)], stateWith('local:disk', state));
    expect(notifications).toEqual([]);
  });

  it('leaves firedAt untouched when nothing changed — it records when we last spoke, not when we last looked', () => {
    const previous = stateWith('local:disk', 'warn', '2026-08-01T09:00:00.000Z');
    const { state } = evaluate([obs('local:disk', 'warn')], previous);
    expect(state.entries[0].firedAt).toBe('2026-08-01T09:00:00.000Z');
  });

  it('carries the observation detail into the notification as the evidence', () => {
    const observation = obs('local:disk', 'warn', {
      detail: '91.58% of disk used, 156.8 GiB free (warn; warn at >=75% used with <=250 GiB free, error at >=90% with <=100 GiB free)',
    });
    const { notifications } = evaluate([observation], stateWith('local:disk', 'ok'));
    expect(notifications[0].detail).toBe('91.58% of disk used, 156.8 GiB free (warn; warn at >=75% used with <=250 GiB free, error at >=90% with <=100 GiB free)');
    expect(notifications[0].observedAt).toBe(NOW.toISOString());
  });

  it('a sustained breach stays silent across many ticks', () => {
    let state = EMPTY_ALERT_STATE;
    const fired: number[] = [];
    for (let tick = 0; tick < 12; tick += 1) {
      const result = evaluate([obs('local:disk', 'error')], state);
      fired.push(result.notifications.length);
      state = result.state;
    }
    // One notification on the first tick, then twelve hours of silence.
    expect(fired).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('evaluateAlerts — the unknown rule', () => {
  it('never fires on unknown and never records it', () => {
    const { notifications, state } = evaluate([obs('local:disk', 'unknown')], EMPTY_ALERT_STATE);
    expect(notifications).toEqual([]);
    expect(state.entries).toEqual([]);
  });

  it('does not treat unknown as a recovery from warn', () => {
    const { notifications, state } = evaluate(
      [obs('local:disk', 'unknown')],
      stateWith('local:disk', 'warn'),
    );
    expect(notifications).toEqual([]);
    expect(state.entries).toEqual([
      { key: 'local:disk', state: 'warn', firedAt: '2026-08-12T00:00:00.000Z' },
    ]);
  });

  it('warn -> unmeasured -> warn stays silent (a measurement flicker must not re-page)', () => {
    const first = evaluate([obs('local:disk', 'warn')], EMPTY_ALERT_STATE);
    const gap = evaluate([obs('local:disk', 'unknown')], first.state);
    const back = evaluate([obs('local:disk', 'warn')], gap.state);

    expect(first.notifications).toHaveLength(1);
    expect(gap.notifications).toEqual([]);
    expect(back.notifications).toEqual([]);
  });

  it('warn -> unmeasured -> ok still fires exactly one recovery', () => {
    const first = evaluate([obs('local:disk', 'warn')], EMPTY_ALERT_STATE);
    const gap = evaluate([obs('local:disk', 'unknown')], first.state);
    const recovered = evaluate([obs('local:disk', 'ok')], gap.state);

    expect(recovered.notifications).toHaveLength(1);
    expect(recovered.notifications[0]).toMatchObject({ kind: 'recovery', previousState: 'warn' });
  });
});

describe('evaluateAlerts — the ABL-220 sync blackout rule', () => {
  const freshness = obs('local:freshness', 'warn', { kpi: 'freshness', blackoutSensitive: true });
  const reachability = obs('local:reachability', 'error', {
    kpi: 'reachability',
    blackoutSensitive: true,
  });

  it('holds the database-backed KPIs inside the window instead of reporting an outage', () => {
    const { notifications, state } = evaluate([freshness, reachability], EMPTY_ALERT_STATE, true);
    expect(notifications).toEqual([]);
    expect(state.entries).toEqual([]);
  });

  it('still alerts on disk inside the window — disk does not go through the database', () => {
    const { notifications } = evaluate(
      [obs('local:disk', 'error'), freshness, reachability],
      EMPTY_ALERT_STATE,
      true,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ kpi: 'disk', kind: 'breach' });
  });

  it('does not emit a false recovery for a held KPI whose reading looks ok mid-window', () => {
    const previous = stateWith('local:freshness', 'warn');
    const { notifications, state } = evaluate(
      [obs('local:freshness', 'ok', { kpi: 'freshness', blackoutSensitive: true })],
      previous,
      true,
    );
    expect(notifications).toEqual([]);
    expect(state.entries).toEqual(previous.entries);
  });

  it('fires normally once the window closes', () => {
    const inside = evaluate([freshness], EMPTY_ALERT_STATE, true);
    const outside = evaluate([freshness], inside.state, false);
    expect(inside.notifications).toEqual([]);
    expect(outside.notifications).toHaveLength(1);
    expect(outside.notifications[0]).toMatchObject({ kind: 'breach', previousState: null });
  });
});

describe('evaluateAlerts — state hygiene', () => {
  it('drops entries for keys no longer observed rather than carrying orphans forever', () => {
    const previous: AlertState = {
      version: 1,
      entries: [
        { key: 'local:disk', state: 'warn', firedAt: '2026-08-01T00:00:00.000Z' },
        { key: 'retired:kpi', state: 'error', firedAt: '2026-08-01T00:00:00.000Z' },
      ],
    };
    const { state } = evaluate([obs('local:disk', 'warn')], previous);
    expect(state.entries.map((e) => e.key)).toEqual(['local:disk']);
  });

  it('always stamps the persisted record with version 1', () => {
    const { state } = evaluate([obs('local:disk', 'ok')], EMPTY_ALERT_STATE);
    expect(state.version).toBe(1);
  });

  it('handles several KPIs independently in one evaluation', () => {
    const previous: AlertState = {
      version: 1,
      entries: [
        { key: 'local:disk', state: 'warn', firedAt: '2026-08-01T00:00:00.000Z' },
        { key: 'peer:freshness', state: 'warn', firedAt: '2026-08-01T00:00:00.000Z' },
        { key: 'both:commitDrift', state: 'ok', firedAt: '2026-08-01T00:00:00.000Z' },
      ],
    };
    const { notifications } = evaluate(
      [
        obs('local:disk', 'error'), // escalation
        obs('peer:freshness', 'ok', { lane: 'peer', kpi: 'freshness' }), // recovery
        obs('both:commitDrift', 'warn', { lane: 'both', kpi: 'commitDrift' }), // breach
        obs('peer:disk', 'ok', { lane: 'peer' }), // silent first-run ok
      ],
      previous,
    );

    expect(notifications.map((n) => [n.key, n.kind])).toEqual([
      ['local:disk', 'escalation'],
      ['peer:freshness', 'recovery'],
      ['both:commitDrift', 'breach'],
    ]);
  });
});
