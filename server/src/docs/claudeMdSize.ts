/**
 * `npm run claudemd:size` — how much room is left in CLAUDE.md, before you write.
 *
 * The budget assertion in `claudeMdCitations.test.ts` is silent until the line
 * is crossed, and that silence is what ABL-740 cost: `origin/main` sat **44 B**
 * under the byte budget for weeks, so the next CLAUDE.md edit — a textually
 * clean, conflict-free branch — turned the merged tree red and had to be held
 * out of a release train while someone made an editorial call on the fleet's
 * most-read file under time pressure. Reclaiming the space fixed that instance;
 * a ceiling you can only find by hitting it schedules the next one.
 *
 * A command and not a line printed by the suite: vitest's default reporter
 * drops both `console.log` and annotations for a passing test, and a piped,
 * non-TTY run is how CI and every agent reads it. A report nobody sees is worse
 * than none, because it looks like coverage.
 *
 * Exit code is the verdict, so this composes: 0 when the document fits, 1 when
 * it does not, with `checkSizeBudget`'s own message.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_MD_BUDGET, checkSizeBudget, describeSizeHeadroom } from './claudeMdCitations.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

const text = readFileSync(CLAUDE_MD, 'utf8');
const overage = checkSizeBudget(text);

console.log(`CLAUDE.md  ${describeSizeHeadroom(text)}`);
console.log(`budget     ${CLAUDE_MD_BUDGET.lines} lines / ${CLAUDE_MD_BUDGET.bytes} B, LF-normalised`);

if (overage) {
  console.error(`\n${overage}`);
  process.exitCode = 1;
}
