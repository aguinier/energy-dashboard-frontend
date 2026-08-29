import { useEffect, useRef, useState } from 'react';

export interface UseLazyMountOptions {
  /**
   * Skip the observer and report visible on the very first render. Figure 1
   * of the country document fetches eagerly (design spec, Performance) —
   * every other figure waits for this hook's `visible` to flip.
   */
  eager?: boolean;
  /**
   * Passed straight to `IntersectionObserver`. A small positive margin lets a
   * figure's data start loading slightly before its top edge is on screen,
   * rather than only once the skeleton itself is visible — a plain `0px`
   * would still be correct, just slower to hide the skeleton on a fast
   * scroll. Not large enough that a 1440x900 initial paint pulls in more
   * than the figure or two that are already inside (or nearly inside) the
   * viewport at scroll position 0; that is what keeps requests staggered by
   * scroll position rather than fanning out on load the way six eagerly
   * mounted figures did before this hook existed.
   */
  rootMargin?: string;
}

/**
 * Defers a figure's data-fetching body until it scrolls near the viewport
 * (docs/superpowers/specs/2026-08-29-country-page-scrolling-document-design.md,
 * Performance). The caller attaches `ref` to a DOM node that exists whether
 * or not the real content has mounted yet — typically a skeleton placeholder
 * reserving the figure's final height, so revealing the real content does not
 * shift scroll position.
 *
 * Once `visible` becomes `true` it never goes back to `false`: a figure that
 * has already fetched its data must not unmount and refetch just because the
 * user scrolled back up past it. The observer disconnects itself the first
 * time it fires, which is also what keeps this a one-shot "has this figure
 * ever been seen" check rather than a live is-it-on-screen-right-now signal.
 */
export function useLazyMount<T extends Element>({
  eager = false,
  rootMargin = '120px 0px',
}: UseLazyMountOptions = {}): { ref: React.RefObject<T>; visible: boolean } {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(eager);

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    // No node to observe (nothing rendered the skeleton this render), or no
    // IntersectionObserver in this environment (jsdom has none — tests stub
    // it per file rather than this hook shipping a polyfill, per the task
    // brief). Either way, mounting immediately beats leaving the figure
    // permanently skeletal.
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, rootMargin]);

  return { ref, visible };
}
