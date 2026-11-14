import { describe, expect, it } from 'vitest';
import { httpLeadCheck, parseLeadCheckResponse, type LeadCheckFetch } from './lead-key-check.js';

const USER = '0b9c5f8e-4a3d-4c2b-9e1f-7a6b5c4d3e2f';

describe('the lead check identity asks svc-trade before a copy:lead key', () => {
  it('reads lead and not-lead only from a well-formed 2xx', () => {
    expect(parseLeadCheckResponse(200, JSON.stringify({ asOf: 'now', lead: true }))).toBe('lead');
    expect(parseLeadCheckResponse(200, JSON.stringify({ asOf: 'now', lead: false }))).toBe('not_lead');
    expect(parseLeadCheckResponse(200, JSON.stringify({ lead: true }))).toBe('unavailable');
    expect(parseLeadCheckResponse(200, '{')).toBe('unavailable');
    expect(parseLeadCheckResponse(503, JSON.stringify({ asOf: 'now', lead: true }))).toBe('unavailable');
  });

  it('a blank trade URL is unavailable, never a lead', async () => {
    expect(await httpLeadCheck({ url: undefined, secret: 's'.repeat(40) })(USER)).toBe('unavailable');
  });

  it('asks trade with a signed body naming the user, and retries once', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl: LeadCheckFetch = async (url, init) => {
      calls.push({ url, body: init.body, headers: init.headers });
      if (calls.length === 1) throw new Error('reset');
      return { status: 200, text: async () => JSON.stringify({ asOf: 'now', lead: true }) };
    };
    expect(await httpLeadCheck({ url: 'http://trade:4004/', secret: 's'.repeat(40), fetchImpl })(USER)).toBe('lead');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('http://trade:4004/internal/copy/lead-check');
    expect(JSON.parse(calls[0]!.body)).toEqual({ userId: USER });
    expect(Object.keys(calls[0]!.headers).length).toBeGreaterThan(1);
  });

  it('two failures are unavailable', async () => {
    const fetchImpl: LeadCheckFetch = async () => ({ status: 500, text: async () => '' });
    expect(await httpLeadCheck({ url: 'http://trade:4004', secret: 's'.repeat(40), fetchImpl })(USER)).toBe('unavailable');
  });
});
