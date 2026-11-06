/**
 * Unit card — rulebook versions on the router (RC-cex-spot-08)
 *
 * 1. Promise: GET /rulebook serves the owner version in force, with its seven sections, from the journal only; GET
 *    /rulebook/versions the history with the sections each version changed. Publishing is a founder door, two people,
 *    and a published version never changes.
 * 2. Break: invented text when nothing is published; a six-section version published; an edit of a published version;
 *    one person publishing alone; the approval spent on a draft that then refuses.
 * 3. Done bar: the Test row of RC-cex-spot-08, below, against the real router and engine with a stub identity.
 * 4. Class N
 * 5. Paths: services/svc-matching/src/router.ts + rulebook.ts + engine/engine.ts
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryJournal } from './engine/journal.js';
import { FileJournal } from './engine/journal-io.js';
import { RULEBOOK_IMMUTABLE, RULEBOOK_SECTION_UNSET, RULEBOOK_SECTIONS, RULEBOOK_UNPUBLISHED } from './rulebook.js';
import { registerRoutes } from './router.js';
import { matchingActionPayloadHash, stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';

const SECRET = 'matching-rulebook-router-secret-32ch!!';
const EDGE_SECRET = 'edge-principal-secret-at-least-32-characters';
const REGION = 'XX';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';
const DAY = 86_400_000;

function counting(inner: ActionApprovalConsumer) {
  let calls = 0;
  return {
    calls: () => calls,
    consume: async (input: Parameters<ActionApprovalConsumer['consume']>[0]) => {
      calls += 1;
      return inner.consume(input);
    },
  };
}

async function mount(opts: { journal?: MemoryJournal | FileJournal; now?: { t: number }; approver?: string } = {}) {
  const journal = opts.journal ?? new MemoryJournal();
  const now = opts.now ?? { t: Date.parse('2026-11-06T12:00:00.000Z') };
  const engine = new MatchingEngine({
    journal,
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
    clock: () => new Date(now.t),
  });
  await engine.recover();
  const approvals = counting(stubApprovalConsumer(opts.approver ?? CONFIRM, OPERATOR));
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, {
    bodyBind: 'require',
    approvals,
    operatorIds: new Set([OPERATOR, CONFIRM]),
    edgePrincipalSecret: EDGE_SECRET,
  });
  await app.ready();
  return { app, engine, journal, now, approvals };
}

function edgeHeaders() {
  const principal: Principal = {
    sub: OPERATOR,
    userId: OPERATOR,
    scopes: ['admin:write', 'admin:read'],
    tier: 'institutional',
    mfa: true,
    sid: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 60_000),
  };
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, REGION),
    'x-intafaced-region': REGION,
  };
}

function sections(tag: string, skip?: string): Record<string, string> {
  return Object.fromEntries(RULEBOOK_SECTIONS.filter((s) => s.id !== skip).map((s) => [s.id, `TEST ${s.title} rules for ${tag}.`]));
}

async function publish(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/operator/rulebook/publish',
    headers: edgeHeaders(),
    payload: { approvalId: 'appr-1', operationId: 'op-1', ...body },
  });
}

describe('GET /rulebook', () => {
  it('no versions: unpublished with matching.rulebook_unpublished and no text, no auth needed', async () => {
    const { app } = await mount();
    const res = await app.inject({ method: 'GET', url: '/rulebook' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      published: false,
      version: null,
      rejected: { code: RULEBOOK_UNPUBLISHED, message: RULEBOOK_UNPUBLISHED },
      upcoming: [],
    });
    const history = await app.inject({ method: 'GET', url: '/rulebook/versions' });
    expect(history.json()).toEqual({ current: null, versions: [] });
    await app.close();
  });

  it('ignores MATCHING_RULEBOOK_VERSION in the process env: the journal is the only source', async () => {
    const prev = process.env.MATCHING_RULEBOOK_VERSION;
    process.env.MATCHING_RULEBOOK_VERSION = 'ptx-m00.v1';
    try {
      const { app } = await mount();
      const res = await app.inject({ method: 'GET', url: '/rulebook' });
      expect(res.json().published).toBe(false);
      await app.close();
    } finally {
      if (prev === undefined) delete process.env.MATCHING_RULEBOOK_VERSION;
      else process.env.MATCHING_RULEBOOK_VERSION = prev;
    }
  });
});

describe('POST /operator/rulebook/check and /publish', () => {
  it('six of seven sections: check and publish refuse matching.rulebook_section_unset, and no approval is spent', async () => {
    const { app, approvals, journal } = await mount();
    const check = await app.inject({
      method: 'POST',
      url: '/operator/rulebook/check',
      headers: edgeHeaders(),
      payload: { version: 'TEST-v1', sections: sections('TEST-v1', 'market_data') },
    });
    expect(check.json()).toMatchObject({ accepted: false, rejected: { code: RULEBOOK_SECTION_UNSET } });
    expect(check.json().rejected.message).toContain('market data');
    const res = await publish(app, { version: 'TEST-v1', sections: sections('TEST-v1', 'fees') });
    expect(res.json()).toMatchObject({ accepted: false, rejected: { code: RULEBOOK_SECTION_UNSET } });
    expect(approvals.calls()).toBe(0);
    expect(journal.length).toBe(0);
    await app.close();
  });

  it('a whole draft checks to the exact approval target and payload hash publish recomputes', async () => {
    const { app } = await mount();
    const check = await app.inject({
      method: 'POST',
      url: '/operator/rulebook/check',
      headers: edgeHeaders(),
      payload: { version: 'TEST-v1', sections: sections('TEST-v1') },
    });
    const body = check.json();
    expect(body).toMatchObject({
      accepted: true,
      version: 'TEST-v1',
      actionType: 'matching.rulebook_publish',
      targetId: 'rulebook_publish:TEST-v1',
    });
    expect(body.payloadHash).toBe(matchingActionPayloadHash('matching.rulebook_publish', { version: 'TEST-v1', digest: body.digest }));
    await app.close();
  });

  it('refuses without the edge principal', async () => {
    const { app } = await mount();
    const res = await app.inject({
      method: 'POST',
      url: '/operator/rulebook/publish',
      payload: { version: 'TEST-v1', sections: sections('TEST-v1') },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('the same person as approver refuses and publishes nothing', async () => {
    const { app, journal } = await mount({ approver: OPERATOR });
    const res = await publish(app, { version: 'TEST-v1', sections: sections('TEST-v1') });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.missing');
    expect(journal.length).toBe(0);
    const read = await app.inject({ method: 'GET', url: '/rulebook' });
    expect(read.json().published).toBe(false);
    await app.close();
  });

  it('publishes v1 now and v2 next week: v1 current, v2 upcoming; after the date v2 current and v1 in history', async () => {
    const { app, now } = await mount();
    const v1 = await publish(app, { version: 'TEST-v1', sections: sections('TEST-v1') });
    expect(v1.json()).toMatchObject({
      accepted: true,
      version: 'TEST-v1',
      alreadyPublished: false,
      operatorId: OPERATOR,
      confirmOperatorId: CONFIRM,
    });
    const nextWeek = new Date(now.t + 7 * DAY).toISOString();
    const v2Sections = { ...sections('TEST-v1'), fees: 'TEST fees rules for TEST-v2.' };
    const v2 = await publish(app, {
      version: 'TEST-v2',
      effectiveAt: nextWeek,
      sections: v2Sections,
      approvalId: 'appr-2',
      operationId: 'op-2',
    });
    expect(v2.json()).toMatchObject({ accepted: true, version: 'TEST-v2' });

    let read = (await app.inject({ method: 'GET', url: '/rulebook' })).json();
    expect(read).toMatchObject({ published: true, version: 'TEST-v1', upcoming: [{ version: 'TEST-v2', effectiveAt: nextWeek }] });
    expect(read.sections.map((s: { title: string }) => s.title)).toEqual(RULEBOOK_SECTIONS.map((s) => s.title));
    expect(read.sections[0].body).toBe('TEST participation rules for TEST-v1.');

    now.t += 8 * DAY;
    read = (await app.inject({ method: 'GET', url: '/rulebook' })).json();
    expect(read).toMatchObject({ published: true, version: 'TEST-v2', effectiveAt: nextWeek, upcoming: [] });
    const history = (await app.inject({ method: 'GET', url: '/rulebook/versions' })).json();
    expect(history.current).toBe('TEST-v2');
    expect(history.versions.map((v: { version: string; status: string }) => [v.version, v.status])).toEqual([
      ['TEST-v2', 'current'],
      ['TEST-v1', 'superseded'],
    ]);
    expect(history.versions[0]).toMatchObject({ supersedes: 'TEST-v1', changedSections: ['fees'] });
    expect(history.versions[1].changedSections).toHaveLength(7);
    await app.close();
  });

  it('an edit of a published version refuses matching.rulebook_immutable before any approval is spent; a retry returns the first', async () => {
    const { app, approvals, journal } = await mount();
    await publish(app, { version: 'TEST-v1', sections: sections('TEST-v1') });
    expect(approvals.calls()).toBe(1);
    const edit = await publish(app, {
      version: 'TEST-v1',
      sections: { ...sections('TEST-v1'), matching: 'TEST changed.' },
      approvalId: 'appr-2',
    });
    expect(edit.json()).toMatchObject({ accepted: false, rejected: { code: RULEBOOK_IMMUTABLE } });
    const check = await app.inject({
      method: 'POST',
      url: '/operator/rulebook/check',
      headers: edgeHeaders(),
      payload: { version: 'TEST-v1', sections: { ...sections('TEST-v1'), matching: 'TEST changed.' } },
    });
    expect(check.json()).toMatchObject({ accepted: false, rejected: { code: RULEBOOK_IMMUTABLE } });
    const retry = await publish(app, { version: 'TEST-v1', sections: sections('TEST-v1') });
    expect(retry.json()).toMatchObject({ accepted: true, alreadyPublished: true });
    expect(approvals.calls()).toBe(1);
    expect(journal.length).toBe(1);
    await app.close();
  });

  it('refuses an effective time before publish', async () => {
    const { app, now, journal } = await mount();
    const res = await publish(app, { version: 'TEST-v1', effectiveAt: new Date(now.t - DAY).toISOString(), sections: sections('TEST-v1') });
    expect(res.json()).toMatchObject({ accepted: false, rejected: { code: 'matching.rulebook_effective_invalid' } });
    expect(journal.length).toBe(0);
    await app.close();
  });

  it('survives a restart: versions are rebuilt from the journal', async () => {
    const first = await mount();
    await publish(first.app, { version: 'TEST-v1', sections: sections('TEST-v1') });
    await first.app.close();
    const second = await mount({ journal: first.journal, now: first.now });
    const read = (await second.app.inject({ method: 'GET', url: '/rulebook' })).json();
    expect(read).toMatchObject({ published: true, version: 'TEST-v1' });
    expect(read.sections[6]).toEqual({ id: 'market_data', title: 'market data', body: 'TEST market data rules for TEST-v1.' });
    await second.app.close();
  });

  it('survives a restart on the file journal: the record decodes back to the same text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rulebook-journal-'));
    const path = join(dir, 'engine_journal.ndjson');
    try {
      const journal = new FileJournal(path);
      const first = await mount({ journal });
      await publish(first.app, { version: 'TEST-v1', sections: sections('TEST-v1') });
      await first.app.close();
      journal.close();
      const second = await mount({ journal: new FileJournal(path), now: first.now });
      const read = (await second.app.inject({ method: 'GET', url: '/rulebook' })).json();
      expect(read).toMatchObject({ published: true, version: 'TEST-v1' });
      expect(read.sections.map((s: { body: string }) => s.body)).toEqual(Object.values(sections('TEST-v1')));
      await second.app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
