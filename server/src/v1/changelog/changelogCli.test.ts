import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeEntry, parseArgs, runCommand } from './changelogCli.js';
import { openChangelogAdminStore, openChangelogReader } from './sqliteChangelogStore.js';
import type { ChangelogAdminStore } from './changelogStore.js';

/**
 * The publish path, driven the way an operator drives it.
 *
 * `runCommand` against a real store on a temp file, because the thing under test
 * is the command an operator will run during an incident — including the two
 * refusals that matter (a planned change with too little notice, a correction
 * dated into the future) and the warning that deliberately is *not* a refusal.
 */

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'able-changelog-cli-'));
  tmpRoots.push(root);
  return path.join(root, 'api_keys.db');
}

afterAll(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400_000;

let clock: Date;
let store: ChangelogAdminStore;
let out: string[];
let warned: string[];

function run(argv: string[]): void {
  runCommand(store, parseArgs(argv), () => clock);
}

function offsetIso(ms: number): string {
  return new Date(clock.getTime() + ms).toISOString();
}

beforeEach(() => {
  clock = new Date('2026-08-22T09:00:00.000Z');
  store = openChangelogAdminStore({ API_KEYS_DB_PATH: tmpDbPath() } as NodeJS.ProcessEnv, () => clock);
  out = [];
  warned = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warned.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

describe('parseArgs', () => {
  it('reads --name value and bare --flag', () => {
    expect(parseArgs(['entries:publish', '--type', 'planned', '--example'])).toEqual({
      command: 'entries:publish',
      flags: { type: 'planned', example: true },
    });
  });

  it('treats a missing value as a bare flag rather than swallowing the next flag', () => {
    expect(parseArgs(['entries:seed', '--examples', '--type', 'planned']).flags).toEqual({
      examples: true,
      type: 'planned',
    });
  });

  it('has an empty command when given nothing', () => {
    expect(parseArgs([])).toEqual({ command: '', flags: {} });
  });
});

describe('entries:publish', () => {
  it('publishes a planned change and says it is live already', () => {
    run([
      'entries:publish',
      '--type',
      'planned',
      '--effective',
      offsetIso(31 * DAY),
      '--title',
      'Load model replaced for three zones',
      '--detail',
      'The model behind day-ahead load for AT, BE and CH is replaced.',
    ]);

    const [entry] = store.list();
    expect(entry).toMatchObject({ type: 'planned', publishedAt: '2026-08-22T09:00:00.000Z' });
    expect(out.join('\n')).toContain(`published ${entry.id}`);
    // The operator has to know there is nothing left to do — that is the whole
    // difference from a publish path that ends in a deploy.
    expect(out.join('\n')).toMatch(/nothing to rebuild or restart/);
  });

  it('publishes a correction with what was wrong, and does not warn when it is on time', () => {
    run([
      'entries:publish',
      '--type',
      'correction',
      '--effective',
      offsetIso(0),
      '--title',
      'NL load forecast basis corrected',
      '--detail',
      'Values are now served on the same basis as the published actuals.',
      '--what-was-wrong',
      'Forecasts were served on a gross basis against net actuals for nine days.',
    ]);

    expect(store.list()[0]).toMatchObject({
      type: 'correction',
      whatWasWrong: 'Forecasts were served on a gross basis against net actuals for nine days.',
    });
    expect(warned).toEqual([]);
  });

  it('warns, but still publishes, when a correction goes up late', () => {
    // The deliberate asymmetry: by this point the change is already being
    // served, so refusing the entry would trade a late notice for no notice.
    run([
      'entries:publish',
      '--type',
      'correction',
      '--effective',
      offsetIso(-3 * 3_600_000),
      '--title',
      'A correction published three hours late',
      '--detail',
      'What changed.',
      '--what-was-wrong',
      'What was wrong.',
    ]);

    expect(store.list()).toHaveLength(1);
    expect(warned.join('\n')).toMatch(/3 hours after the change took effect/);
    expect(warned.join('\n')).toMatch(/shows both instants, so the gap is published/);
  });

  it('refuses a planned change with too little notice, and stores nothing', () => {
    expect(() =>
      run([
        'entries:publish',
        '--type',
        'planned',
        '--effective',
        offsetIso(10 * DAY),
        '--title',
        'Too soon',
        '--detail',
        'What changed.',
      ])
    ).toThrow(/30 days' notice/);
    expect(store.list()).toEqual([]);
  });

  it('refuses a correction dated into the future and names the type it should be', () => {
    expect(() =>
      run([
        'entries:publish',
        '--type',
        'correction',
        '--effective',
        offsetIso(3 * DAY),
        '--title',
        'Not really a correction',
        '--detail',
        'What changed.',
        '--what-was-wrong',
        'Nothing yet.',
      ])
    ).toThrow(/publish it as one/);
    expect(store.list()).toEqual([]);
  });

  it('refuses an effective time with no zone', () => {
    expect(() =>
      run([
        'entries:publish',
        '--type',
        'planned',
        '--effective',
        '2026-10-01T09:00:00',
        '--title',
        'No zone',
        '--detail',
        'What changed.',
      ])
    ).toThrow(/--effective must be an ISO-8601 instant with an explicit time zone/);
  });

  it('names the missing flag rather than failing generically', () => {
    expect(() => run(['entries:publish', '--type', 'planned'])).toThrow(/--effective is required/);
    expect(() => run(['entries:publish'])).toThrow(/--type is required/);
  });

  it('explains which type a change is, when the type is wrong', () => {
    expect(() => run(['entries:publish', '--type', 'urgent'])).toThrow(
      /must be one of: planned, correction/
    );
    expect(() => run(['entries:publish', '--type', 'urgent'])).toThrow(/is a correction/);
  });

  it('has no flag that could set the publication instant', () => {
    // Passing one has to be inert rather than accepted: this is the property
    // that stops a 30-day notice being manufactured after the fact.
    run([
      'entries:publish',
      '--type',
      'planned',
      '--effective',
      offsetIso(31 * DAY),
      '--title',
      'Backdating attempt',
      '--detail',
      'What changed.',
      '--published',
      '2026-01-01T00:00:00Z',
    ]);

    expect(store.list()[0].publishedAt).toBe('2026-08-22T09:00:00.000Z');
  });
});

describe('entries:seed', () => {
  it('refuses to seed without --examples, and says why', () => {
    expect(() => run(['entries:seed'])).toThrow(/needs --examples/);
    expect(() => run(['entries:seed'])).toThrow(/give notice of nothing/);
    expect(store.list()).toEqual([]);
  });

  it('installs one entry of each type, both marked as examples', () => {
    run(['entries:seed', '--examples']);

    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.type).sort()).toEqual(['correction', 'planned']);
    expect(entries.every((e) => e.isExample)).toBe(true);
  });

  it('seeds examples that satisfy the rules they illustrate', () => {
    run(['entries:seed', '--examples']);

    const planned = store.list().find((e) => e.type === 'planned')!;
    const fix = store.list().find((e) => e.type === 'correction')!;

    expect(Date.parse(planned.effectiveAt) - Date.parse(planned.publishedAt)).toBeGreaterThanOrEqual(
      30 * DAY
    );
    expect(Math.abs(Date.parse(fix.effectiveAt) - Date.parse(fix.publishedAt))).toBeLessThanOrEqual(
      60_000
    );
    expect(fix.whatWasWrong).not.toBeNull();
  });

  it('does not seed a second copy, because entries cannot be replaced', () => {
    run(['entries:seed', '--examples']);
    run(['entries:seed', '--examples']);

    expect(store.list()).toHaveLength(2);
    expect(out.join('\n')).toMatch(/Already seeded/);
  });
});

describe('entries:init', () => {
  /**
   * The command a serving process's startup error sends an operator to, so the
   * test is the operator's journey rather than a string: a fresh path, the
   * documented command, and then the thing that was refusing must start.
   *
   * Pinning it this way is deliberate. The table is created as a side effect of
   * opening the admin store, which `entries:list` also does — so a test that
   * asserted the message names *a* command would keep passing if the command it
   * named later stopped creating anything.
   */
  it('makes a store the serving process refused to open, openable', () => {
    const fresh = tmpDbPath();
    const env = { API_KEYS_DB_PATH: fresh } as NodeJS.ProcessEnv;

    expect(() => openChangelogReader(env)).toThrow(/Cannot open the \/v1 change log/);

    const admin = openChangelogAdminStore(env, () => clock);
    try {
      runCommand(admin, parseArgs(['entries:init']), () => clock);
    } finally {
      admin.close();
    }

    const reader = openChangelogReader(env);
    try {
      expect(reader.list()).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('publishes nothing, and says an empty change log is the correct state', () => {
    run(['entries:init']);

    expect(store.list()).toEqual([]);
    const said = out.join('\n');
    expect(said).toMatch(/Nothing is published/);
    // The distinction the refusal turns on: an empty table serves an empty
    // page, only a missing one refuses to start.
    expect(said).toMatch(/empty change log serves an empty page/);
  });

  it('is idempotent, and never publishes an example', () => {
    run(['entries:init']);
    run(['entries:init']);
    expect(store.list()).toEqual([]);

    run(['entries:publish', '--type', 'planned', '--effective', offsetIso(40 * DAY),
      '--title', 'A real change', '--detail', 'Something real.']);
    out = [];

    run(['entries:init']);
    expect(store.list()).toHaveLength(1);
    expect(out.join('\n')).toMatch(/nothing was changed/);
  });
});

describe('entries:list and entries:export', () => {
  it('says so plainly when nothing has been published', () => {
    run(['entries:list']);
    expect(out).toEqual(['No entries published yet.']);
  });

  it('lists both instants and the notice, newest first', () => {
    run(['entries:seed', '--examples']);
    out = [];
    run(['entries:list']);

    const listing = out.join('\n');
    expect(listing).toMatch(/published=2026-08-22T09:00:00/);
    expect(listing).toMatch(/effective=/);
    expect(listing).toMatch(/\[EXAMPLE\]/);
    // Newest first: the correction is seeded second, so it is listed first.
    expect(listing.indexOf('correction')).toBeLessThan(listing.indexOf('planned'));
  });

  it('exports the published record as the same JSON the route serves', () => {
    run(['entries:seed', '--examples']);
    out = [];
    run(['entries:export']);

    const exported = JSON.parse(out.join('\n')) as {
      notice_period_days: number;
      entries: { id: string; published_at: string; effective_at: string }[];
    };
    expect(exported.notice_period_days).toBe(30);
    expect(exported.entries).toHaveLength(2);
    expect(exported.entries[0].published_at > exported.entries[1].published_at).toBe(true);
  });
});

describe('the command surface', () => {
  it('prints usage for no command, and refuses an unknown one', () => {
    run([]);
    expect(out.join('\n')).toMatch(/entries:publish/);
    expect(() => run(['entries:delete', '--id', 'cl_x'])).toThrow(/Unknown command/);
  });

  it('offers no way to edit or delete a published entry', () => {
    for (const command of ['entries:edit', 'entries:delete', 'entries:withdraw', 'entries:update']) {
      expect(() => run([command])).toThrow(/Unknown command/);
    }
  });

  it('describes an entry with both instants, never only one', () => {
    run(['entries:seed', '--examples']);
    const row = describeEntry(store.list()[0]);

    expect(row).toMatch(/published=\d{4}-\d{2}-\d{2}T/);
    expect(row).toMatch(/effective=\d{4}-\d{2}-\d{2}T/);
  });
});
