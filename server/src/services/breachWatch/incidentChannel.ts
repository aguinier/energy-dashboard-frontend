import type { Incident } from './incidentReport.js';

/**
 * Where an alarm rings (ABL-578), and the one place this repository talks to the
 * Paperclip control plane.
 *
 * ## The channel is not a choice made here
 *
 * ABL-524 §6 records it as a Board decision of 2026-08-22: *"A detected signal
 * opens a Paperclip issue, `priority: high`, assigned to the CEO, titled
 * `INCIDENT: …`. That is the whole channel."* Not a log line, not an email. The
 * reasoning the Board accepted is worth keeping next to the code: that channel
 * demonstrably wakes an agent, it is visible to the Board without the Board
 * having to be awake, and the issue doubles as the Art. 33(5) documentation the
 * breach procedure requires — so the alarm and the incident record are the same
 * artefact and there is no window where one exists without the other.
 *
 * The accepted residual risk is written into `breach-procedure` rather than
 * hidden here: **this channel is inside Paperclip and does not work if Paperclip
 * is what is down.** {@link createLoggingIncidentChannel} is the fallback, and it
 * is a fallback rather than an equal — it satisfies nobody's definition of an
 * alarm, and it says so on every line it prints.
 *
 * ## Two calls, not one, and the description stays short
 *
 * `open` posts the issue and then posts the evidence as the first comment. The
 * issue API rejects long descriptions intermittently rather than cleanly, and an
 * alarm that fails one time in ten because its body was long is worse than one
 * that always posts a short body. `incidentReport.ts` therefore writes a
 * description that is sufficient on its own; a failed comment costs evidence, not
 * triage.
 *
 * A comment that fails **does not** fail the open. The issue exists, it is
 * assigned, and it is `priority: high` — the alarm has rung, which was the job.
 */

export interface OpenedIncident {
  /** The created issue's id, or `null` if the channel does not create issues. */
  issueId: string | null;
  /** Human-readable, for the scheduler's log line. */
  reference: string;
}

export interface IncidentChannel {
  name: string;
  /** Raise a new alarm. Allowed to reject; the caller treats that as "nobody was told". */
  open(incident: Incident): Promise<OpenedIncident>;
  /** Add to an alarm already raised. Allowed to reject. */
  update(issueId: string, body: string): Promise<void>;
  /**
   * Is that alarm still somewhere a responder will see it?
   *
   * `true` open, `false` closed or gone, **`null` cannot tell**. Absent on a
   * channel that has no issues to check. See `deliverFinding` for why `null` and
   * `true` are treated identically and `false` is not.
   */
  isOpen?(issueId: string): Promise<boolean | null>;
}

/**
 * The statuses that mean nobody is reading the thread any more.
 *
 * Taken from the control plane's own vocabulary — `backlog`, `in_progress`,
 * `in_review` and `blocked` are the live ones. A status we do not recognise is
 * deliberately **not** treated as terminal: a new status added upstream must not
 * silently start re-opening incidents.
 */
export const TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled']);

export interface PaperclipConfig {
  baseUrl: string;
  apiKey: string;
  companyId: string;
  /** The CEO agent. ABL-578 names the id; it is configurable so it can be corrected. */
  assigneeAgentId: string;
  /** Filed against the dashboard project when set, so it lands where the work is. */
  projectId: string | null;
}

/**
 * The CEO agent id, from ABL-578.
 *
 * A default rather than a required variable: the destination is a Board decision,
 * not a deployment detail, and an alarm that silently went to nobody because an
 * environment variable was unset is the exact failure this whole issue exists to
 * remove. `BREACH_WATCH_ASSIGNEE_AGENT_ID` overrides it if the roster changes.
 */
export const DEFAULT_INCIDENT_ASSIGNEE = '2c8be7ee-e7a8-4137-b8a4-437d368d0190';

/**
 * Normalise however the base URL was written: the runtime hands it out both with
 * and without a trailing `/api`, and gluing a path onto the wrong one 404s.
 */
export function normalisePaperclipBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/api$/, '');
}

/**
 * Read the channel's configuration, or `null` when it is not configured.
 *
 * `null` is not an error here. The private server runs in checkouts and on the
 * acceptance box where there is no control plane to talk to, and a monitoring
 * job that refuses to start because it cannot reach an issue tracker is a
 * monitoring job that is off. The scheduler logs loudly and falls back; see
 * `breachWatchScheduler.ts`.
 */
export function resolvePaperclipConfig(
  env: NodeJS.ProcessEnv = process.env
): PaperclipConfig | null {
  const apiKey = env.PAPERCLIP_API_KEY?.trim();
  const rawUrl = env.PAPERCLIP_API_URL?.trim();
  const companyId = env.PAPERCLIP_COMPANY_ID?.trim();
  if (!apiKey || !rawUrl || !companyId) return null;

  return {
    baseUrl: normalisePaperclipBaseUrl(rawUrl),
    apiKey,
    companyId,
    assigneeAgentId: env.BREACH_WATCH_ASSIGNEE_AGENT_ID?.trim() || DEFAULT_INCIDENT_ASSIGNEE,
    projectId: env.PAPERCLIP_PROJECT_ID?.trim() || null,
  };
}

