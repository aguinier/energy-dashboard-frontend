import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderOpenApiDocument } from './spec.js';

/**
 * Write the published OpenAPI artifact.
 *
 * ```
 * npm run openapi:generate -w server
 * ```
 *
 * The artifact is a **committed file**, not a build output, and that is the
 * point of ABL-305: a spec generated at deploy time is a spec no reviewer ever
 * reads, and a change to the public contract that produces no diff is a change
 * nobody approved. `drift.test.ts` fails when the committed file differs from
 * what this script would write, so the diff has to be in the same commit as the
 * code that caused it.
 *
 * Nothing serves this file over HTTP. Generating it, committing it and checking
 * it against the implementation are all permitted while the ABL-349 gate is
 * open; putting it on a public URL or a docs site is not, and `publicApp.ts` has
 * no route for it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root-relative, because the artifact is a publication rather than server source. */
export const ARTIFACT_PATH = path.resolve(HERE, '../../../../docs/api/v1/openapi.json');

/**
 * Compare and write with line endings normalised.
 *
 * `core.autocrlf` is `true` on the Windows checkouts this repository is
 * developed on, so a committed LF file comes back CRLF from a fresh clone.
 * Without this, the drift check would fail on a clean tree with a message
 * saying the published contract was stale — a line-ending bug wearing a
 * contract bug's error message, which is the worst kind to debug. The
 * `.gitattributes` entry pins the artifact to LF; this makes the check correct
 * even where that has not taken effect yet.
 */
export function normaliseEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function readArtifact(): string | null {
  return fs.existsSync(ARTIFACT_PATH)
    ? normaliseEol(fs.readFileSync(ARTIFACT_PATH, 'utf8'))
    : null;
}

export function writeArtifact(): { path: string; changed: boolean } {
  const rendered = renderOpenApiDocument();
  const previous = readArtifact();

  if (previous === rendered) return { path: ARTIFACT_PATH, changed: false };

  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, rendered, 'utf8');
  return { path: ARTIFACT_PATH, changed: true };
}

// `tsx src/v1/openapi/generate.ts` runs this; importing the module does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = writeArtifact();
  console.log(
    result.changed
      ? `openapi: wrote ${result.path}`
      : `openapi: ${result.path} was already up to date`
  );
}
