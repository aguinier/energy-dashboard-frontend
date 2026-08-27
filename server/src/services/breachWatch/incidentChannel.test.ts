import { describe, it, expect, vi } from 'vitest';
import {
  createLoggingIncidentChannel,
  createPaperclipIncidentChannel,
  DEFAULT_INCIDENT_ASSIGNEE,
  normalisePaperclipBaseUrl,
  resolvePaperclipConfig,
  type FetchLike,
  type PaperclipConfig,
} from './incidentChannel.js';
import type { Incident } from './incidentReport.js';

/**
 * The transport, checked against a recorded fetch.
 *
 * ABL-578: *"Do not assume the payload shape."* The shape asserted here was
 * exercised against the live control plane once — see the closing comment on that
 * issue — and this file is what stops it drifting afterwards.
 */

const CONFIG: PaperclipConfig = {
  baseUrl: 'http://192.168.86.237:3100',
  apiKey: 'test-key',
  companyId: 'company-1',
  assigneeAgentId: DEFAULT_INCIDENT_ASSIGNEE,
  projectId: 'project-1',
};

const INCIDENT: Incident = {
  title: 'INCIDENT: S4 — a real secret was presented and refused',
  description: 'body',
  detail: 'evidence',
};

function recordingFetch(responses: Array<Partial<Response> & { json?: () => Promise<unknown> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({}),
      text: async () => '',
      ...response,
    } as Response;
  };
  return { fetchImpl, calls };
}

describe('resolvePaperclipConfig', () => {
  it('returns null when the control plane is not configured', () => {
    // Not an error: the private server runs in checkouts and on the acceptance
    // box with no control plane, and a monitor that refuses to start there is off.
    expect(resolvePaperclipConfig({})).toBeNull();
    expect(resolvePaperclipConfig({ PAPERCLIP_API_KEY: 'k' })).toBeNull();
  });

  it('defaults the assignee to the CEO agent ABL-524 §6 names', () => {
    const config = resolvePaperclipConfig({
      PAPERCLIP_API_KEY: 'k',
      PAPERCLIP_API_URL: 'http://host:3100/api',
      PAPERCLIP_COMPANY_ID: 'c',
    });
    expect(config?.assigneeAgentId).toBe(DEFAULT_INCIDENT_ASSIGNEE);
  });

  it('normalises the base URL however it was written', () => {
    // The runtime hands it out both with and without /api; gluing a path onto the
    // wrong one 404s, and an alarm that 404s is an alarm nobody receives.
    expect(normalisePaperclipBaseUrl('http://h:3100/api')).toBe('http://h:3100');
    expect(normalisePaperclipBaseUrl('http://h:3100/')).toBe('http://h:3100');
    expect(normalisePaperclipBaseUrl('http://h:3100')).toBe('http://h:3100');
  });
});

describe('opening an incident', () => {
  it('posts a priority:high issue assigned to the CEO, then the evidence as a comment', async () => {
    const { fetchImpl, calls } = recordingFetch([
      { json: async () => ({ id: 'issue-9', identifier: 'ABL-999' }) },
      { json: async () => ({ id: 'comment-1' }) },
    ]);

    const result = await createPaperclipIncidentChannel({ config: CONFIG, fetchImpl }).open(INCIDENT);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('http://192.168.86.237:3100/api/companies/company-1/issues');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({
      title: INCIDENT.title,
      description: 'body',
      priority: 'high',
      assigneeAgentId: DEFAULT_INCIDENT_ASSIGNEE,
      projectId: 'project-1',
      projectWorkspaceId: null,
    });

    expect(calls[1].url).toBe('http://192.168.86.237:3100/api/issues/issue-9/comments');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ body: 'evidence' });

    expect(result).toEqual({ issueId: 'issue-9', reference: 'ABL-999' });
  });

  it('rejects when the issue itself could not be created, so the caller retries', async () => {
    const fetchImpl: FetchLike = async () =>
      ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'boom',
      }) as Response;

    await expect(
      createPaperclipIncidentChannel({ config: CONFIG, fetchImpl }).open(INCIDENT)
    ).rejects.toThrow(/500/);
  });

  it('still reports the alarm as delivered when only the evidence comment fails', async () => {
    // The description already triages. Turning a delivered alarm into an
    // undelivered one here would make the scheduler retry and open a second issue
    // about the same subject — the duplication ABL-578 forbids.
    const warn = vi.fn();
    let call = 0;
    const fetchImpl: FetchLike = async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'issue-9' }) } as Response;
      }
      return { ok: false, status: 413, statusText: 'Payload Too Large', text: async () => 'too big' } as Response;
    };

    const result = await createPaperclipIncidentChannel({
      config: CONFIG,
      fetchImpl,
      logger: { warn },
    }).open(INCIDENT);

    expect(result.issueId).toBe('issue-9');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('evidence comment failed');
  });

  it('omits the project fields entirely when none is configured', async () => {
    const { fetchImpl, calls } = recordingFetch([{ json: async () => ({ id: 'issue-9' }) }]);
    await createPaperclipIncidentChannel({
      config: { ...CONFIG, projectId: null },
      fetchImpl,
    }).open(INCIDENT);

    const body = JSON.parse(calls[0].init.body as string);
    expect('projectId' in body).toBe(false);
  });
});

describe('the logging fallback', () => {
  it('says in words that nobody was woken', async () => {
    // The one thing worse than an alarm nobody receives is an alarm nobody
    // receives that looks like it was delivered.
    const error = vi.fn();
    const result = await createLoggingIncidentChannel({ error, warn: vi.fn() }).open(INCIDENT);

    expect(result.issueId).toBeNull();
    expect(error.mock.calls[0][0]).toContain('Nobody has been woken');
    expect(error.mock.calls[0][0]).toContain('NOT filed as a Paperclip issue');
  });

  it('names itself as not the mandated channel', () => {
    expect(createLoggingIncidentChannel().name).toContain('NOT the Board-mandated channel');
  });
});
