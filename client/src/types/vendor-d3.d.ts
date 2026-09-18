/**
 * Ambient declarations for the two Living Grid map dependencies that ship no
 * types and have no @types package installed here.
 *
 * `d3-transition` is imported for its side effect only — it augments
 * `d3-selection`'s prototype with `.transition()`, which `ableWorldMap` uses
 * for the zoom easing. Nothing is called from it by name.
 *
 * `topojson-client` is used for exactly two functions, declared with the
 * shapes this codebase actually passes.
 */

declare module 'd3-transition';

declare module 'topojson-client' {
  /** A TopoJSON topology as served by world-atlas. */
  export interface Topology {
    type: 'Topology';
    objects: Record<string, TopologyObject>;
    arcs: number[][][];
    transform?: { scale: [number, number]; translate: [number, number] };
  }

  export interface TopologyObject {
    type: string;
    geometries?: TopologyGeometry[];
    [key: string]: unknown;
  }

  export interface TopologyGeometry {
    type: string;
    id?: string | number;
    properties?: Record<string, unknown>;
    arcs?: unknown;
  }

  /**
   * Converts a topology object back to GeoJSON. A `GeometryCollection` yields a
   * `FeatureCollection`; any other geometry yields a single `Feature`.
   */
  export function feature(
    topology: Topology,
    object: TopologyObject | TopologyGeometry | string,
  ): GeoJSON.FeatureCollection | GeoJSON.Feature;

  /** Adjacency list: for each geometry, the indices of the geometries it touches. */
  export function neighbors(objects: TopologyGeometry[]): number[][];
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      /**
       * The `<able-world-map>` custom element defined in
       * `src/living-grid/map/ableWorldMap.ts`. Every input is a string
       * attribute set imperatively by `WorldMapHost`, so no prop surface is
       * declared here beyond the standard HTML one.
       */
      'able-world-map': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}

export {};
