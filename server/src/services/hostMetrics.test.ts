import { describe, it, expect } from 'vitest';
import {
  getDiskUsage,
  getCpuLoad,
  parseProcNetDev,
  computeNetworkThroughput,
  getNetworkThroughput,
  type NetworkSample,
  type NetworkSamplerState,
} from './hostMetrics.js';

describe('getDiskUsage', () => {
  it('converts a statfs result into byte totals', () => {
    const result = getDiskUsage('/data', () => ({ bsize: 4096, blocks: 1000, bfree: 400 }));
    expect(result).toEqual({ totalBytes: 4_096_000, freeBytes: 1_638_400, usedBytes: 2_457_600 });
  });

  it('degrades to null rather than throwing when the stat call fails', () => {
    // The graceful-degradation case ABL-237 asks for explicitly: a missing
    // path, a permission error, or an unsupported platform must never 500 the
    // whole ops payload over one metric.
    const result = getDiskUsage('/does/not/exist', () => {
      throw new Error('ENOENT: no such file or directory');
    });
    expect(result).toBeNull();
  });
});

describe('getCpuLoad', () => {
  it('reports the 1/5/15 minute averages on a POSIX platform', () => {
    const result = getCpuLoad('linux', () => [0.5, 0.75, 1.1]);
    expect(result).toEqual({ load1: 0.5, load5: 0.75, load15: 1.1 });
  });

  it('reports null on macOS too — any non-Windows platform uses the real reading', () => {
    const result = getCpuLoad('darwin', () => [2, 1.5, 1]);
    expect(result).toEqual({ load1: 2, load5: 1.5, load15: 1 });
  });

  it('reports null on Windows rather than os.loadavg()\'s fabricated [0,0,0]', () => {
    const result = getCpuLoad('win32', () => [0, 0, 0]);
    expect(result).toBeNull();
  });
});

/** The real kernel format, headers included, for the parser cases below. */
const PROC_NET_DEV_SAMPLE = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo:  123456    1000    0    0    0     0          0         0   123456    1000    0    0    0     0       0          0',
  '  eth0: 9876543   54321    0    0    0     0          0         0  1234567    8901    0    0    0     0       0          0',
  '',
].join('\n');

describe('parseProcNetDev', () => {
  it('reads receive bytes from field 1 and transmit bytes from field 9', () => {
    expect(parseProcNetDev(PROC_NET_DEV_SAMPLE)).toEqual([
      { name: 'eth0', rxBytes: 9_876_543, txBytes: 1_234_567 },
    ]);
  });

  it('parses an interface whose counter runs into the colon', () => {
    // The kernel pads the name to a 16-char field, so a wide counter leaves no
    // space after the colon. Splitting the whole line on whitespace would take
    // `eth0:123456789012345` as the name and shift every field left by one —
    // silently reporting receive packets as transmit bytes on exactly the
    // busiest interfaces.
    const line =
      '           eth0:123456789012345 54321 0 0 0 0 0 0 987654321098 8901 0 0 0 0 0 0';
    expect(parseProcNetDev(line)).toEqual([
      { name: 'eth0', rxBytes: 123_456_789_012_345, txBytes: 987_654_321_098 },
    ]);
  });

  it('drops loopback — this process talking to itself is not network load', () => {
    const names = parseProcNetDev(PROC_NET_DEV_SAMPLE).map((c) => c.name);
    expect(names).not.toContain('lo');
  });

  it('keeps an interface with zero counters rather than guessing it is down', () => {
    // /proc/net/dev carries no link state. Zero bytes is a measured zero on an
    // idle interface just as often as it is a down one, and dropping it would
    // hide a real interface from the page.
    const line = '   eth1:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0';
    expect(parseProcNetDev(line)).toEqual([{ name: 'eth1', rxBytes: 0, txBytes: 0 }]);
  });

  it('skips headers, blank lines and truncated rows instead of emitting NaN counters', () => {
    const malformed = ['Inter-|   Receive        |  Transmit', '', '  eth0: 100 2', 'garbage', '  eth1: notanumber 1 2 3 4 5 6 7 8'].join('\n');
    expect(parseProcNetDev(malformed)).toEqual([]);
  });
});

const sample = (atMs: number, counters: NetworkSample['counters']): NetworkSample => ({ atMs, counters });

