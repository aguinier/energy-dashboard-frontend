import { openEnergyDatabase } from '../data/sqliteEnergySource.js';
import { ACKNOWLEDGED_VERSIONS, MATERIAL_NOTICE_DAYS } from './acknowledgements.js';
import { readServedVersionLedger } from './servedLedger.js';
import { diffLedger, type LedgerDiff, type ObservedVersion } from './versionGuard.js';

/**
 * `npm run modelversions -- <command>` — the operator side of the §9.3 trigger.
 *
 * Two commands and no third:
 *
 *   status                       what the database serves vs what a human signed
 *   draft --kind material|correction --by "<who>" --note "<what>" [--id <slug>]
 *                                a ready-to-paste acknowledgement record
 *
 * ## Why `draft` prints and does not write
 *
 * The acknowledged set is checked-in source, reviewed in a pull request and
 * merged by the CEO (this repo's standing rule — no agent merges its own work).
 * That review *is* the acknowledgement. A command that edited
 * `acknowledgements.ts` in place would make "acknowledged" mean "somebody ran a
 * script", which is precisely the state ABL-529 exists to end: the retrain
 * already happens without a human deciding anything, and a guard cleared by a
 * command anyone can run in the same breath is not a guard, it is a longer way
 * to do the same thing.
 *
 * So this prints. The block it prints is the **record that names the pairs
 * affected** — ABL-529's "done when" — and it is what the ToS §9.3 changelog
 * entry is written from: `note` is the prose, `pairs` is the blast radius,
 * `serve_from` is the date the notice runs to.
 *
 * ## Why it does not send anything
 *
 * §9.3's channels are the change log at `/changelog` (ABL-532) and the account
 * contact (ABL-528). This makes the change impossible to miss; it does not
 * deliver mail.
 *
 * See "Serving a changed model artifact: the ToS §9.3 sequence" in CLAUDE.md
 * for the full procedure, including when to run this command and what comes next.
 *
 * ## `--kind correction` skips the 30 days, and is not a shortcut
 *
 * ToS §9.3.2 permits a fix for values that are *wrong* to serve immediately.
 * Without that path this guard would block the one change §9.3 explicitly lets
 * us ship at once — the live case being the NL gross-basis load forecast
 * (ABL-501 / ABL-505 / ABL-506). It is exempt from the wait, **not** from the
 * changelog: the entry still has to go up at the moment the fix is served,
 * saying that it was a correction and what was wrong. The `--note` this command
 * demands is that sentence, and it refuses to draft a correction without one.
 *
 * Hand-rolled argument parsing for the same reason `keysCli.ts` is: the public
 * surface should not be how a new dependency arrives.
 */

interface DraftOptions {
  kind: 'material' | 'correction';
  by: string;
  note: string;
  id?: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value.`);
  return value;
}

function describe(row: ObservedVersion): string {
  const vintage = row.newest_vintage_at ?? 'no run';
  return `${row.zone}/${row.forecast_type}/${row.model} → ${row.model_version ?? '(no model_version)'}  [${vintage}]`;
}

/**
 * The verdict, ordered so the one that matters is last and therefore on screen.
 *
 * `unacknowledged` is the §9.3.1 M1 case and the reason the command exits
 * non-zero: a non-zero exit is what lets this be wired into a promotion script
 * later without rewriting it, and a report nobody can gate on is the "report,
 * not refuse" shape ABL-529 rejected.
 */
function printStatus(diff: LedgerDiff): number {
  console.log(`Acknowledged records: ${ACKNOWLEDGED_VERSIONS.length}`);
  console.log(
    `Observed triples: ${
      new Set(diff.servable.concat(diff.additive, diff.embargoed, diff.unacknowledged).map((r) => `${r.zone}|${r.forecast_type}|${r.model}`)).size
    }`
  );
  console.log(`  servable        ${diff.servable.length}`);
  console.log(`  additive (§9.1) ${diff.additive.length}`);
  console.log(`  embargoed       ${diff.embargoed.length}`);
  console.log(`  unacknowledged  ${diff.unacknowledged.length}`);
  console.log(`  withdrawn       ${diff.withdrawn.length}`);

  if (diff.additive.length > 0) {
    console.log(
      `\nNEW — combinations we did not serve before. Additive under ToS §9.1, no notice needed,\n` +
        `and no acknowledgement needed either: an absent triple serves unfiltered by design.`
    );
    for (const row of diff.additive) console.log(`  + ${describe(row)}`);
  }

  if (diff.embargoed.length > 0) {
    console.log(`\nEMBARGOED — signed, still inside the ${MATERIAL_NOTICE_DAYS}-day notice period. Withheld on purpose.`);
    for (const row of diff.embargoed) console.log(`  · ${describe(row)}`);
  }

  const orphaned = diff.withdrawn.filter((pair) => pair.triple_gone);
  const superseded = diff.withdrawn.filter((pair) => !pair.triple_gone);
  if (superseded.length > 0) {
    console.log(
      `\nSUPERSEDED — acknowledged artifacts that no longer write rows. Expected: the old artifact\n` +
        `stops when the new one takes over. Keep the entries; deleting one removes the fallback.`
    );
    for (const pair of superseded) {
      console.log(`  - ${pair.zone}/${pair.forecast_type}/${pair.model} → ${pair.model_version}`);
    }
  }
  if (orphaned.length > 0) {
    console.log(
      `\nWITHDRAWN — these triples produce no rows at all. Ceasing to cover a zone is MATERIAL\n` +
        `under ToS §9.3.1 (M4). A read-side guard cannot withhold an absence: this needs a notice,\n` +
        `not a filter. It is also the shape a mis-measured baseline takes, so check the database\n` +
        `before writing to anyone.`
    );
    for (const pair of orphaned) {
      console.log(`  ! ${pair.zone}/${pair.forecast_type}/${pair.model} → ${pair.model_version}`);
    }
  }

  if (diff.unacknowledged.length === 0) {
    console.log('\nOK — every served artifact is acknowledged.');
    return orphaned.length > 0 ? 1 : 0;
  }

  console.log(
    `\nWITHHELD — ${diff.unacknowledged.length} served triple(s) are running an artifact nobody signed.\n` +
      `These are NOT reaching subscribers: the version gate is withholding them and the previously\n` +
      `acknowledged artifact keeps serving, so the series is stale rather than silently changed.\n` +
      `Under ToS §9.3.1 each is a material change and needs ${MATERIAL_NOTICE_DAYS} days' notice.`
  );
  for (const row of diff.unacknowledged) console.log(`  ! ${describe(row)}`);
  console.log(
    `\nNext: draft the record, review it, and merge it.\n` +
      `  npm run modelversions -- draft --kind material --by "<role>" --note "<what changed and why>"`
  );
  return 1;
}

