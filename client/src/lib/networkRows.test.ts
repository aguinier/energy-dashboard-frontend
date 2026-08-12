import { describe, it, expect } from 'vitest';
import { buildNetworkRows } from './networkRows';
import type { NetworkInterfaceThroughput } from '@/types';

const iface = (overrides: Partial<NetworkInterfaceThroughput> = {}): NetworkInterfaceThroughput => ({
  name: 'eth0',
  rxBytes: 1_000_000,
  txBytes: 500_000,
  rxBytesPerSec: 2048,
  txBytesPerSec: 1024,
  sampleWindowMs: 30_000,
  ...overrides,
});

describe('buildNetworkRows', () => {
  it('renders one row per interface with both directions', () => {
    expect(buildNetworkRows({ platform: 'linux', network: [iface()] })).toEqual([
      { label: 'Network (eth0)', value: '↓ 2.0 KB/s ↑ 1.0 KB/s' },
    ]);
  });

  it('lists every interface separately rather than summing them', () => {
    const rows = buildNetworkRows({
      platform: 'linux',
      network: [iface(), iface({ name: 'eth1', rxBytesPerSec: 0, txBytesPerSec: 0 })],
    });
    expect(rows.map((r) => r.label)).toEqual(['Network (eth0)', 'Network (eth1)']);
  });

  it('distinguishes an older peer build from a platform that cannot measure', () => {
    // `undefined` says nothing about that host's network — it says the build
    // predates ABL-290. Rendering it as "not measured on Linux" would blame the
    // wrong thing, and rendering either as 0 would be a fabricated reading.
    expect(buildNetworkRows({ platform: 'linux' })).toEqual([
      { label: 'Network', value: 'not reported by this build' },
    ]);
    expect(buildNetworkRows({ platform: 'win32', network: null })).toEqual([
      { label: 'Network', value: 'not measured on Windows' },
    ]);
  });

  it('names the platform it could not measure on, whatever it is', () => {
    expect(buildNetworkRows({ platform: 'darwin', network: null })[0].value).toBe('not measured on macOS');
    expect(buildNetworkRows({ platform: 'freebsd', network: null })[0].value).toBe('not measured on freebsd');
  });

  it('says the counters were read and found nothing, not that nothing was measured', () => {
    expect(buildNetworkRows({ platform: 'linux', network: [] })).toEqual([
      { label: 'Network', value: 'no non-loopback interfaces' },
    ]);
  });

  it('shows a dash and the reason while the first sample is still the only one', () => {
    const rows = buildNetworkRows({
      platform: 'linux',
      network: [iface({ rxBytesPerSec: null, txBytesPerSec: null, sampleWindowMs: null })],
    });
    expect(rows[0].value).toBe('↓ — ↑ — · awaiting second sample');
  });

  it('reports a counter reset differently from a missing sample', () => {
    const rows = buildNetworkRows({
      platform: 'linux',
      network: [iface({ rxBytesPerSec: null, sampleWindowMs: 30_000 })],
    });
    // The direction that survived the reset still shows its real rate.
    expect(rows[0].value).toBe('↓ — ↑ 1.0 KB/s · counter reset');
  });

  it('renders a measured zero as 0 B/s — an idle interface is a real reading', () => {
    const rows = buildNetworkRows({
      platform: 'linux',
      network: [iface({ rxBytesPerSec: 0, txBytesPerSec: 0 })],
    });
    expect(rows[0].value).toBe('↓ 0 B/s ↑ 0 B/s');
  });

  it('never renders sub-1 B/s traffic as an idle 0 B/s', () => {
    const rows = buildNetworkRows({
      platform: 'linux',
      network: [iface({ rxBytesPerSec: 0.4, txBytesPerSec: 0.9 })],
    });
    expect(rows[0].value).toBe('↓ <1 B/s ↑ <1 B/s');
  });

  it('scales up to MB/s without losing the unit', () => {
    const rows = buildNetworkRows({
      platform: 'linux',
      network: [iface({ rxBytesPerSec: 5 * 1024 * 1024, txBytesPerSec: 1536 })],
    });
    expect(rows[0].value).toBe('↓ 5.0 MB/s ↑ 1.5 KB/s');
  });
});