describe('computeNetworkThroughput', () => {
  it('divides the byte delta by the exact window it reports', () => {
    const previous = sample(1000, [{ name: 'eth0', rxBytes: 1_000, txBytes: 500 }]);
    const current = sample(3000, [{ name: 'eth0', rxBytes: 5_000, txBytes: 1_500 }]);

    expect(computeNetworkThroughput(current, previous)).toEqual([
      {
        name: 'eth0',
        rxBytes: 5_000,
        txBytes: 1_500,
        rxBytesPerSec: 2_000, // 4000 bytes over 2s
        txBytesPerSec: 500, // 1000 bytes over 2s
        sampleWindowMs: 2000,
      },
    ]);
  });

  it('reports cumulative counters but null rates on the first sample', () => {
    const current = sample(1000, [{ name: 'eth0', rxBytes: 5_000, txBytes: 1_500 }]);

    expect(computeNetworkThroughput(current, null)).toEqual([
      {
        name: 'eth0',
        rxBytes: 5_000,
        txBytes: 1_500,
        rxBytesPerSec: null,
        txBytesPerSec: null,
        sampleWindowMs: null,
      },
    ]);
  });

  it('reports null rates for an interface that only appeared in this sample', () => {
    const previous = sample(1000, [{ name: 'eth0', rxBytes: 1_000, txBytes: 500 }]);
    const current = sample(3000, [
      { name: 'eth0', rxBytes: 1_000, txBytes: 500 },
      { name: 'eth1', rxBytes: 7_000, txBytes: 100 },
    ]);

    const byName = Object.fromEntries(computeNetworkThroughput(current, previous).map((i) => [i.name, i]));
    expect(byName.eth1.rxBytesPerSec).toBeNull();
    expect(byName.eth1.sampleWindowMs).toBeNull();
    expect(byName.eth1.rxBytes).toBe(7_000); // the counter itself is still a real reading
  });

  it('reports a measured zero, not null, for a genuinely idle interface', () => {
    const previous = sample(1000, [{ name: 'eth0', rxBytes: 5_000, txBytes: 1_500 }]);
    const current = sample(31_000, [{ name: 'eth0', rxBytes: 5_000, txBytes: 1_500 }]);

    const [eth0] = computeNetworkThroughput(current, previous);
    expect(eth0.rxBytesPerSec).toBe(0);
    expect(eth0.txBytesPerSec).toBe(0);
  });

  it('returns null, not a negative rate, when a counter resets under it', () => {
    // Interface bounce / container restart: the counter drops to near zero and
    // the bytes actually moved in the window are unknowable. A negative rate —
    // or the huge positive one a wrap-correction would invent — is exactly the
    // confidently-wrong number this codebase keeps having to walk back.
    const previous = sample(1000, [{ name: 'eth0', rxBytes: 9_000_000, txBytes: 8_000_000 }]);
    const current = sample(3000, [{ name: 'eth0', rxBytes: 4_096, txBytes: 9_000_000 }]);

    const [eth0] = computeNetworkThroughput(current, previous);
    expect(eth0.rxBytesPerSec).toBeNull(); // reset
    expect(eth0.txBytesPerSec).toBe(500_000); // the other direction is still sound
    expect(eth0.rxBytes).toBe(4_096);
  });

  it('returns null rather than Infinity when two reads land in the same millisecond', () => {
    const previous = sample(1000, [{ name: 'eth0', rxBytes: 1_000, txBytes: 500 }]);
    const current = sample(1000.4, [{ name: 'eth0', rxBytes: 9_000, txBytes: 500 }]);

    expect(computeNetworkThroughput(current, previous)).toEqual([
      {
        name: 'eth0',
        rxBytes: 9_000,
        txBytes: 500,
        rxBytesPerSec: null,
        txBytesPerSec: null,
        sampleWindowMs: null,
      },
    ]);
  });

  it('reports the window rounded to the millisecond it actually divided by', () => {
    const previous = sample(0, [{ name: 'eth0', rxBytes: 0, txBytes: 0 }]);
    const current = sample(2000.6, [{ name: 'eth0', rxBytes: 2_001, txBytes: 0 }]);

    const [eth0] = computeNetworkThroughput(current, previous);
    expect(eth0.sampleWindowMs).toBe(2001);
    expect(eth0.rxBytesPerSec).toBe(2_001 / 2.001);
  });
});

describe('getNetworkThroughput', () => {
  const twoInterfaces = (rx: number) =>
    [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      `  eth0: ${rx}   54321    0    0    0     0          0         0  1000    8901    0    0    0     0       0          0`,
      '',
    ].join('\n');

  it('returns null on Windows — /proc/net/dev does not exist there', () => {
    const state: NetworkSamplerState = { previous: null };
    const result = getNetworkThroughput('win32', () => twoInterfaces(1000), () => 0, state);
    expect(result).toBeNull();
    expect(state.previous).toBeNull(); // and no sample is banked from a platform we cannot read
  });

  it('returns null on macOS too rather than inventing a shape', () => {
    expect(getNetworkThroughput('darwin', () => twoInterfaces(1000), () => 0, { previous: null })).toBeNull();
  });

  it('degrades to null rather than throwing when /proc/net/dev cannot be read', () => {
    const result = getNetworkThroughput(
      'linux',
      () => {
        throw new Error('EACCES: permission denied');
      },
      () => 0,
      { previous: null },
    );
    expect(result).toBeNull();
  });

  it('banks the first sample and reports rates from the second call onward', () => {
    const state: NetworkSamplerState = { previous: null };
    let rx = 1_000;
    let clock = 0;
    const read = () => twoInterfaces(rx);
    const now = () => clock;

    const first = getNetworkThroughput('linux', read, now, state);
    expect(first).toEqual([
      { name: 'eth0', rxBytes: 1_000, txBytes: 1_000, rxBytesPerSec: null, txBytesPerSec: null, sampleWindowMs: null },
    ]);

    rx = 61_000;
    clock = 30_000;
    const second = getNetworkThroughput('linux', read, now, state);
    expect(second).toEqual([
      { name: 'eth0', rxBytes: 61_000, txBytes: 1_000, rxBytesPerSec: 2_000, txBytesPerSec: 0, sampleWindowMs: 30_000 },
    ]);
  });
});
