import { useEffect, useLayoutEffect, useRef } from 'react';
import { defineAbleWorldMap, type AbleWorldMapElement } from './ableWorldMap';

/**
 * The React side of `<able-world-map>`.
 *
 * Deliberately thin. The element owns a requestAnimationFrame loop, two canvas
 * contexts and a d3 zoom transform, none of which should be re-created by a
 * render; React's whole job here is to push attribute strings in and route
 * window events back out.
 */
export interface WorldMapHostProps {
  /** Attribute name to value. `undefined` removes the attribute. */
  attrs: Record<string, string | undefined>;
  onPick?: (code: string | null) => void;
  onHover?: (detail: { code: string; net: number } | null) => void;
  onFlows?: (detail: { flows: Record<string, number>; net: Record<string, number> }) => void;
}

export function WorldMapHost({ attrs, onPick, onHover, onFlows }: WorldMapHostProps) {
  const ref = useRef<AbleWorldMapElement | null>(null);
  /**
   * What is already on the element. Writing an attribute makes it re-parse the
   * JSON and repaint, and writing `values` or `flows` rebuilds the whole vector
   * field — so an unchanged string must never be written. Every attribute this
   * component sets is derived fresh each render, so identity comparison would
   * rewrite all of them on every hour tick.
   */
  const applied = useRef<Record<string, string | undefined>>({});

  // Before the attribute effect below, so the element is upgraded and will
  // receive attributeChangedCallback for everything set here.
  useLayoutEffect(() => {
    defineAbleWorldMap();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (const [name, value] of Object.entries(attrs)) {
      if (applied.current[name] === value) continue;
      applied.current[name] = value;
      if (value === undefined) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  }, [attrs]);

  // Callbacks go through refs so a new inline handler does not tear down and
  // re-add window listeners on every render.
  const handlers = useRef({ onPick, onHover, onFlows });
  handlers.current = { onPick, onHover, onFlows };

  useEffect(() => {
    const pick = (e: Event) => handlers.current.onPick?.((e as CustomEvent).detail ?? null);
    const hover = (e: Event) => handlers.current.onHover?.((e as CustomEvent).detail ?? null);
    const flows = (e: Event) => handlers.current.onFlows?.((e as CustomEvent).detail);

    window.addEventListener('able-map-pick', pick);
    window.addEventListener('able-map-hover', hover);
    window.addEventListener('able-map-flows', flows);
    return () => {
      window.removeEventListener('able-map-pick', pick);
      window.removeEventListener('able-map-hover', hover);
      window.removeEventListener('able-map-flows', flows);
    };
  }, []);

  // Canvas text does not reflow when a webfont arrives, so the map would keep
  // whatever face was available at first paint until something else redrew it.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) ref.current?.repaint();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <able-world-map
      ref={ref as React.RefObject<HTMLElement>}
      // Present on the tag, not only in the attribute effect: the element
      // paints its own background when it connects, which happens before any
      // effect runs. Without this it shows one frame of the default light
      // theme behind every sea.
      theme="living"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  );
}
