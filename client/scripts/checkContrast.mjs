// Contrast gate for the light-mode design tokens.
//
// The ink ramp is the whole readability story of this UI: almost every label,
// unit, axis tick, legend caption and card subtitle is one of three muted
// tokens, at 10.5-12px. `--ink-muted` shipped at 3.5:1 on white — under the
// WCAG AA 4.5:1 floor — while carrying the *smallest* type in the product.
// That is the kind of regression nobody notices in review and everybody
// notices at a desk, so it gets a check rather than a comment.
//
// Run: npm run check:contrast   (exits non-zero on a failure)
//
// Scope is deliberately narrow: the `:root` block only. `.dark` is a coarse
// unfinished retune that no user can currently reach (themeStore defaults to
// light and ThemeToggle is not mounted) — checking it would report failures
// against a surface nobody sees and bury the ones that matter.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/index.css'), 'utf8');

/** Pull the `:root { … }` block, so `.dark`'s same-named vars can't shadow it. */
function rootBlock(source) {
  const start = source.indexOf(':root');
  if (start === -1) throw new Error('no :root block in index.css');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error('unterminated :root block');
}

/** `--ink-muted: 48 6% 43%;` → { 'ink-muted': [48, 6, 43] } */
function parseTokens(block) {
  const out = {};
  const re = /--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

/** HSL (h in degrees, s/l in percent) → [r, g, b] in 0-255. */
function hslToRgb([h, s, l]) {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = L - c / 2;
  return [r1 + m, g1 + m, b1 + m].map((v) => Math.round(v * 255));
}

/** WCAG 2.1 relative luminance. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = parseTokens(rootBlock(css));
const rgb = (name) => {
  if (!tokens[name]) throw new Error(`token --${name} not found in :root`);
  return hslToRgb(tokens[name]);
};

// Text sits on exactly two surfaces: --card (panels, stat tiles, popovers)
// and --background (the page itself). Both are checked; the tighter one wins.
const SURFACES = ['card', 'background'];

// AA normal text. Every one of these tokens is used for prose or numbers at
// or below 14px, so the large-text 3:1 allowance never applies to them.
const TEXT_TOKENS = ['foreground', 'muted-foreground', 'ink-muted', 'primary'];

// Non-text UI: borders, rules, gridlines, disabled chart arcs. AA 1.4.11
// asks 3:1 for these. --ink-faint is here rather than in TEXT_TOKENS on
// purpose — see the comment on the token in index.css.
const UI_TOKENS = ['ink-faint'];

let failed = 0;
const check = (token, floor, kind) => {
  for (const surface of SURFACES) {
    const ratio = contrast(rgb(token), rgb(surface));
    const ok = ratio >= floor;
    if (!ok) failed++;
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(
      `${mark}  --${token.padEnd(16)} on --${surface.padEnd(11)} ` +
        `${ratio.toFixed(2)}:1  (${kind}, needs ${floor}:1)`,
    );
  }
};

console.log('Light-mode token contrast (WCAG 2.1)\n');
for (const t of TEXT_TOKENS) check(t, 4.5, 'text');
for (const t of UI_TOKENS) check(t, 3.0, 'non-text UI');

if (failed > 0) {
  console.error(`\n${failed} token/surface pair(s) below the floor.`);
  process.exit(1);
}
console.log('\nAll token/surface pairs clear their floor.');
