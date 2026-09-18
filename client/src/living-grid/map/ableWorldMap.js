// <able-world-map values='{"DE":1,...}' active="DE" width speed density grid>
// World-atlas countries (Natural Earth 110m, d3-geo, Mercator) + the real European transmission backbone from
// grid-lines.json (ENTSO-E interactive-map extract via PyPSA GridKit, AC ≥300 kV and HVDC). Countries in `values`
// are the dataset; they are filled by net position (amber = importing, green = exporting).
// Cross-border flow per border is split across that border's real lines; inland lines take direction from the
// nearest crossings (inward from importing borders, outward to exporting ones). The result is a vector field along
// the lines, rendered Windy-style with drifting particles. Flow data: the `flows` attribute,
// {"DE-FR": mw (+ = DE→FR)}; a border it does not name is drawn without a corridor.
// Events on window: 'able-map-pick' {detail: code}, 'able-map-hover' {detail: {code, net} | null}, 'able-map-net' {detail: {code: mw}}.
// PORTED FROM THE DESIGN HANDOFF — see _design/Energy dashboard design review.zip
//
// This is `world-map.js` from the Living Grid handoff, which the handoff asks to
// be taken "nearly verbatim": a self-contained rendering machine whose only
// contract is attributes in, window events out. Rewriting it as a React
// component would move a requestAnimationFrame loop, two canvas contexts and a
// d3 zoom transform inside a re-render cycle for no benefit, so it stays a
// custom element and the React side is a thin wrapper.
//
// It is JavaScript, deliberately. The logic is unchanged from the prototype,
// and annotating ~600 lines of dense vector-field maths to satisfy `strict`
// would mean editing every line of it — the one change most likely to
// introduce a rendering bug no test here would catch. Types live in the
// sibling `ableWorldMap.d.ts`, which is what the rest of the app compiles
// against; `tsc` never reads this file.
//
// WHAT WAS CHANGED FROM THE HANDOFF COPY, AND WHY
//
//  1. ESM imports replace the `window.d3` / `window.topojson` globals and the
//     rAF polling loop that waited for them.
//  2. Every asset is fetched from `/living-grid/` instead of a CDN. Production
//     is a LAN Docker host: a jsDelivr fetch there leaves the map without
//     geometry.
//  3. Flows arrive as a `flows` attribute instead of `window.ABLE_FLOWS`, and
//     a border the payload does not mention is no longer filled in with a
//     deterministic mock. The prototype's mock is what made a demo look alive;
//     serving it beside real data would make invented numbers indistinguishable
//     from measured ones.
//  4. `connectedCallback` re-arms after a disconnect. The original returns
//     early on `_init`, but `disconnectedCallback` cancels the animation frame
//     and disconnects the ResizeObserver — so a remount left a frozen map.
//  5. `defineAbleWorldMap()` replaces the bare `customElements.define` call, so
//     registration happens when the view mounts rather than on import.

import { geoMercator, geoPath } from 'd3-geo';
import { select, pointer } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { easeCubicInOut } from 'd3-ease';
import 'd3-transition';
import { feature, neighbors } from 'topojson-client';

