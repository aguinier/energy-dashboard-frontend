import type { NetworkInterfaceThroughput } from '@/types';
import { formatBytes } from './formatters';

/**
 * Rendering rules for the per-interface network throughput the ops status
 * endpoint reports (ABL-290). Pure and separate from `OpsStatusView` so the
 * cases that matter — and they are almost all "we do not have this number" —
 * are directly testable.
 *
 * Four distinct absences, deliberately worded differently, because collapsing
 * them into one "0" or one "n/a" is how this dashboard has historically
 * shipped a confidently wrong reading:
 *
 * - `undefined`: the peer is on a build older than ABL-290 and never sent the
 *   field. Nothing is wrong with that environment's network.
 * - `null`: the platform has no counters to read (`/proc/net/dev` is Linux-only,
 *   so this is the Windows acceptance host).
 * - `[]`: counters were read and there is genuinely no non-loopback interface.
 * - a `null` rate on a listed interface: the counter is real, the *rate* is not
 *   yet derivable — either no second sample, or the counter reset under it.
 */
export interface NetworkRow {
  label: string;
  value: string;
}

export interface HostNetworkSection {
  platform: string;
  network?: NetworkInterfaceThroughput[] | null;
}

export function buildNetworkRows(host: HostNetworkSection): NetworkRow[] {
  if (host.network === undefined) {
    return [{ label: 'Network', value: 'not reported by this build' }];
  }
  if (host.network === null) {
    return [{ label: 'Network', value: `not measured on ${describePlatform(host.platform)}` }];
  }
  if (host.network.length === 0) {
    return [{ label: 'Network', value: 'no non-loopback interfaces' }];
  }
  return host.network.map((iface) => ({
    label: `Network (${iface.name})`,
    value: describeThroughput(iface),
  }));
}

function describeThroughput(iface: NetworkInterfaceThroughput): string {
  const rates = `↓ ${formatRate(iface.rxBytesPerSec)} ↑ ${formatRate(iface.txBytesPerSec)}`;
  if (iface.rxBytesPerSec !== null && iface.txBytesPerSec !== null) return rates;
  // A missing window means no second sample yet; a present one means the
  // counter went backwards (interface bounce, container restart) and the bytes
  // actually moved are unknowable. Both are honest, and they are not the same
  // thing, so the page says which.
  return iface.sampleWindowMs === null
    ? `${rates} · awaiting second sample`
    : `${rates} · counter reset`;
}

/**
 * A rate below 1 B/s is real traffic, so it renders as `<1 B/s` rather than
 * rounding down to `0 B/s` — which would read as an idle interface, the exact
 * confusion `null`-not-`0` exists to prevent. An exact zero is a measured zero
 * and keeps reading `0 B/s`.
 */
function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null) return '—';
  if (bytesPerSec > 0 && bytesPerSec < 1) return '<1 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

function describePlatform(platform: string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return platform;
}