/** Injected so the transport is testable without a network or a running control plane. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function post(
  config: PaperclipConfig,
  fetchImpl: FetchLike,
  route: string,
  body: unknown
): Promise<unknown> {
  const response = await fetchImpl(`${config.baseUrl}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // The response text is included because the control plane distinguishes a
    // validation refusal from an outage in the body and not in the status, and
    // this message is the only place an operator will see either.
    const text = await response.text().catch(() => '(body unreadable)');
    throw new Error(`POST ${route} failed: ${response.status} ${response.statusText} — ${text}`);
  }

  return response.json().catch(() => ({}));
}

function readIssueId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  const nested = record.issue;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).id === 'string') {
    return (nested as Record<string, unknown>).id as string;
  }
  return null;
}

function readStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.status === 'string') return record.status;
  const nested = record.issue;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).status === 'string') {
    return (nested as Record<string, unknown>).status as string;
  }
  return null;
}

function readIdentifier(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.identifier === 'string') return record.identifier;
  const nested = record.issue;
  if (
    nested &&
    typeof nested === 'object' &&
    typeof (nested as Record<string, unknown>).identifier === 'string'
  ) {
    return (nested as Record<string, unknown>).identifier as string;
  }
  return null;
}

export interface PaperclipChannelDeps {
  config: PaperclipConfig;
  fetchImpl?: FetchLike;
  logger?: { warn: (message: string) => void };
}

/** The channel the Board chose. */
export function createPaperclipIncidentChannel({
  config,
  fetchImpl = fetch,
  logger = console,
}: PaperclipChannelDeps): IncidentChannel {
  return {
    name: 'paperclip',

    async open(incident: Incident): Promise<OpenedIncident> {
      const payload = await post(config, fetchImpl, `/api/companies/${config.companyId}/issues`, {
        title: incident.title,
        description: incident.description,
        priority: 'high',
        assigneeAgentId: config.assigneeAgentId,
        // Sent explicitly rather than left to be inherited. A create issued from
        // a long-running server has no run context to inherit from, and an
        // unattached incident is one nobody's board shows.
        ...(config.projectId ? { projectId: config.projectId, projectWorkspaceId: null } : {}),
      });

      const issueId = readIssueId(payload);
      const reference = readIdentifier(payload) ?? issueId ?? '(id not returned)';

      if (issueId) {
        // Evidence is a bonus on top of a description that already triages. A
        // failure here is logged and swallowed for exactly that reason: it must
        // not turn a delivered alarm into an undelivered one, which would make
        // the scheduler retry and open a second issue.
        try {
          await post(config, fetchImpl, `/api/issues/${issueId}/comments`, {
            body: incident.detail,
          });
        } catch (err) {
          logger.warn(
            `🚨 breach watch: incident ${reference} was opened but its evidence comment failed ` +
              `(${(err as Error).message}). The description carries the triage set; the ` +
              'evidence rows are reproducible with the security:* commands it names.'
          );
        }
      }

      return { issueId, reference };
    },

    async update(issueId: string, body: string): Promise<void> {
      await post(config, fetchImpl, `/api/issues/${issueId}/comments`, { body });
    },

    /**
     * Whether the incident is still a live thread.
     *
     * A closed incident is not a place an alarm can be delivered: an agent comment
     * on a closed issue is inert by default, so a genuine second attack posted
     * there lands on a triaged-and-dismissed thread nobody reopens.
     *
     * The three outcomes are deliberate. A **404** is `false` — a record whose
     * issue no longer exists is not an open incident, and staying silent against
     * nothing for the rest of the window is the failure this method exists to
     * remove. A transport failure or an unreadable body is `null`, never `false`:
     * guessing "closed" on a flaky network would open a duplicate `priority: high`
     * issue every tick, which is the noise the state file exists to prevent.
     */
    async isOpen(issueId: string): Promise<boolean | null> {
      const url = `${config.baseUrl}/api/issues/${issueId}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
      } catch (err) {
        logger.warn(
          `🚨 breach watch: could not reach the control plane to check whether incident ` +
            `${issueId} is still open (${(err as Error).message}); assuming it is, so this ` +
            'tick will not duplicate it.'
        );
        return null;
      }

      if (response.status === 404) return false;

      if (!response.ok) {
        logger.warn(
          `🚨 breach watch: checking incident ${issueId} returned ${response.status} ` +
            `${response.statusText}; assuming it is still open, so this tick will not duplicate it.`
        );
        return null;
      }

      const status = readStatus(await response.json().catch(() => null));
      if (status === null) {
        logger.warn(
          `🚨 breach watch: incident ${issueId} was fetched but carried no readable status; ` +
            'assuming it is still open, so this tick will not duplicate it.'
        );
        return null;
      }

      return !TERMINAL_ISSUE_STATUSES.has(status);
    },
  };
}

export interface IncidentLogger {
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * The fallback, for a process with no control plane configured.
 *
 * It prints at `error` level and says in words that the mandated channel is not
 * in use, because the one thing worse than an alarm nobody receives is an alarm
 * nobody receives that looks like it was delivered.
 */
export function createLoggingIncidentChannel(
  logger: IncidentLogger = console
): IncidentChannel {
  return {
    name: 'logging (NOT the Board-mandated channel)',

    async open(incident: Incident): Promise<OpenedIncident> {
      logger.error(
        `🚨 ${incident.title}\n${incident.description}\n${incident.detail}\n` +
          '⚠️  This was NOT filed as a Paperclip issue: PAPERCLIP_API_KEY / PAPERCLIP_API_URL / ' +
          'PAPERCLIP_COMPANY_ID are not set in this process. ABL-524 §6 requires a priority:high ' +
          'issue assigned to the CEO. Nobody has been woken.'
      );
      return { issueId: null, reference: '(logged only)' };
    },

    async update(_issueId: string, body: string): Promise<void> {
      logger.error(`🚨 breach watch update (logged only, nobody woken):\n${body}`);
    },

    // No `isOpen`: this channel never returns an issue id, so the scheduler never
    // has one to check. Omitted rather than stubbed to `true`, which would be a
    // claim about an issue that does not exist.
  };
}
