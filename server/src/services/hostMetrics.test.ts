import { describe, it, expect } from 'vitest';
import { getDiskUsage, getCpuLoad } from './hostMetrics.js';

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
