import { describe, it, expect } from 'vitest';
import { describeGridError } from './gridError';

const withStatus = (status: number) => ({ response: { status } });

describe('describeGridError', () => {
  it('names the scheduled database refresh rather than calling it a failure', () => {
    // The workstation replica is locked to every reader twice a day while it
    // is rebuilt. It clears by itself, so the reader is told to wait, not that
    // something broke.
    const message = describeGridError(withStatus(503));

    expect(message).toMatch(/refreshed/i);
    expect(message).toMatch(/try again/i);
  });

  it('explains a rejected date', () => {
    expect(describeGridError(withStatus(400))).toMatch(/date/i);
  });

  it('reports a genuine server fault plainly', () => {
    expect(describeGridError(withStatus(500))).toMatch(/could not build/i);
  });

  it('passes a transport error message through', () => {
    expect(describeGridError(new Error('Network Error'))).toBe('Network Error');
  });

  it('has something to say about an error it does not recognise', () => {
    expect(describeGridError(null)).toBe('The API did not answer.');
    expect(describeGridError({})).toBe('The API did not answer.');
  });
});