function printDraft(diff: LedgerDiff, options: DraftOptions, now: Date): number {
  if (diff.unacknowledged.length === 0) {
    console.log('Nothing to acknowledge: every served artifact is already signed.');
    return 0;
  }

  const noticeMs = options.kind === 'material' ? MATERIAL_NOTICE_DAYS * 24 * 60 * 60 * 1000 : 0;
  const serveFrom = new Date(now.getTime() + noticeMs);
  const stamp = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
  const id = options.id ?? `${options.kind}-${now.toISOString().slice(0, 10)}`;

  const pairs = diff.unacknowledged
    .map(
      (row) =>
        `    { zone: '${row.zone}', forecast_type: '${row.forecast_type}', model: '${row.model}', model_version: '${row.model_version ?? ''}' },`
    )
    .join('\n');

  console.log(
    options.kind === 'correction'
      ? `// ToS §9.3.2 correction: serves immediately. The changelog entry must go up AT THE SAME\n` +
          `// TIME as the change, and must say it was a correction and what was wrong.\n`
      : `// ToS §9.3 material change: ${MATERIAL_NOTICE_DAYS} days' notice. Publish the changelog entry and notify\n` +
          `// the account contact NOW; the gate starts serving these on serve_from by itself.\n`
  );
  console.log(`const ${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}: VersionAcknowledgement = {`);
  console.log(`  id: '${id}',`);
  console.log(`  kind: '${options.kind}',`);
  console.log(`  acknowledged_at: '${stamp(now)}',`);
  console.log(`  acknowledged_by: '${options.by.replace(/'/g, "\\'")}',`);
  console.log(`  serve_from: '${stamp(serveFrom)}',`);
  console.log(`  note:\n    '${options.note.replace(/'/g, "\\'")}',`);
  console.log('  pairs: [');
  console.log(pairs);
  console.log('  ],');
  console.log('};');
  console.log(
    `\n// Add it to ACKNOWLEDGED_VERSIONS. Do NOT remove the entry it supersedes — that entry is\n` +
      `// what keeps the pair serving until serve_from, and deleting it blanks the series instead.`
  );
  if (diff.unacknowledged.some((row) => row.model_version === null)) {
    console.log(
      `\n// WARNING: at least one row above has no model_version. An empty version matches nothing\n` +
        `// and would blank the pair. Find out why the run wrote no version before pasting this.`
    );
  }
  return 0;
}

function main(argv: readonly string[]): void {
  const command = argv[0];
  if (command !== 'status' && command !== 'draft') {
    fail(
      'Usage:\n' +
        '  npm run modelversions -- status\n' +
        '  npm run modelversions -- draft --kind material|correction --by "<role>" --note "<text>" [--id <slug>]'
    );
  }

  const source = openEnergyDatabase();
  try {
    const now = new Date();
    const diff = diffLedger(readServedVersionLedger(source), ACKNOWLEDGED_VERSIONS, now);
    if (command === 'status') {
      process.exitCode = printStatus(diff);
      return;
    }

    const kind = flag(argv, 'kind');
    if (kind !== 'material' && kind !== 'correction') {
      fail("--kind must be 'material' (30 days, ToS §9.3) or 'correction' (immediate, ToS §9.3.2).");
    }
    const by = flag(argv, 'by');
    if (by === undefined || by.trim() === '') fail('--by is required: a human signs this, not a script.');
    const note = flag(argv, 'note');
    if (note === undefined || note.trim() === '') {
      fail(
        '--note is required. It is the text the ToS §9.3 changelog entry is written from, and for a\n' +
          'correction §9.3.2 requires it to state what was wrong.'
      );
    }
    process.exitCode = printDraft(diff, { kind, by, note, id: flag(argv, 'id') }, now);
  } finally {
    source.close();
  }
}

main(process.argv.slice(2));
