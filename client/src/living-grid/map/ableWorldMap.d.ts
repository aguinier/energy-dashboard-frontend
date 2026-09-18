/**
 * Types for the ported `<able-world-map>` custom element.
 *
 * The implementation is `ableWorldMap.js` and `tsc` never reads it — see that
 * file's header for why it stays JavaScript. This declaration is the surface
 * the rest of the app compiles against.
 */

/** Registers the element. Idempotent — safe to call on every mount. */
export declare function defineAbleWorldMap(): void;

/**
 * The element's own methods, reachable through a ref once it has upgraded.
 * Everything else is driven by attributes.
 */
export interface AbleWorldMapElement extends HTMLElement {
  /**
   * Repaint the canvas layers. Needed once after webfonts load: labels and
   * corridor values are drawn onto canvas, which does not reflow when a font
   * arrives the way DOM text does.
   */
  repaint(): void;
  /** Jump the viewport to a preset. `dur` of 0 skips the transition. */
  zoomTo(view: 'europe' | 'world', dur?: number): void;
}

/**
 * Every attribute the element observes. All are strings on the wire; object
 * and array values are JSON. Multi-word names have no dash — `fillop`, not
 * `fill-op` — because the element reads both spellings and the dashed form is
 * the one a framework is likely to mangle.
 */
export interface AbleWorldMapAttributes {
  /** `{"DE": 1, …}` — the zones that are part of the dataset, hence clickable. */
  values: string;
  /** The selected zone code, or absent. */
  active?: string;
  /** Theme name; the Living Grid uses `living`. */
  theme?: string;
  /** `{"DE-FR": mw}`, + meaning the first zone exports. */
  flows?: string;
  /** `{"DE": "#2FD3C0", …}` — an explicit fill per zone, overriding `scalars`. */
  fills?: string;
  /** `{"DE": 0.42}` — a 0..1 position along `scalar-colors`. */
  scalars?: string;
  /** Comma-separated hex stops the `scalars` ramp interpolates. */
  'scalar-colors'?: string;
  /**
   * `{"DE": -2800}` — the figure printed under each zone label, unformatted.
   *
   * Numbers rather than finished strings so the element can count through them
   * while an hour eases into the next; `chip-kind` says how to print them.
   */
  'chip-values'?: string;
  /** How to print `chip-values`: `euro`, `gw` or `signedGw`. */
  'chip-kind'?: string;
  /**
   * How long to take reaching this state, in ms. `0` cuts.
   *
   * The caller decides — a play step and a single-hour step ease, a timeline
   * drag and a view switch do not. The element zeroes it by itself when the
   * reader has asked for reduced motion.
   */
  'tween-ms'?: string;
  /** `{"DE": [["#B388EB", 0.3], …]}` — mix ring segments, colour and share. */
  donuts?: string;
  /** Fill opacity for the data layer. */
  fillop?: string;
  /** Particle speed multiplier, particle count multiplier, stroke width. */
  speed?: string;
  density?: string;
  width?: string;
  /** Layer toggles, `'true'` / `'false'`. */
  grid?: string;
  plants?: string;
  demand?: string;
  labels?: string;
  arcs?: string;
  seas?: string;
  borders?: string;
  glow?: string;
  'values-on'?: string;
}
