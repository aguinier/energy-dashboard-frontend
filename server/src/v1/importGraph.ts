import fs from 'node:fs';
import path from 'node:path';

/**
 * A static reader for "what can this module actually reach?".
 *
 * ABL-293 §2f asks for the public app's isolation to be *checkable*, not
 * asserted: "a test asserts the import graph: the module list reachable from
 * `createPublicApp` contains no ops/write module." A route-by-route 404 test
 * proves what is unreachable *today*; this proves the handler is not in the
 * binary at all, which is the claim that survives someone reordering
 * middleware.
 *
 * It is deliberately a static text walk rather than anything that imports the
 * entry module. Importing it would prove reachability by running the very code
 * under test — and would open the shared database and start schedulers as a
 * side effect the moment somebody wired one in, which is exactly the failure
 * this is meant to catch.
 *
 * Colocated test drives it through injected I/O; the real run reads the working
 * tree, so a stale committed copy cannot mask an edit.
 */

export interface ModuleGraph {
  /**
   * Every local module reachable from the entry, including the entry, as
   * repo-relative POSIX paths. Sorted, so a diff of two graphs is readable.
   */
  modules: string[];
  /** Bare specifiers (`express`, `node:fs`) reached but not followed. Sorted. */
  packages: string[];
  /**
   * Relative specifiers that resolved to nothing on disk, as
   * `importer -> specifier`.
   *
   * A security control that silently under-reports is worse than none: an
   * unresolvable specifier means the walk stopped early and the graph below it
   * is missing. The caller is expected to assert this is empty rather than to
   * treat it as a warning.
   */
  unresolved: string[];
}

export interface ImportGraphIo {
  readFile(absPath: string): string;
  isFile(absPath: string): boolean;
}

const realIo: ImportGraphIo = {
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  isFile: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
};

/**
 * Strip comments so a commented-out import is not read as an edge.
 *
 * The `[^:'"\\]` guard before `//` keeps `https://…` inside a string literal
 * from swallowing the rest of the line. This is a lexer's job done with a
 * regex, and it is good enough here because it errs toward *keeping* text:
 * anything it fails to strip can only add edges to the graph, and an extra edge
 * makes the isolation assertion stricter, never laxer.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** `import ... from 'x'` / `export ... from 'x'`, including the `type` forms. */
const FROM_CLAUSE = /(?:^|[\n;{}])\s*(import|export)\s+(type\s+)?([^'"();]*?)\bfrom\s*['"]([^'"]+)['"]/g;
/** `import 'x'` — a side-effect import, which is a runtime edge with no bindings. */
const SIDE_EFFECT = /(?:^|[\n;{}])\s*import\s*['"]([^'"]+)['"]/g;
/** `import('x')` with a literal specifier. A dynamic specifier is not statically knowable. */
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export interface CollectedSpecifiers {
  /** Specifiers that survive compilation and can execute code. */
  runtime: string[];
  /** `import type` / `export type` clauses. Erased by `tsc`, so not runtime edges. */
  typeOnly: string[];
}

/**
 * Pull the import specifiers out of one module's source.
 *
 * Whole-statement `import type` is classified as type-only because `tsc` erases
 * it — `lib/opsStatusThresholds.ts` relies on exactly that property to import
 * types from DB-touching modules without pulling the database in, and CLAUDE.md
 * recommends the shape. An inline `import { type X }` is *not* special-cased:
 * it is counted as a runtime edge even though TypeScript may elide it. That is
 * the conservative direction — over-counting can only make the caller's
 * "nothing forbidden is reachable" assertion harder to pass.
 */
export function collectImportSpecifiers(source: string): CollectedSpecifiers {
  const clean = stripComments(source);
  const runtime = new Set<string>();
  const typeOnly = new Set<string>();

  for (const m of clean.matchAll(FROM_CLAUSE)) {
    const isTypeOnly = m[2] !== undefined;
    (isTypeOnly ? typeOnly : runtime).add(m[4]);
  }
  for (const m of clean.matchAll(SIDE_EFFECT)) runtime.add(m[1]);
  for (const m of clean.matchAll(DYNAMIC)) runtime.add(m[1]);

  // A module imported for both its type and its value is a runtime edge.
  for (const spec of runtime) typeOnly.delete(spec);

  return { runtime: [...runtime], typeOnly: [...typeOnly] };
}

/** Relative specifiers are ours to follow; everything else is a package. */
function isLocal(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Resolve a relative specifier to a file on disk.
 *
 * This codebase writes ESM-style `.js` extensions in TypeScript source
 * (`import routes from './routes/index.js'`), so the `.js` -> `.ts` rewrite is
 * the common case and is tried first.
 */
function resolveLocal(fromFile: string, specifier: string, io: ImportGraphIo): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = base.endsWith('.js')
    ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx', base]
    : [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];

  return candidates.find((candidate) => io.isFile(candidate)) ?? null;
}

/** Repo-relative POSIX path, so assertions read the same on Windows and Linux. */
function relative(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/**
 * Walk every runtime edge reachable from `entryFile`.
 *
 * `root` is what module paths are reported relative to — pass `server/src` and
 * the graph reads `v1/publicApp.ts`, `routes/ops.ts`.
 */
export function walkModuleGraph(
  entryFile: string,
  root: string,
  io: ImportGraphIo = realIo
): ModuleGraph {
  const entry = path.resolve(entryFile);
  const modules = new Set<string>();
  const packages = new Set<string>();
  const unresolved = new Set<string>();
  const queue = [entry];
  const visited = new Set<string>([entry]);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    modules.add(relative(root, current));

    for (const specifier of collectImportSpecifiers(io.readFile(current)).runtime) {
      if (!isLocal(specifier)) {
        packages.add(specifier);
        continue;
      }
      const resolved = resolveLocal(current, specifier, io);
      if (resolved === null) {
        unresolved.add(`${relative(root, current)} -> ${specifier}`);
        continue;
      }
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push(resolved);
    }
  }

  const sorted = (set: Set<string>) => [...set].sort();
  return { modules: sorted(modules), packages: sorted(packages), unresolved: sorted(unresolved) };
}
