import fs from 'node:fs';
import path from 'node:path';

/**
 * "Which incidents have I already opened, and when does that stop counting?"
 * (ABL-578).
 *
 * ## Why this file exists at all
 *
 * ABL-578 names the failure mode in terms: *"A watcher that opens a fresh
 * high-priority issue every tick during a sustained attack turns the alarm into
 * noise and costs real tokens; one open incident per window, updated, not
 * duplicated."* The detector is stateless by design — it reports what the rows
 * say every time it looks — so the memory has to live somewhere, and this is it.
 *
 * It is the same shape and the same discipline as `lib/opsAlertStateStore.ts`:
 * one small JSON object, no history, no retention, and **nothing here throws**.
 * Its input is a file on a host we do not control — absent on first boot,
 * truncated by a full disk, hand-edited, written by an older build. A bad blob
 * degrades to "no memory", which re-opens a live incident once (noisy, but
 * correct and visible) and never takes the scheduled check down with it.
 *
 * ## The one difference from the ops alert state, and it matters
 *
 * The ops engine records a *state* per KPI and fires on transitions. This records
 * an *issue id* per incident key, which is a fact about the outside world: an
 * issue really was created, and it has a number somebody may already be reading.
 * Losing that record does not merely re-fire an alert, it opens a second issue
 * about the first one's subject. So the write happens after delivery succeeds,
 * and a delivery that failed writes nothing — the same rule
 * `runOpsAlertCheck` follows, for the same reason.
 */

const DEFAULT_DB_PATH = '/data/energy_dashboard.db';

/** One incident we have opened and not yet let lapse. */
export interface IncidentRecord {
  /** {@link BreachFinding.incidentKey} — stable per subject, count-free. */
  key: string;
  /**
   * What the alarm channel returned, or `null` when the channel does not create
   * issues (the logging fallback) or the id could not be read from the response.
   *
   * `null` still suppresses duplicates for the window. An alarm that was
   * delivered somewhere we cannot address again is not a reason to keep firing.
   */
  issueId: string | null;
  openedAt: string;
  /** After this instant the incident lapses and a fresh one may be opened. */
  windowEndsAt: string;
  /** When we last said anything about it — gates the update cadence. */
  lastNotifiedAt: string;
  /** {@link BreachFinding.magnitude} as last reported. An update needs growth. */
  magnitude: number;
}

export interface IncidentState {
  version: 1;
  incidents: IncidentRecord[];
}

export const EMPTY_INCIDENT_STATE: IncidentState = { version: 1, incidents: [] };

/**
 * Beside the database, matching `resolveAlertStatePath` — that directory is the
 * one path every deployment already has writable and configured.
 *
 * Deliberately **not** beside `API_KEYS_DB_PATH`. That file is the entire
 * reportable surface per ABL-524 §0 and the Tier 2 signal the Board is still
 * considering is "who touched it"; adding a JSON file that a scheduler rewrites
 * every few minutes to the same directory would put noise directly on top of the
 * signal, and would do it in the one place we least want to have to explain a
 * write.
 */
export function resolveIncidentStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BREACH_WATCH_STATE_PATH;
  if (override) return override;
  return path.join(path.dirname(env.ENERGY_DB_PATH || DEFAULT_DB_PATH), 'breach-watch-state.json');
}

function isRecord(value: unknown): value is IncidentRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === 'string' &&
    record.key.length > 0 &&
    (record.issueId === null || typeof record.issueId === 'string') &&
    typeof record.openedAt === 'string' &&
    typeof record.windowEndsAt === 'string' &&
    typeof record.lastNotifiedAt === 'string' &&
    typeof record.magnitude === 'number' &&
    Number.isFinite(record.magnitude)
  );
}

/**
 * Validates entry by entry and drops only what is malformed, so one corrupt
 * record cannot discard the good ones beside it and re-open every other incident.
 */
export function parseIncidentState(raw: string): IncidentState {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return EMPTY_INCIDENT_STATE;

  const candidate = parsed as { version?: unknown; incidents?: unknown };
  if (candidate.version !== 1) return EMPTY_INCIDENT_STATE;
  if (!Array.isArray(candidate.incidents)) return EMPTY_INCIDENT_STATE;

  return { version: 1, incidents: candidate.incidents.filter(isRecord) };
}

export interface ReadIncidentStateResult {
  state: IncidentState;
  /** Non-null when the file existed but could not be used. One log line, not a crash. */
  warning: string | null;
}

export function readIncidentState(filePath: string): ReadIncidentStateResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    // Absent is the ordinary first-boot case and is not worth a warning.
    if (error.code === 'ENOENT') return { state: EMPTY_INCIDENT_STATE, warning: null };
    return {
      state: EMPTY_INCIDENT_STATE,
      warning: `breach watch state at ${filePath} could not be read (${error.message}); ` +
        'treating as no memory, so a live incident may be re-opened once.',
    };
  }

  try {
    return { state: parseIncidentState(raw), warning: null };
  } catch (err) {
    return {
      state: EMPTY_INCIDENT_STATE,
      warning: `breach watch state at ${filePath} is not valid JSON (${
        (err as Error).message
      }); treating as no memory, so a live incident may be re-opened once.`,
    };
  }
}

export interface WriteIncidentStateResult {
  warning: string | null;
}

export function writeIncidentState(
  filePath: string,
  state: IncidentState
): WriteIncidentStateResult {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return { warning: null };
  } catch (err) {
    return {
      warning:
        `breach watch state could not be written to ${filePath} (${(err as Error).message}); ` +
        'the next tick will have no memory of what was just opened and may duplicate it.',
    };
  }
}

/**
 * Drop incidents whose window has closed.
 *
 * A lapsed incident is forgotten rather than archived: the record's only job is
 * suppression, and keeping closed ones would grow the file without bound on a
 * surface that is meant to be quiet. The *issues themselves* are the durable
 * record — Art. 33(5) documentation, per `breach-procedure` — and they are not
 * ours to tidy.
 */
export function pruneLapsed(state: IncidentState, now: Date): IncidentState {
  const nowIso = now.toISOString();
  return { version: 1, incidents: state.incidents.filter((row) => row.windowEndsAt > nowIso) };
}

export function findIncident(state: IncidentState, key: string): IncidentRecord | undefined {
  return state.incidents.find((row) => row.key === key);
}

export function upsertIncident(state: IncidentState, record: IncidentRecord): IncidentState {
  const others = state.incidents.filter((row) => row.key !== record.key);
  return { version: 1, incidents: [...others, record].sort((a, b) => a.key.localeCompare(b.key)) };
}
