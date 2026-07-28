import { describe, it, expect } from 'vitest';
import { unwrap } from './unwrap';

describe('unwrap', () => {
  it('returns the payload from a well-formed envelope', () => {
    expect(unwrap({ success: true, data: [1, 2] }, '/x')).toEqual([1, 2]);
  });

  it('throws when the body is an HTML error page', () => {
    expect(() => unwrap('<!doctype html><title>404</title>' as never, '/x'))
      .toThrow(/\/x/);
  });

  it('throws when data is missing', () => {
    expect(() => unwrap({ success: true } as never, '/models')).toThrow(/\/models/);
  });

  it('allows a legitimately null payload through as null', () => {
    expect(unwrap({ success: true, data: null }, '/x')).toBeNull();
  });
});
