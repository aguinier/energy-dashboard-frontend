import { describe, it, expect } from 'vitest';
import { formatNotification, createLoggingChannel } from './opsAlertChannel.js';
import type { AlertNotification } from '../lib/opsAlertEngine.js';

function notification(overrides: Partial<AlertNotification> = {}): AlertNotification {
  return {
    key: 'local:disk',
    lane: 'local',
    kpi: 'disk',
    previousState: 'ok',
    state: 'warn',
    kind: 'breach',
    severity: 'warn',
    detail: '85.11% of disk used (warn; warn at 75%, error at 90%)',
    observedAt: '2026-08-12T12:36:00.000Z',
    ...overrides,
  };
}

describe('formatNotification', () => {
  it('carries the transition and the evidence that justified it', () => {
    expect(formatNotification(notification())).toBe(
      '[BREACH] disk on this environment: ok -> warn — 85.11% of disk used (warn; warn at 75%, error at 90%) (at 2026-08-12T12:36:00.000Z)',
    );
  });

  it('renders a first-run breach as coming from unknown', () => {
    expect(formatNotification(notification({ previousState: null }))).toContain('unknown -> warn');
  });

  it.each([
    ['breach', 'BREACH'],
    ['escalation', 'ESCALATION'],
    ['improvement', 'IMPROVED'],
    ['recovery', 'RECOVERED'],
  ] as const)('prefixes a %s as %s', (kind, prefix) => {
    expect(formatNotification(notification({ kind }))).toContain(`[${prefix}]`);
  });

  it('names the peer lane without guessing an environment name', () => {
    const line = formatNotification(notification({ lane: 'peer', kpi: 'reachability' }));
    expect(line).toContain('reachability on the peer environment');
    expect(line).not.toContain('acceptance');
    expect(line).not.toContain('prod');
  });

  it('names commit drift as spanning both environments', () => {
    expect(formatNotification(notification({ lane: 'both', kpi: 'commitDrift' }))).toContain(
      'commitDrift on both environments',
    );
  });
});

describe('createLoggingChannel', () => {
  function spyLogger() {
    const calls = { warn: [] as string[], error: [] as string[], log: [] as string[] };
    return {
      calls,
      logger: {
        warn: (m: string) => calls.warn.push(m),
        error: (m: string) => calls.error.push(m),
        log: (m: string) => calls.log.push(m),
      },
    };
  }

  it('routes by severity so an error transition reaches stderr', async () => {
    const { calls, logger } = spyLogger();
    await createLoggingChannel(logger).deliver([
      notification({ severity: 'error', state: 'error' }),
      notification({ severity: 'warn' }),
      notification({ severity: 'info', kind: 'recovery', state: 'ok' }),
    ]);

    expect(calls.error).toHaveLength(1);
    expect(calls.warn).toHaveLength(1);
    expect(calls.log).toHaveLength(1);
  });

  it('emits one line per notification', async () => {
    const { calls, logger } = spyLogger();
    await createLoggingChannel(logger).deliver([notification(), notification({ kpi: 'freshness' })]);
    expect(calls.warn).toHaveLength(2);
    expect(calls.warn[0]).toContain('[BREACH] disk');
    expect(calls.warn[1]).toContain('[BREACH] freshness');
  });

  it('does nothing when there is nothing to say', async () => {
    const { calls, logger } = spyLogger();
    await createLoggingChannel(logger).deliver([]);
    expect(calls).toEqual({ warn: [], error: [], log: [] });
  });

  it('identifies itself, so a delivery failure names the channel', () => {
    expect(createLoggingChannel().name).toBe('logging');
  });
});
