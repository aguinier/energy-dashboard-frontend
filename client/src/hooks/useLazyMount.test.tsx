// @vitest-environment jsdom
//
// Component test needs a DOM; see LoadTab.test.tsx for the same opt-in.
// jsdom has no IntersectionObserver at all, so it is stubbed per-file here
// rather than shipping a polyfill (task brief).
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { useLazyMount } from './useLazyMount';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  // Fires the stubbed observer's callback as the real one would when an
  // observed element crosses the intersection threshold.
  trigger(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function Probe({ eager }: { eager?: boolean }) {
  const { ref, visible } = useLazyMount<HTMLDivElement>({ eager });
  return <div ref={ref}>{visible ? 'visible' : 'hidden'}</div>;
}

describe('useLazyMount', () => {
  const originalIO = global.IntersectionObserver;

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    // @ts-expect-error -- test stub, not the real constructor's full shape
    global.IntersectionObserver = FakeIntersectionObserver;
  });

  afterEach(() => {
    cleanup();
    global.IntersectionObserver = originalIO;
  });

  it('is visible on the very first render when eager, and never observes anything', () => {
    render(<Probe eager />);
    expect(screen.getByText('visible')).not.toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it('starts hidden and stays hidden until the observed node intersects', () => {
    render(<Probe />);
    expect(screen.getByText('hidden')).not.toBeNull();

    const [observer] = FakeIntersectionObserver.instances;
    expect(observer.observed).toHaveLength(1);

    act(() => observer.trigger(false));
    expect(screen.getByText('hidden')).not.toBeNull();
  });

  it('flips to visible once the observer reports an intersection, and disconnects', () => {
    render(<Probe />);
    const [observer] = FakeIntersectionObserver.instances;

    act(() => observer.trigger(true));

    expect(screen.getByText('visible')).not.toBeNull();
    expect(observer.disconnected).toBe(true);
  });

  it('stays visible and does not create a second observer once triggered', () => {
    render(<Probe />);
    const [observer] = FakeIntersectionObserver.instances;
    act(() => observer.trigger(true));
    expect(screen.getByText('visible')).not.toBeNull();
    // Only the one observer was ever constructed — no re-observe on the
    // re-render that visible=true itself causes.
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
  });

  it('mounts immediately when IntersectionObserver does not exist in this environment', () => {
    // @ts-expect-error -- simulate an environment with no IntersectionObserver at all
    global.IntersectionObserver = undefined;
    render(<Probe />);
    expect(screen.getByText('visible')).not.toBeNull();
  });
});