const TOPO_URL = '/living-grid/countries-50m.json';
const GRID_URL = '/living-grid/grid-lines.json';
const PLACES_URL = '/living-grid/grid-places.json';

  const NUM = { AL:'8', AT:'40', BA:'70', BE:'56', BG:'100', BY:'112', CH:'756', CY:'196', CZ:'203', DE:'276', DK:'208', EE:'233', ES:'724', FI:'246', FR:'250', GB:'826', UK:'826', GR:'300', HR:'191', HU:'348', IE:'372', IS:'352', IT:'380', LT:'440', LU:'442', LV:'428', MD:'498', ME:'499', MK:'807', NL:'528', NO:'578', PL:'616', PT:'620', RO:'642', RS:'688', RU:'643', SE:'752', SI:'705', SK:'703', TR:'792', UA:'804', XK:'-99' };
  Object.keys(NUM).forEach((k) => { if (NUM[k].charAt(0) !== '-') NUM[k] = NUM[k].padStart(3, '0'); });
  const ALPHA = {}; Object.keys(NUM).forEach((k) => { const v = NUM[k]; if (!ALPHA[v]) ALPHA[v] = k; const raw = String(Number(v)); if (!ALPHA[raw]) ALPHA[raw] = k; });
  const THEMES = {
    current: { bg:'#F7F8FA', land:'#DCE0E5', dataLand:'#FFFFFF', exp:'#1F5F7A', imp:'#C46A4E', dnl:'#ECEEF1', fillOp:0.26, outline:'#0B0E12', grid:'rgba(107,115,128,0.05)', pFrom:'#A2AAB4', pTo:'#3A434D', panel:'#FFF', panelText:'#111418', panelBorder:'#D5D9DE', panelHover:'#EEF0F2', tipBg:'#0B0E12', tipText:'#FFF', srcText:'#8A919C' },
    ink:     { bg:'#F3F0E9', land:'#E3DED2', dataLand:'#FBFAF6', exp:'#2E5E4E', imp:'#A8502F', dnl:'#ECE7DC', fillOp:0.22, outline:'#1A1712', grid:'rgba(40,35,25,0.07)', pFrom:'#B8B0A0', pTo:'#221F19', panel:'#FBFAF6', panelText:'#241F17', panelBorder:'#D8D1C2', panelHover:'#EEE9DC', tipBg:'#1A1712', tipText:'#F7F4EC', srcText:'#8E8676' },
    night:   { bg:'#0E1116', land:'#171C23', dataLand:'#1C222B', exp:'#3FB6C8', imp:'#E08A47', dnl:'#242B35', fillOp:0.42, outline:'#EDF1F6', grid:'rgba(190,205,225,0.07)', pFrom:'#46515F', pTo:'#D8E3F0', panel:'#171C23', panelText:'#E7ECF3', panelBorder:'#2A323D', panelHover:'#212934', tipBg:'#EDF1F6', tipText:'#0E1116', srcText:'#6C7787' },
    atlas:   { bg:'#FFFFFF', land:'#E9EAEC', dataLand:'#FFFFFF', exp:'#0F4C81', imp:'#D1495B', dnl:'#E4E6E9', fillOp:0.9, outline:'#0B0E12', grid:'rgba(11,14,18,0.05)', pFrom:'#FFFFFF', pTo:'#FFFFFF', panel:'#FFFFFF', panelText:'#0B0E12', panelBorder:'#DADDE1', panelHover:'#F0F1F3', tipBg:'#0B0E12', tipText:'#FFF', srcText:'#8A919C' },
    living:  { bg:'#07121C', land:'#0F1C27', dataLand:'#162834', exp:'#2FD3C0', imp:'#E2703A', dnl:'#2B3C49', fillOp:0.7, scale:true, outline:'#BFF3EE', grid:'rgba(150,205,225,0.07)', pFrom:'#1E4C60', pTo:'#9BF0E6', panel:'#0E1C28', panelText:'#DCEEF5', panelBorder:'#1F3646', panelHover:'#162836', tipBg:'#DCEEF5', tipText:'#07121C', srcText:'#5D7688', label:'#A8CCDC', sea:'#3C5E70', glow:'#1B7C92', additive:true }
  };
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const lerp = (a, b, t) => { const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const A = p(a), B = p(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
  const rgba = (hex, a) => { const p = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 'rgba(' + p.join(',') + ',' + a + ')'; };
  const ramp = (stops, t) => {
    if (!stops || stops.length < 2) return stops && stops[0];
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x));
    return lerp(stops[i], stops[i + 1], x - i);
  };
  let topoP = null;
  const loadTopo = () => topoP || (topoP = fetch(TOPO_URL).then((r) => r.json()).catch((e) => { topoP = null; throw e; }));
  // real subsea/DC links: everything else must be a shared land border
  const HVDC_OK = ['NO-DE','NL-NO','GB-NO','BE-GB','FR-GB','GB-IE','DK-GB','DK-NL','LT-SE','LT-PL','EE-FI','PL-SE','GR-IT','ES-FR','DE-SE','DE-DK','FI-SE','DK-SE','DK-NO','EE-LV','LT-LV','GB-NL','CY-GR','IT-ME','HR-IT','AL-IT','IT-TN'].reduce((o, k) => { o[k.split('-').sort().join('-')] = 1; return o; }, {});
  const SEAS = [
    { n: 'North Sea', ll: [3.0, 56.4], sz: 13 }, { n: 'Baltic Sea', ll: [19.5, 57.4], sz: 13 },
    { n: 'Atlantic Ocean', ll: [-11.5, 45.5], sz: 13 }, { n: 'Mediterranean Sea', ll: [8.0, 37.4], sz: 13 },
    { n: 'Norwegian Sea', ll: [1.0, 66.5], sz: 12 }, { n: 'Black Sea', ll: [33.5, 43.2], sz: 12 }
  ];
  const FAM = { nuclear: '#8A6FC2', hydro: '#4A6FD4', gas: '#9AA3AE', coal: '#4B5563', wind: '#5FA8A0', solar: '#D08C3A', 'other renewable': '#7FA35A' };

  class AbleWorldMap extends HTMLElement {
    static get observedAttributes() { return ['values', 'active', 'width', 'speed', 'density', 'grid', 'plants', 'demand', 'theme', 'labels', 'arcs', 'seas', 'borders', 'values-on', 'valueson', 'glow', 'chips', 'donuts', 'fills', 'fill-op', 'fillop', 'scalars', 'scalar-colors', 'scalarcolors', 'flows']; }
    num(n, d) { const v = parseFloat(this.attr(n)); return isNaN(v) ? d : v; }
    attr(n) { const v = this.getAttribute(n); return v != null ? v : this.getAttribute(n.replace(/-/g, '')); }
    connectedCallback() {
      if (this._init) { this.reconnect(); return; }
      this._init = true;
      this._hover = null;
      const T = this.theme();
      this.style.cssText = 'display:block;position:relative;width:100%;height:100%;overflow:hidden;background:' + T.bg;
      this.innerHTML = '<svg style="display:block;position:absolute;inset:0;width:100%;height:100%;cursor:grab;touch-action:none"></svg>'
        + '<canvas style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas>'
        + '<canvas data-places style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas>'
        + '<div data-tip style="position:absolute;display:none;pointer-events:none;background:' + T.tipBg + ';color:' + T.tipText + ';font:11.5px \'IBM Plex Mono\',monospace;padding:5px 8px;border-radius:3px;white-space:nowrap;z-index:2"></div>'
        + '<div data-bar style="position:absolute;left:12px;bottom:12px;display:flex;gap:1px;border:1px solid ' + T.panelBorder + ';border-radius:4px;overflow:hidden;background:' + T.panel + ';font:11.5px \'IBM Plex Mono\',monospace"></div>'
        + '<div data-src style="position:absolute;right:12px;bottom:12px;max-width:calc(100% - 170px);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:10.5px \'IBM Plex Mono\',monospace;color:' + T.srcText + '">grid: ENTSO-E map extract (GridKit, 2022) · flows: mock</div>';
      const bar = this.querySelector('[data-bar]');
      ['Europe', 'World'].forEach((l) => { const b = document.createElement('button'); b.textContent = l; b.style.cssText = 'height:26px;padding:0 10px;border:0;background:' + T.panel + ';color:' + T.panelText + ';cursor:pointer;font:inherit'; b.onmouseenter = () => { b.style.background = T.panelHover; }; b.onmouseleave = () => { b.style.background = T.panel; }; b.onclick = () => this.zoomTo(l === 'Europe' ? 'europe' : 'world'); bar.appendChild(b); });
      this._tip = this.querySelector('[data-tip]');
      this._canvas = this.querySelector('canvas'); this._ctx = this._canvas.getContext('2d');
      this._pc = this.querySelector('[data-places]'); this._pctx = this._pc.getContext('2d');
      Promise.all([loadTopo(), fetch(GRID_URL).then((r) => r.json()), fetch(PLACES_URL).then((r) => r.json()).catch(() => null)])
        .then(([topo, grid, places]) => { this._grid = grid; this._placesRaw = places; this.draw(topo); })
        .catch((err) => { console.error('able-world-map: init failed', err); this.querySelector('[data-src]').textContent = 'map data unavailable — ' + (err && err.message || err); });
      this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(this);
      this._ask = () => { if (this._netOut) window.dispatchEvent(new CustomEvent('able-map-net', { detail: this._netOut })); };
      window.addEventListener('able-map-ask-net', this._ask);
    }
    disconnectedCallback() { if (this._ro) this._ro.disconnect(); cancelAnimationFrame(this._raf); window.removeEventListener('able-map-ask-net', this._ask); }
    /**
     * Re-arm after a detach. React can unmount and remount this element — a
     * lazy route, an error retry — and disconnectedCallback has torn down the
     * observer, the frame loop and the listener by then. Without this the
     * element comes back as a still image.
     */
    reconnect() {
      if (this._ro) this._ro.observe(this);
      if (this._ask) window.addEventListener('able-map-ask-net', this._ask);
      if (this._field && !this._raf) {
        const loop = (ts) => { this.frame(ts); this._raf = requestAnimationFrame(loop); };
        this._raf = requestAnimationFrame(loop);
      }
      this.resize();
    }
    /** Repaint on demand — used once webfonts load, since canvas text does not reflow. */
    repaint() { if (this._paths) { this.paint(); this.paintPlaces(); } }
    /**
     * Re-apply the theme colours that live on DOM nodes rather than on canvas.
     *
     * connectedCallback bakes these in once, which was fine when the element
     * was written by hand with its attributes already on the tag. Mounted by a
     * framework, the attributes arrive in an effect AFTER the element has
     * connected, so it would keep the default theme's near-white background
     * behind every sea while the data layers repainted in the right palette.
     */
    applyChrome() {
      const T = this.theme();
      this.style.background = T.bg;
      if (this._tip) { this._tip.style.background = T.tipBg; this._tip.style.color = T.tipText; }
      const bar = this.querySelector('[data-bar]');
      if (bar) {
        bar.style.background = T.panel;
        bar.style.borderColor = T.panelBorder;
        bar.querySelectorAll('button').forEach((b) => { b.style.background = T.panel; b.style.color = T.panelText; });
      }
      const src = this.querySelector('[data-src]');
      if (src) src.style.color = T.srcText;
    }
    attributeChangedCallback(n) {
      if (n === 'theme') this.applyChrome();
      if (!this._paths || !this._w) return;
      // Each of these already repaints at its own tail: buildNetwork() ends in
      // paint(), and paint() ends in strokes() + clearCanvas() + paintPlaces().
      // Calling them again here drew the identical frame two or three times —
      // a flows change (every hour step) ran paint() twice and paintPlaces()
      // three times, and a zone click ran paintPlaces() twice.
      if (n === 'values' || n === 'density' || n === 'demand' || n === 'flows') { this.buildNetwork(); return; }
      this.paint();
    }
    values() { return this.json('values') || {}; }
    theme() { return THEMES[this.getAttribute('theme')] || THEMES.current; }
    // Parsed once per distinct attribute string. paintPlaces() runs every frame
    // and re-parsed `values`, `chips` and `donuts` on each one; paint() re-parsed
    // `fills` and `scalars` beside it. The cache key is the raw attribute, so a
    // changed attribute still re-parses on its next read.
    //
    // Callers share the returned object, so none of them may mutate it. Checked:
    // every read site indexes it (`vals[c]`, `fx[c]`, `chips[c]`, `donuts[c]`)
    // and none assigns into it.
    json(n) {
      const raw = this.attr(n);
      const cache = this._jsonCache || (this._jsonCache = {});
      const hit = cache[n];
      if (hit && hit.raw === raw) return hit.val;
      let val; try { val = JSON.parse(raw || 'null'); } catch (e) { val = null; }
      cache[n] = { raw: raw, val: val };
      return val;
    }

    // ---- countries → grid lines → flows → vector field --------------------------------------------
    buildNetwork() {
      const vals = this.values(), codes = Object.keys(vals).filter((c) => NUM[c]);
      // Europe box in map px + grid resolution
      const box = [[-12, 72], [36, 34]].map((p) => this._proj(p));
      const ox = box[0][0], oy = box[0][1], bw = box[1][0] - ox, bh = box[1][1] - oy;
      const cell = bw / 720, cols = Math.ceil(bw / cell) + 1, rows = Math.ceil(bh / cell) + 1, sc = bw / 924;
      this._box = { ox: ox, oy: oy, bw: bw, bh: bh };
      // country id raster (dataset countries only) for point→country lookup + land mask
      const mc = document.createElement('canvas'); mc.width = cols; mc.height = rows; const mctx = mc.getContext('2d');
      mctx.scale(1 / cell, 1 / cell); mctx.translate(-ox, -oy);
      const mpath = geoPath(this._proj, mctx), idOf = {};
      codes.forEach((c, i) => { const f = this._features.find((ft) => ALPHA[ft.id] === c); if (!f) return; idOf[c] = i + 1; mctx.fillStyle = 'rgb(' + (i + 1) + ',0,0)'; mctx.beginPath(); mpath(f); mctx.fill(); });
      const raster = mctx.getImageData(0, 0, cols, rows).data, byId = {}; Object.keys(idOf).forEach((c) => { byId[idOf[c]] = c; });
      const countryAt = (x, y) => { const c = Math.floor((x - ox) / cell), r = Math.floor((y - oy) / cell); if (c < 0 || r < 0 || c >= cols || r >= rows) return null; const i = (r * cols + c) * 4; return raster[i + 3] ? byId[raster[i]] || null : null; };
      // lines → projected polylines with endpoint countries
      const P = (ll) => this._proj(ll);
      const lines = [];
      const add = (L, dc) => {
        const pts = L.p.map(P); if (pts.some((p) => !p || isNaN(p[0]))) return;
        const a = countryAt(pts[0][0], pts[0][1]), b = countryAt(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        if (!a && !b) return;
        let cross = !!(a && b && a !== b);
        if (cross && this._adj) {
          const key = [a, b].sort().join('-');
          if (!this._adj[key] && !(L.dc && HVDC_OK[key])) cross = false;
        }
        lines.push({ pts: pts, a: a, b: b, dc: dc, v: L.v, cross: cross, mid: pts[Math.floor(pts.length / 2)] });
      };
      this._grid.ac.forEach((L) => add(L, false)); this._grid.dc.forEach((L) => add(L, true));
      // border flows from the `flows` attribute; key "A-B" alphabetical, + means A→B
      const borders = {}; lines.forEach((L) => { if (L.cross) { const k = [L.a, L.b].sort().join('-'); (borders[k] = borders[k] || []).push(L); } });
      // Flows come from the `flows` attribute. A border the payload does not
      // mention is left out entirely rather than filled with a plausible
      // number: the prototype's mock existed to make a demo move, and beside
      // real data an invented flow is indistinguishable from a measured one.
      const real = this.json('flows');
      const flows = {};
      Object.keys(borders).forEach((k) => { if (real && real[k] != null) flows[k] = real[k]; });
      const measured = Object.keys(flows).length;
      this.querySelector('[data-src]').textContent = 'grid + plants: ENTSO-E map extract (GridKit, 2022) · flows: '
        + (measured ? measured + ' borders, ENTSO-E physical' : 'awaiting data');
      const net = {}; codes.forEach((c) => { net[c] = 0; });
      Object.keys(flows).forEach((k) => {
        const [A, B] = k.split('-');
        if (net[A] != null) net[A] += flows[k];
        if (net[B] != null) net[B] -= flows[k];
      });
      // crossings: where flow enters/leaves each country
      const crossings = []; // {x, y, c, into: +mw entering country c}
      lines.forEach((L) => {
        if (!L.cross) return; const k = [L.a, L.b].sort().join('-');
        if (flows[k] == null) { L.cross = false; return; }
        const n = borders[k].length, f = flows[k] / n; // + = from k[0] to k[1]
        const [A, B] = k.split('-');
        L.mw = f; L.fromC = f >= 0 ? A : B; L.toC = f >= 0 ? B : A;
        crossings.push({ x: L.mid[0], y: L.mid[1], c: A, into: -f }); crossings.push({ x: L.mid[0], y: L.mid[1], c: B, into: f });
      });
      // per-segment signed direction + weight
      const segs = [], sigmaIn = 2.2 * sc * 40; // inland influence radius of a crossing (~ country scale)
      lines.forEach((L) => {
        for (let i = 0; i < L.pts.length - 1; i++) {
          const A = L.pts[i], B = L.pts[i + 1], dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy); if (len < 1e-6) continue;
          const ux = dx / len, uy = dy / len, mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
          let s = 0, w = 0;
          if (L.cross) {
            // flow from L.fromC end to L.toC end
            const fromFirst = L.a === L.fromC; s = fromFirst ? 1 : -1; w = Math.abs(L.mw);
          } else {
            const c = L.a || L.b; let vx = 0, vy = 0;
            crossings.forEach((k) => {
              if (k.c !== c) return; const ddx = mx - k.x, ddy = my - k.y, d = Math.hypot(ddx, ddy) || 1;
              const g = Math.abs(k.into) * Math.exp(-(d * d) / (2 * sigmaIn * sigmaIn));
              // importing crossing pushes away from itself, exporting pulls toward itself
              const sgn = k.into >= 0 ? 1 : -1; vx += sgn * g * ddx / d; vy += sgn * g * ddy / d;
            });
            const dot = vx * ux + vy * uy; s = dot >= 0 ? 1 : -1; w = Math.abs(dot);
          }
          if (w < 1) continue;
          segs.push({ A: A, dx: dx, dy: dy, L2: len * len, ux: s * ux, uy: s * uy, w: w, sigma: (L.cross ? 5 : 3.5) * sc, L: L });
        }
      });
      // fountains (plants) and wells (demand centres): radial field, strength ∝ MW, gaussian reach
      const P2 = (ll) => this._proj(ll);
      const wells = [];
      if (this._placesRaw) {
        this._placesRaw.plants.forEach((p) => { if (vals[p.c] == null && !(p.c === 'GB' && vals.UK != null)) return; const xy = P2(p.ll); wells.push({ x: xy[0], y: xy[1], s: +1, w: p.mw * 0.35, sig: (5 + Math.sqrt(p.mw / 1000) * 5) * sc }); });
        if (this.getAttribute('demand') !== 'false') this._placesRaw.demand.forEach((d) => { if (vals[d.c] == null && !(d.c === 'GB' && vals.UK != null)) return; const xy = P2(d.ll); wells.push({ x: xy[0], y: xy[1], s: -1, w: d.mw * 0.45, sig: (7 + Math.sqrt(d.mw / 1000) * 6) * sc }); });
      }
      this._wells = wells;
      // field
      const fx = new Float32Array(cols * rows), fy = new Float32Array(cols * rows), mag = new Float32Array(cols * rows);
      // bucket segments by grid cell for speed
      const bucket = new Map(), BK = 12;
      segs.forEach((s, i) => { const c0 = Math.floor((Math.min(s.A[0], s.A[0] + s.dx) - ox) / cell / BK), c1 = Math.floor((Math.max(s.A[0], s.A[0] + s.dx) - ox) / cell / BK), r0 = Math.floor((Math.min(s.A[1], s.A[1] + s.dy) - oy) / cell / BK), r1 = Math.floor((Math.max(s.A[1], s.A[1] + s.dy) - oy) / cell / BK); for (let r = r0 - 1; r <= r1 + 1; r++) for (let c = c0 - 1; c <= c1 + 1; c++) { const k = r * 4096 + c; if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(i); } });
      let vmax = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = r * cols + c; if (!raster[i * 4 + 3]) continue;
        const x = ox + c * cell, y = oy + r * cell; let sx = 0, sy = 0;
        const list = bucket.get(Math.floor(r / BK) * 4096 + Math.floor(c / BK)); if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const s = segs[list[q]]; const u = Math.max(0, Math.min(1, ((x - s.A[0]) * s.dx + (y - s.A[1]) * s.dy) / s.L2));
          const px = s.A[0] + s.dx * u, py = s.A[1] + s.dy * u, d = Math.hypot(x - px, y - py);
          if (d > s.sigma * 3) continue;
          const g = s.w * Math.exp(-(d * d) / (2 * s.sigma * s.sigma));
          sx += g * s.ux; sy += g * s.uy;
        }
        for (let q = 0; q < wells.length; q++) {
          const w = wells[q], ddx = x - w.x, ddy = y - w.y, d = Math.hypot(ddx, ddy); if (d > w.sig * 3 || d < 1e-6) continue;
          const g = w.w * Math.exp(-(d * d) / (2 * w.sig * w.sig)) * Math.min(1, d / (w.sig * 0.35));
          sx += w.s * g * ddx / d; sy += w.s * g * ddy / d;
        }
        fx[i] = sx; fy[i] = sy; mag[i] = Math.hypot(sx, sy); if (mag[i] > vmax) vmax = mag[i];
      }
      this._field = { fx: fx, fy: fy, mag: mag, cols: cols, rows: rows, cell: cell, ox: ox, oy: oy, vmax: vmax || 1, mask: raster };
      this._lines = lines; this._segs = segs; this._net = net; this._flows = flows;
      // one arrow per border: mean position of that border's crossing points
      const bg = {};
      Object.keys(borders).forEach((kk) => {
        const ls = borders[kk]; let sx = 0, sy = 0;
        ls.forEach((L) => { sx += L.mid[0]; sy += L.mid[1]; });
        const mx2 = sx / ls.length, my2 = sy / ls.length;
        // snap to the real crossing nearest the mean, so an arrow never floats off its border
        let best = ls[0], bd2 = Infinity;
        ls.forEach((L) => { const d = Math.hypot(L.mid[0] - mx2, L.mid[1] - my2); if (d < bd2) { bd2 = d; best = L; } });
        bg[kk] = { x: best.mid[0], y: best.mid[1], n: ls.length };
      });
      this._borderGeom = bg;
      this._maxNet = Math.max(1, Math.max.apply(null, Object.keys(net).map((k) => Math.abs(net[k]))));
      const sorted = Object.keys(net).map((k) => Math.abs(net[k])).sort((a, b) => a - b);
      this._netScale = Math.max(1, sorted[Math.floor(sorted.length * 0.72)] || this._maxNet);
      const n = Math.round(2200 * this.num('density', 1)); const ps = []; for (let i = 0; i < n; i++) ps.push(this.spawn(i)); this._particles = ps;
      const rounded = {}; Object.keys(net).forEach((k) => { rounded[k] = Math.round(net[k]); });
      this._netOut = rounded; window.dispatchEvent(new CustomEvent('able-map-net', { detail: rounded }));
      window.dispatchEvent(new CustomEvent('able-map-flows', { detail: { flows: this._flows, net: rounded } }));
      this.paint();
    }
    spawn(seed) {
      const F = this._field, B = this._box; let x, y, tries = 0;
      const src = this._wells && this._wells.filter((w) => w.s > 0);
      if (src && src.length && hash(seed + 'f' + (this._gen || 0)) < 0.25) {
        const w = src[Math.floor(hash(seed + 'w' + (this._gen || 0)) * src.length)], a = hash(seed + 'ang' + (this._gen || 0)) * 6.2832, r = w.sig * 0.4 * hash(seed + 'r' + (this._gen || 0));
        return { x: w.x + Math.cos(a) * r, y: w.y + Math.sin(a) * r, age: 0, life: 200 + Math.floor(hash(seed + 'l') * 260) };
      }
      do { x = B.ox + hash(seed + 'x' + tries + (this._gen || 0)) * B.bw; y = B.oy + hash(seed + 'y' + tries + (this._gen || 0)) * B.bh; tries++; }
      while (tries < 16 && (this.sample(x, y).m < F.vmax * 0.02));
      return { x: x, y: y, age: Math.floor(hash(seed + 'a') * 200), life: 220 + Math.floor(hash(seed + 'l') * 260) };
    }
    sample(x, y) {
      const F = this._field, gx = (x - F.ox) / F.cell, gy = (y - F.oy) / F.cell, c = Math.floor(gx), r = Math.floor(gy);
      if (c < 0 || r < 0 || c >= F.cols - 1 || r >= F.rows - 1) return { x: 0, y: 0, m: 0 };
      const u = gx - c, v = gy - r, i = r * F.cols + c, j = i + F.cols;
      const bl = (a) => a[i] * (1 - u) * (1 - v) + a[i + 1] * u * (1 - v) + a[j] * (1 - u) * v + a[j + 1] * u * v;
      const sx = bl(F.fx), sy = bl(F.fy); return { x: sx, y: sy, m: Math.hypot(sx, sy) };
    }

    // ---- drawing -------------------------------------------------------------------------------
    draw(topo) {
      this._features = feature(topo, topo.objects.countries).features;
      // shared-border adjacency, so a mis-projected grid line cannot invent a border pair
      this._adj = {};
      try {
        const nb = neighbors(topo.objects.countries.geometries);
        nb.forEach((list, i) => { const a = ALPHA[this._features[i].id]; if (!a) return; list.forEach((j) => { const b = ALPHA[this._features[j].id]; if (b) this._adj[[a, b].sort().join('-')] = 1; }); });
      } catch (e) { this._adj = null; }
      const svg = select(this.querySelector('svg'));
      this._svg = svg; this._g = svg.append('g');
      this._proj = geoMercator(); this._path = geoPath(this._proj);
      const uid = 'nm' + Math.floor(Math.random() * 1e6);
      const defs = svg.append('defs');
      defs.append('filter').attr('id', uid + 'b').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%')
        .append('feGaussianBlur').attr('stdDeviation', 4);
      this._blur = defs.select('filter').select('feGaussianBlur');
      this._coastBlur = defs.append('filter').attr('id', uid + 'g').attr('x', '-35%').attr('y', '-35%').attr('width', '170%').attr('height', '170%')
        .append('feGaussianBlur').attr('stdDeviation', 2);
      this._rimBlur = defs.append('filter').attr('id', uid + 'r').attr('x', '-35%').attr('y', '-35%').attr('width', '170%').attr('height', '170%')
        .append('feGaussianBlur').attr('stdDeviation', 3);
      this._coastG = this._g.append('g').attr('pointer-events', 'none').attr('filter', 'url(#' + uid + 'g)');
      this._netG = this._g.append('g').attr('pointer-events', 'none').append('g');
      this._paths = this._g.selectAll('path.c').data(this._features).join('path').attr('class', 'c')        .attr('stroke-linejoin', 'round')
        .on('mouseenter', (e, f) => { const c = ALPHA[f.id]; if (c && this.values()[c] != null) { this._hover = c; this.paint(); window.dispatchEvent(new CustomEvent('able-map-hover', { detail: { code: c, net: Math.round((this._net || {})[c] || 0) } })); } })
        .on('mouseleave', () => { if (this._hover) { this._hover = null; this.paint(); window.dispatchEvent(new CustomEvent('able-map-hover', { detail: null })); } })
        .on('click', (e, f) => { const c = ALPHA[f.id]; if (c && this.values()[c] != null) window.dispatchEvent(new CustomEvent('able-map-pick', { detail: c })); });
      this._rimG = this._g.append('g').attr('pointer-events', 'none').attr('filter', 'url(#' + uid + 'r)');
      this._outline = this._g.append('path').attr('fill', 'none').attr('stroke', this.theme().outline).attr('stroke-linejoin', 'round').attr('pointer-events', 'none');
      this._zt = zoomIdentity;
      this._zoom = zoom().scaleExtent([1, 24])
        .wheelDelta((e) => -e.deltaY * (e.deltaMode === 1 ? 0.12 : e.deltaMode ? 1 : 0.003))
        .on('start', (e) => { if (e.sourceEvent) { this._user = true; this._svg.style('cursor', 'grabbing'); } })
        .on('end', () => this._svg.style('cursor', 'grab'))
        // The transform is applied synchronously, so panning stays instant. The
        // repaints it used to do here are deferred to the next frame instead:
        // d3-zoom fires faster than vsync on a wheel fling, and every repaint
        // but the last was composited by nobody. strokes() and paintPlaces()
        // both read the current _zt when they run, so deferring cannot show a
        // stale transform.
        .on('zoom', (e) => { this._zt = e.transform; this._g.attr('transform', e.transform); this._zoomDirty = true; });
      svg.call(this._zoom).on('dblclick.zoom', (e) => { const [x, y] = pointer(e); this._user = true; svg.transition().duration(400).call(this._zoom.scaleBy, 2, [x, y]); });
      svg.on('mousemove', (e) => this.hoverLine(e)).on('mouseleave', () => { this._tip.style.display = 'none'; });
      svg.on('click', (e) => { if (e.target === svg.node() || e.target.tagName === 'svg') window.dispatchEvent(new CustomEvent('able-map-pick', { detail: null })); });
      this.resize(); this.buildNetwork(); this.zoomTo('europe', 0);
      const loop = (ts) => { this.frame(ts); this._raf = requestAnimationFrame(loop); };
      this._raf = requestAnimationFrame(loop);
    }
    resize() {
      if (!this._proj) return;
      const w = this.clientWidth || 800, h = this.clientHeight || 480, dpr = window.devicePixelRatio || 1;
      const changed = w !== this._w || h !== this._h;
      this._w = w; this._h = h; this._dpr = dpr;
      this._svg.attr('viewBox', '0 0 ' + w + ' ' + h);
      this._canvas.width = w * dpr; this._canvas.height = h * dpr; this._pc.width = w * dpr; this._pc.height = h * dpr;
      this._proj.fitSize([w, h], { type: 'Polygon', coordinates: [[[-180, 83], [180, 83], [180, -58], [-180, -58], [-180, 83]]] });
      this._paths.attr('d', this._path);
      if (!this._netPaths) {
        const set = this._features.filter((f) => ALPHA[f.id] && this.values()[ALPHA[f.id]] != null);
        this._netPaths = this._netG.selectAll('path').data(set).join('path').attr('stroke', 'none');
        this._rimPaths = this._rimG.selectAll('path').data(set).join('path').attr('fill', 'none').attr('stroke-linejoin', 'round');
        this._coastPaths = this._coastG.selectAll('path').data(this._features).join('path').attr('fill', 'none').attr('stroke-linejoin', 'round');
      }
      this._rimPaths.attr('d', this._path);
      this._coastPaths.attr('d', this._path);
      this._netPaths.attr('d', this._path);
      this._placesDirty = true;
      if (this._features) {
        const cen = {};
        this._features.forEach((f) => { const c = ALPHA[f.id]; if (!c) return; const p = this._path.centroid(f); if (p && !isNaN(p[0])) cen[c] = p; });
        cen.FR = this._proj([2.4, 46.6]); cen.NO = this._proj([9.2, 61.2]); cen.DK = this._proj([9.6, 56.1]);
        cen.GB = this._proj([-1.8, 53.2]); cen.IT = this._proj([12.4, 42.8]); cen.ES = this._proj([-3.7, 40.2]);
        cen.PT = this._proj([-8.2, 39.6]); cen.NL = this._proj([5.6, 52.2]); cen.GR = this._proj([22.5, 39.6]);
        this._cen = cen;
        this._seas = SEAS.map((s) => ({ n: s.n, xy: this._proj(s.ll), sz: s.sz }));
      }
      if (this._placesRaw) { const P = (ll) => this._proj(ll); this._plants = this._placesRaw.plants.map((p) => Object.assign({ xy: P(p.ll) }, p)); this._demand = this._placesRaw.demand.map((d) => Object.assign({ xy: P(d.ll) }, d)); }
      this._zoom.translateExtent([[0, 0], [w, h]]).extent([[0, 0], [w, h]]);
      this.paint();
      if (this._grid && changed && this._field) this.buildNetwork();
      if (!this._user) this.zoomTo(this._view || 'europe', 0);
    }
    strokes() {
      const k = this._zt.k || 1;
      const hv = this._hover;
      const vals = this.values();
      const T = this.theme(), bd = this.getAttribute('borders') === 'true', glow = this.getAttribute('glow') === 'true';
      this._paths
        .attr('stroke', (f) => { const c = ALPHA[f.id]; if (c && c === hv) return T.outline; if (!c || vals[c] == null) return 'none'; if (bd) return rgba(T.outline, 0.3); return glow ? rgba(T.outline, 0.42) : rgba(T.bg, 0.55); })
        .attr('stroke-width', (f) => { const c = ALPHA[f.id]; return (c && c === hv ? 1.4 : 0.8) / k; });
      this._outline.attr('stroke-width', 2.2 / k).attr('stroke', '#EAFFFB');
      if (this._coastPaths) {
        this._coastPaths
          .attr('stroke', (f) => { if (!glow) return 'none'; const c = ALPHA[f.id]; return rgba(T.glow || T.exp, c && vals[c] != null ? 0.55 : 0.16); })
          .attr('stroke-width', 2.2 / k);
        this._coastBlur.attr('stdDeviation', 1.9 / k);
      }
      if (this._rimPaths) {
        const net = this._net || {}, mxn = this._maxNet || 1, act = this.getAttribute('active');
        const col = (c) => {
          if (this._fillOf && (this.attr('scalars') || this.attr('fills'))) return this._fillOf(c) || T.exp;
          const v = net[c] || 0;
          return Math.abs(v) < mxn * 0.06 ? (T.label || T.exp) : (v >= 0 ? T.exp : T.imp);
        };
        this._rimPaths
          .attr('stroke', (f) => { if (!glow) return 'none'; const c = ALPHA[f.id]; if (!c || vals[c] == null) return 'none'; return rgba(c === act ? '#BFF3EE' : col(c), c === act ? 0.9 : 0.5); })
          .attr('stroke-width', (f) => { const c = ALPHA[f.id]; return (c && c === act ? 5.5 : 3.2) / k; });
        this._rimBlur.attr('stdDeviation', 2.6 / k);
      }
    }
    paint() {
      const vals = this.values(), active = this.getAttribute('active'), net = this._net || {}, mx = this._maxNet || 1;
      // flat two-tone: exporting / importing / near-balanced. No gradient, no blur.
      const T = this.theme();
      let sc = null, stops = null;
      try { sc = JSON.parse(this.attr('scalars') || 'null'); } catch (e) { sc = null; }
      if (sc) stops = (this.attr('scalar-colors') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const fx = this.json('fills');
      const fill = (c) => {
        if (fx && fx[c]) return fx[c];
        if (sc && stops && stops.length > 1) { const t = sc[c]; return t == null ? T.dnl : ramp(stops, t); }
        const v = net[c] || 0;
        if (!T.scale) { if (Math.abs(v) < mx * 0.06) return T.dnl; return v >= 0 ? T.exp : T.imp; }
        const t = Math.max(0.14, Math.min(1, Math.pow(Math.abs(v) / (this._netScale || mx), 0.85)));
        return lerp(T.dnl, v >= 0 ? T.exp : T.imp, t);
      };
      this._fillOf = fill;
      if (this._netPaths) this._netPaths.attr('fill', (f) => fill(ALPHA[f.id])).attr('fill-opacity', this.num('fillop', T.fillOp));
      this._paths
        .attr('fill', (f) => { const c = ALPHA[f.id]; return c && vals[c] != null ? T.dataLand : T.land; })
        .attr('fill-opacity', (f) => { const c = ALPHA[f.id]; return !c || vals[c] == null ? 1 : 0; })
        .style('cursor', (f) => { const c = ALPHA[f.id]; return c && vals[c] != null ? 'pointer' : 'default'; });
      const af = this._features.find((f) => ALPHA[f.id] === active);
      this._outline.attr('d', af ? this._path(af) : null);
      this.strokes();
      this.clearCanvas(); this.paintPlaces();
    }
    clearCanvas() { if (this._ctx) { this._ctx.setTransform(1, 0, 0, 1, 0, 0); this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height); } }
    frame(ts) {
      const ctx = this._ctx; if (!ctx || !this._field) return;
      const t = this._zt, dpr = this._dpr, active = this.getAttribute('active');
      const dt = Math.min(0.05, (ts - (this._last || ts)) / 1000); this._last = ts;
      // Zoom deferred its repaint to here (see the zoom handler). Consume the
      // flag before drawing so a zoom landing mid-frame is not dropped.
      const zoomDirty = this._zoomDirty; this._zoomDirty = false;
      if (zoomDirty) { this.strokes(); this.clearCanvas(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = 'rgba(0,0,0,' + (this.theme().additive ? 0.94 : 0.955) + ')'; ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.x * dpr, t.y * dpr);
      const k = t.k, W = this.num('width', 1), grid = this.getAttribute('grid') === 'true', T = this.theme();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const poly = (L) => { ctx.beginPath(); L.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); };
      if (grid) { ctx.strokeStyle = T.grid; ctx.lineWidth = 0.9 / k; this._lines.forEach(poly); }
      // breathing glow on the selected country's cross-border lines
      const breathe = 0.5 + 0.3 * Math.sin(ts / 1100);
      this._lines.forEach((L) => {
        if (!L.cross || (L.a !== active && L.b !== active)) return;
        const col = L.fromC === active ? T.exp : T.imp;
        ctx.strokeStyle = rgba(col, 0.1 * breathe); ctx.lineWidth = (3 + Math.abs(L.mw) / 500) / k; poly(L);
      });
      // Windy-style particles
      const F = this._field, speed = this.num('speed', 1) * 150 / k / F.vmax * dt;
      const boost = active ? 1 : 1.5; // nothing selected: the flow field is the whole story
      if (T.additive) ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = W * 1.15 / k;
      for (let i = 0; i < this._particles.length; i++) {
        const p = this._particles[i], v = this.sample(p.x, p.y);
        if (p.age++ > p.life || v.m < F.vmax * 0.01) { this._gen = (this._gen || 0) + 1; this._particles[i] = this.spawn(i); continue; }
        const nx = p.x + v.x * speed, ny = p.y + v.y * speed;
        if ((i & 7) === 0 && this._wells) { const ws = this._wells; for (let q = 0; q < ws.length; q++) { const w = ws[q]; if (w.s < 0 && Math.hypot(nx - w.x, ny - w.y) < w.sig * 0.3) { p.age = p.life + 1; break; } } }
        const inten = Math.min(1, Math.sqrt(v.m / F.vmax));
        const fade = Math.min(1, p.age / 30) * Math.min(1, (p.life - p.age) / 30);
        const col = lerp(T.pFrom, T.pTo, inten);
        if (T.additive && inten > 0.42) {
          ctx.lineWidth = W * 3.6 / k;
          ctx.strokeStyle = rgba(col, 0.1 * inten * fade * boost);
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
          ctx.lineWidth = W * 1.15 / k;
        }
        ctx.strokeStyle = rgba(col, Math.min(0.95, (0.24 + 0.55 * inten) * fade * boost));
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
        p.x = nx; p.y = ny;
      }
      ctx.globalCompositeOperation = 'source-over';
      // `|| zoomDirty` keeps the old guarantee that a zoom refreshes the places
      // canvas even when arcs are off, which the synchronous call used to give.
      if (this.getAttribute('arcs') === 'true' || zoomDirty) this.paintPlaces();
    }
    plantMin(k) { return 6000 / Math.pow(k, 1.35); }
    markerFade(k) { const k0 = (this._kEurope || 6) * 1.35; return Math.max(0, Math.min(1, (k - k0) / (k0 * 0.5))); }
    plantR(mw, k) { return (1.1 + Math.sqrt(mw / 1000) * 1.5) / k; }
    paintPlaces() {
      const ctx = this._pctx; if (!ctx || !this._w) return;
      const t = this._zt, dpr = this._dpr, k = t.k;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this._pc.width, this._pc.height);
      ctx.setTransform(k * dpr, 0, 0, k * dpr, t.x * dpr, t.y * dpr);
      const showP = this.getAttribute('plants') !== 'false', vals = this.values();
      const T = this.theme(), active = this.getAttribute('active'), cen = this._cen || {};
      const ts = this._last || 0, net = this._net || {}, kE = this._kEurope || 6;
      const zoomFade = Math.max(0, Math.min(1, (k - kE * 0.55) / (kE * 0.35)));
      // narrow map panes cannot carry every label: keep the active zone and the big ones only
      const room = Math.max(0, Math.min(1, ((this._w || 800) - 420) / 360));
      const BIG = { DE:1, FR:1, ES:1, IT:1, PL:1, GB:1, SE:1, NO:1, FI:1, RO:1, GR:1 };

      if (this.getAttribute('seas') === 'true' && this._seas && zoomFade > 0.05) {
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        this._seas.forEach((s) => {
          ctx.font = 'italic 300 ' + (s.sz / k) + "px 'IBM Plex Sans', sans-serif";
          ctx.fillStyle = rgba(T.sea || '#4A6A7A', 0.6 * zoomFade);
          ctx.fillText(s.n, s.xy[0], s.xy[1]);
        });
        ctx.restore();
      }

      // corridor arrows: one per border, at the border itself, so the continental pattern reads at a glance
      if (this.getAttribute('arcs') === 'true' && this._flows && this._borderGeom) {
        const G = this._borderGeom, keys = Object.keys(this._flows);
        const ranked = keys.slice().sort((a, b) => Math.abs(this._flows[b]) - Math.abs(this._flows[a]));
        const topN = active ? 0 : (room > 0.45 ? 8 : 4);
        const big = {}; ranked.slice(0, topN).forEach((kk) => { big[kk] = 1; });
        const draw = (kk) => {
          const g = G[kk]; if (!g) return;
          const f = this._flows[kk], parts = kk.split('-');
          const from = f >= 0 ? parts[0] : parts[1], to = f >= 0 ? parts[1] : parts[0];
          const A = cen[from], B = cen[to]; if (!A || !B) return;
          const gw = Math.abs(f) / 1000;
          const hot = !!active && parts.indexOf(active) >= 0;
          const dim = !!active && !hot;
          let ux = B[0] - A[0], uy = B[1] - A[1]; const d = Math.hypot(ux, uy) || 1; ux /= d; uy /= d;
          // size: sqrt of transfer, so a 4 GW corridor reads twice a 1 GW one
          const sq = Math.sqrt(gw);
          const len = (13 + sq * 15) / k, half = (2.2 + sq * 3.4) / k, headW = half * 2.5, headL = len * 0.42;
          const cxp = g.x, cyp = g.y;
          const tx = cxp - ux * len * 0.5, ty = cyp - uy * len * 0.5;
          const hx = cxp + ux * len * 0.5, hy = cyp + uy * len * 0.5;
          const nx = -uy, ny = ux;
          const bx = hx - ux * headL, by = hy - uy * headL;
          const col = hot ? (from === active ? T.exp : T.imp) : (T.pTo || '#9BF0E6');
          const a = hot ? 0.95 : dim ? 0.3 : 0.8;
          const pulse = 0.85 + 0.15 * Math.sin(ts / 900 + (cxp + cyp) * 0.05);
          ctx.beginPath();
          ctx.moveTo(tx + nx * half * 0.55, ty + ny * half * 0.55);
          ctx.lineTo(bx + nx * half, by + ny * half);
          ctx.lineTo(bx + nx * headW, by + ny * headW);
          ctx.lineTo(hx, hy);
          ctx.lineTo(bx - nx * headW, by - ny * headW);
          ctx.lineTo(bx - nx * half, by - ny * half);
          ctx.lineTo(tx - nx * half * 0.55, ty - ny * half * 0.55);
          ctx.closePath();
          ctx.fillStyle = rgba(col, a * (hot ? pulse : 1));
          ctx.shadowColor = rgba(col, hot ? 0.9 : 0.5); ctx.shadowBlur = (hot ? 16 : 9);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = rgba(T.bg, 0.55); ctx.lineWidth = 0.7 / k; ctx.stroke();
          const labelIt = this.attr('values-on') !== 'false' && (hot || big[kk]) && (room > 0.25 || k > kE * 1.6);
          if (labelIt) {
            const txt = gw.toFixed(1), off = (half + 11 / k);
            ctx.font = '500 ' + (10.5 / k) + "px 'IBM Plex Mono', monospace";
            const w = ctx.measureText(txt).width, ph = 15 / k, pw = w + 10 / k;
            const lx = cxp + nx * off, ly = cyp + ny * off;
            ctx.fillStyle = rgba(T.bg, 0.86);
            ctx.beginPath(); ctx.rect(lx - pw / 2, ly - ph / 2, pw, ph); ctx.fill();
            ctx.fillStyle = rgba(col, 1); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(txt, lx, ly);
          }
        };
        ranked.slice().reverse().forEach((kk) => { if (!active || kk.split('-').indexOf(active) < 0) draw(kk); });
        if (active) ranked.forEach((kk) => { if (kk.split('-').indexOf(active) >= 0) draw(kk); });
      }

      if (active && cen[active]) {
        const c0 = cen[active], r = 30 / k, v = net[active] || 0;
        const g = ctx.createRadialGradient(c0[0], c0[1], 0, c0[0], c0[1], r);
        const col = v >= 0 ? T.exp : T.imp;
        g.addColorStop(0, rgba(col, 0.5)); g.addColorStop(0.55, rgba(col, 0.14)); g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c0[0], c0[1], r, 0, 6.2832); ctx.fill();
      }

      if (this.getAttribute('labels') === 'true' && Object.keys(cen).length) {
        const chips = this.json('chips'), donuts = this.json('donuts');
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        Object.keys(vals).forEach((c) => {
          const p = cen[c] || (c === 'UK' ? cen.GB : null); if (!p) return;
          const on = c === active;
          if (!on && !BIG[c] && room < 0.45 && k < kE * 1.5) return;
          const chip = chips && chips[c], ring = donuts && donuts[c];
          const fs = (on ? 13 : 11.5) / k, lh = fs * 1.25;
          let x = p[0], y = p[1];
          if (ring && ring.length) {
            const rr = (on ? 13 : 10.5) / k, thick = rr * 0.42;
            const gap = rr + 5 / k;
            const cxr = x - gap, cyr = y;
            x += rr * 0.5;
            ctx.beginPath(); ctx.arc(cxr, cyr, rr, 0, 6.2832);
            ctx.fillStyle = rgba(T.bg, 0.9); ctx.fill();
            let a0 = -Math.PI / 2;
            ring.forEach((sg) => {
              const a1 = a0 + Math.max(0, sg[1]) * 6.2832;
              ctx.beginPath(); ctx.arc(cxr, cyr, rr - thick / 2, a0, a1);
              ctx.lineWidth = thick; ctx.strokeStyle = sg[0]; ctx.stroke();
              a0 = a1;
            });
            ctx.beginPath(); ctx.arc(cxr, cyr, rr, 0, 6.2832);
            ctx.lineWidth = 0.8 / k; ctx.strokeStyle = rgba(T.bg, 0.8); ctx.stroke();
          }
          const cy0 = chip ? y - lh * 0.45 : y;
          ctx.font = '500 ' + fs + "px 'IBM Plex Mono', monospace";
          ctx.lineWidth = 3 / k; ctx.strokeStyle = rgba(T.bg, 0.75);
          ctx.strokeText(c, x, cy0);
          ctx.fillStyle = on ? '#FFFFFF' : rgba(T.label || T.panelText, 0.8 * (0.45 + 0.55 * zoomFade));
          ctx.fillText(c, x, cy0);
          if (chip) {
            ctx.font = '500 ' + (fs * 1.02) + "px 'IBM Plex Mono', monospace";
            ctx.lineWidth = 3 / k; ctx.strokeStyle = rgba(T.bg, 0.8);
            ctx.strokeText(chip, x, cy0 + lh);
            ctx.fillStyle = on ? '#FFFFFF' : rgba(T.label || T.panelText, 0.95 * (0.5 + 0.5 * zoomFade));
            ctx.fillText(chip, x, cy0 + lh);
          }
        });
        ctx.restore();
      }

      if (showP && this._plants) {
        const fade = this.markerFade(k);
        if (fade > 0.01) {
          const min = this.plantMin(k); ctx.lineWidth = 0.9 / k;
          this._plants.forEach((p) => { if (p.mw < min) return; if (vals[p.c] == null && !(p.c === 'GB' && vals.UK != null)) return; const col = FAM[p.f] || '#0B0E12'; ctx.strokeStyle = rgba(col, 0.75 * fade); ctx.fillStyle = rgba(col, 0.16 * fade); ctx.beginPath(); ctx.arc(p.xy[0], p.xy[1], this.plantR(p.mw, k), 0, 6.2832); ctx.fill(); ctx.stroke(); });
        }
      }
    }
    hoverLine(ev) {
      if (!this._segs) return;
      const [mx, my] = pointer(ev, this.querySelector('svg'));
      const t = this._zt, inv = [(mx - t.x) / t.k, (my - t.y) / t.k];
      const fmtN = (v) => Math.round(v).toLocaleString('en-US').replace(/,/g, ' ');
      const show = (txt) => { this._tip.textContent = txt; this._tip.style.display = 'block'; this._tip.style.left = (mx + 12) + 'px'; this._tip.style.top = (my - 28) + 'px'; };
      const k = t.k, sk = Math.sqrt(k);
      if (this.getAttribute('plants') !== 'false' && this._plants && this.markerFade(k) > 0.3) {
        const min = this.plantMin(k); let hp = null, hd = 1e9;
        this._plants.forEach((p) => { if (p.mw < min) return; const r = this.plantR(p.mw, k) + 2 / k, d = Math.hypot(inv[0] - p.xy[0], inv[1] - p.xy[1]); if (d < r && d < hd) { hd = d; hp = p; } });
        if (hp) return show(hp.n + ' · ' + hp.f + ' · ' + fmtN(hp.mw) + ' MW');
      }
      let best = null, bd = 6 / t.k;
      for (let i = 0; i < this._segs.length; i++) {
        const s = this._segs[i], u = Math.max(0, Math.min(1, ((inv[0] - s.A[0]) * s.dx + (inv[1] - s.A[1]) * s.dy) / s.L2));
        const d = Math.hypot(inv[0] - (s.A[0] + s.dx * u), inv[1] - (s.A[1] + s.dy * u));
        if (d < bd) { bd = d; best = s.L; }
      }
      if (!best) { this._tip.style.display = 'none'; return; }
      const fmt = (v) => Math.round(Math.abs(v)).toLocaleString('en-US').replace(/,/g, ' ');
      const kind = (best.dc ? 'HVDC' : best.v + ' kV');
      const label = best.cross ? best.fromC + ' → ' + best.toC + ' · ' + fmt(best.mw) + ' MW · ' + kind : (best.a || best.b) + ' · ' + kind;
      this._tip.textContent = label; this._tip.style.display = 'block';
      this._tip.style.left = (mx + 12) + 'px'; this._tip.style.top = (my - 28) + 'px';
    }
    zoomTo(view, dur) {
      if (!this._proj) return;
      this._view = view; if (dur !== 0) this._user = false;
      const w = this._w, h = this._h;
      let t;
      if (view === 'world') t = zoomIdentity;
      else {
        const pts = [[-11, 62], [33, 62], [-11, 36], [33, 36]].map((p) => this._proj(p));
        const b = [[Math.min.apply(null, pts.map((p) => p[0])), Math.min.apply(null, pts.map((p) => p[1]))], [Math.max.apply(null, pts.map((p) => p[0])), Math.max.apply(null, pts.map((p) => p[1]))]];
        const dx = b[1][0] - b[0][0], dy = b[1][1] - b[0][1], cx = (b[0][0] + b[1][0]) / 2, cy = (b[0][1] + b[1][1]) / 2;
        const k = Math.min(24, 0.98 / Math.max(dx / w, dy / h)); this._kEurope = k;
        t = zoomIdentity.translate(w / 2 - k * cx, h / 2 - k * cy).scale(k);
      }
      const sel = dur === 0 ? this._svg : this._svg.transition().duration(dur == null ? 700 : dur).ease(easeCubicInOut);
      sel.call(this._zoom.transform, t);
    }
  }
/** Registers <able-world-map>. Idempotent — safe to call on every mount. */
export function defineAbleWorldMap() {
  if (!customElements.get('able-world-map')) customElements.define('able-world-map', AbleWorldMap);
}
