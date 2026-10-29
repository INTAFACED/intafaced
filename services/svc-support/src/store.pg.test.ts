import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestDatabase, createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresSupportStore } from './store.js';

/**
 * PostgresSupportStore — multi-replica claim exclusivity is the load-bearing
 * property. Memory cannot prove two workers racing the same row.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const migration = (file: string) => readFileSync(join(migrationsDir, file), 'utf8');
const MIGRATION_0003 = migration('0003_kb_articles.sql');
const MIGRATION_0004 = migration('0004_kb_article_versions.sql');
// This suite's own schema, applied unswallowed in this order. It is a chosen subset, not every migration: the published
// KB block below replays 0003 and 0004 and rewrites rows that later migrations make immutable.
const MIGRATIONS = [
  '0000_support_init.sql',
  '0001_support_audit_and_case_file.sql',
  '0002_support_lifecycle_full.sql',
  '0003_kb_articles.sql',
  '0004_kb_article_versions.sql',
  '0005_support_audit_delete_refused.sql',
  '0009_support_ratings.sql',
  '0010_support_attachments.sql',
  '0011_kb_topic_and_feedback.sql',
  '0014_ticket_phishing_report.sql',
  '0022_kb_article_audience.sql',
  '0032_kb_library.sql',
].map(migration);

const USER = '11111111-1111-4111-8111-111111111111';
const OP_A = '33333333-3333-4333-8333-333333333333';
const OP_B = '44444444-4444-4444-8444-444444444444';

// A per-run database (#6713): on the shared intafaced_test, other files' migration replays and truncates ran under this
// file's tests.
const available = await postgresAvailable(ADMIN_URL);
const db: TestDatabase | null = available ? await createTestDatabase({ service: 'support', url: ADMIN_URL, migrations: MIGRATIONS }) : null;
const sql = db?.sql ?? null;
if (sql) await assertTestDatabase(sql, 'svc-support store.pg.test');

afterAll(async () => {
  await db?.drop();
}, 30_000);

describe.skipIf(!available)('PostgresSupportStore — durable desk', () => {
  const store = () => new PostgresSupportStore(sql!);

  beforeEach(async () => {
    // Ticket removal no longer clears the audit, so this suite resets its own tables.
    await sql!.unsafe(
      'TRUNCATE TABLE support.comments, support.ticket_events, support.case_files, support.tickets RESTART IDENTITY CASCADE',
    );
  });

  it('creates and lists tickets by owner', async () => {
    const s = store();
    const t = await s.createTicket({
      userId: USER,
      category: 'account',
      subject: 'Cannot sign in',
      body: 'Help',
    });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(t).not.toHaveProperty('balance');
    expect(await s.listByUser(USER)).toHaveLength(1);
    expect(await s.listByUser('22222222-2222-4222-8222-222222222222')).toHaveLength(0);
  });

  it('two concurrent claims: exactly one operator wins', async () => {
    const s = store();
    const t = await s.createTicket({
      userId: USER,
      category: 'deposit_withdraw',
      subject: 'Pending deposit',
      body: 'Details',
    });

    const [a, b] = await Promise.all([
      s.claimTicket({ ticketId: t.id, operatorId: OP_A }),
      s.claimTicket({ ticketId: t.id, operatorId: OP_B }),
    ]);

    const wins = [a, b].filter((r) => r.status === 'ok');
    const losses = [a, b].filter((r) => r.status === 'refuse');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    if (losses[0]!.status === 'refuse') expect(losses[0]!.reason).toBe('already_claimed');

    const final = await s.findById(t.id);
    expect(final?.assigneeId).toBeTruthy();
    expect([OP_A, OP_B]).toContain(final!.assigneeId);
  });

  describe('PostgresSupportStore — phishing reports (I-signin-sessions-27)', () => {
    const store = () => new PostgresSupportStore(sql!);
    const REPORT = {
      userId: USER,
      category: 'phishing' as const,
      subject: 'Fake sign-in email',
      body: 'Forwarded below',
      messageHeaders: 'Received: from mx.example.test\nFrom: "Support" <help@lookalike.example.test>',
    };

    beforeEach(async () => {
      await sql!.unsafe(
        'TRUNCATE TABLE support.comments, support.ticket_events, support.case_files, support.tickets RESTART IDENTITY CASCADE',
      );
      await sql!`DELETE FROM support.write_receipts WHERE procedure = 'support.create'`;
    });

    it('stores the pasted headers on a phishing ticket and reads them back from every door', async () => {
      const s = store();
      const t = await s.createTicket(REPORT);
      expect(t).toMatchObject({ category: 'phishing', messageHeaders: REPORT.messageHeaders });
      expect((await s.findById(t.id))?.messageHeaders).toBe(REPORT.messageHeaders);
      expect((await s.listByUser(USER))[0]?.messageHeaders).toBe(REPORT.messageHeaders);
      expect((await s.listAll())[0]?.messageHeaders).toBe(REPORT.messageHeaders);
    });

    it('a ticket without headers carries none', async () => {
      const t = await store().createTicket({ userId: USER, category: 'account', subject: 's', body: 'b' });
      expect(t).not.toHaveProperty('messageHeaders');
    });

    it('the database refuses headers on another category and over the cap', async () => {
      const other = await tryInsert('account', 'Received: x');
      const oversize = await tryInsert('phishing', 'x'.repeat(10_001));
      const empty = await tryInsert('phishing', '');
      const atCap = await tryInsert('phishing', 'x'.repeat(10_000));
      expect(other).toBe('23514');
      expect(oversize).toBe('23514');
      expect(empty).toBe('23514');
      expect(atCap).toBeUndefined();
    });

    it('a replay with the same key returns the first ticket and writes one ticket and one trail row', async () => {
      const s = store();
      const first = await s.createTicketOnce({ ...REPORT, clientRequestId: 'report-1' });
      const replay = await s.createTicketOnce({ ...REPORT, clientRequestId: 'report-1' });
      expect(replay).toEqual(first);
      expect(await s.listByUser(USER)).toHaveLength(1);
      const events = await sql!`SELECT 1 FROM support.ticket_events WHERE ticket_id = ${first.id}`;
      expect(events).toHaveLength(1);
    });

    it('two concurrent submissions of one key make one ticket', async () => {
      const s = store();
      const [a, b, c] = await Promise.all([
        s.createTicketOnce({ ...REPORT, clientRequestId: 'report-race' }),
        s.createTicketOnce({ ...REPORT, clientRequestId: 'report-race' }),
        s.createTicketOnce({ ...REPORT, clientRequestId: 'report-race' }),
      ]);
      expect(new Set([a.id, b.id, c.id]).size).toBe(1);
      expect(await s.listByUser(USER)).toHaveLength(1);
    });

    it('the same key with different content is a conflict and stores nothing new', async () => {
      const s = store();
      await s.createTicketOnce({ ...REPORT, clientRequestId: 'report-2' });
      await expect(s.createTicketOnce({ ...REPORT, body: 'A different message', clientRequestId: 'report-2' })).rejects.toThrow(
        'support.idempotency_conflict',
      );
      expect(await s.listByUser(USER)).toHaveLength(1);
    });

    it('a key is per caller: another user with the same key gets their own ticket', async () => {
      const s = store();
      const mine = await s.createTicketOnce({ ...REPORT, clientRequestId: 'shared-key' });
      const theirs = await s.createTicketOnce({ ...REPORT, userId: OP_A, clientRequestId: 'shared-key' });
      expect(theirs.id).not.toBe(mine.id);
      expect(theirs.userId).toBe(OP_A);
    });

    async function tryInsert(category: string, headers: string): Promise<string | undefined> {
      try {
        await sql!`INSERT INTO support.tickets (user_id, category, subject, body, message_headers) VALUES (${USER}, ${category}, 's', 'b', ${headers})`;
        return undefined;
      } catch (err) {
        return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : 'unknown';
      }
    }
  });
});

/**
 * The audit trail and case file, against the database.
 *
 * Everything here is a property TypeScript cannot hold. `lifecycle.ts` says
 * `closed` is terminal and `store.ts` never UPDATEs a trail row — both true, and
 * both irrelevant to somebody with a psql prompt. These tests are the assertions
 * that the DATABASE refuses, so the guarantee survives a caller that is not this
 * codebase.
 */
describe.skipIf(!available)('audit trail and case file — enforced in Postgres', () => {
  const store = () => new PostgresSupportStore(sql!);

  beforeEach(async () => {
    // Ticket removal no longer clears the audit, so this suite resets its own tables.
    await sql!.unsafe(
      'TRUNCATE TABLE support.comments, support.ticket_events, support.case_files, support.tickets RESTART IDENTITY CASCADE',
    );
  });

  const open = () => store().createTicket({ userId: USER, category: 'account', subject: 'S', body: 'B' });

  it('creating a ticket writes `opened` at sequence 1, in the same transaction', async () => {
    const t = await open();
    const trail = await store().listEvents(t.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ sequence: 1, kind: 'opened', actorRole: 'user' });
  });

  it('the trail cannot be UPDATEd', async () => {
    const t = await open();
    await expect(sql!`UPDATE support.ticket_events SET note = 'rewritten' WHERE ticket_id = ${t.id}`).rejects.toMatchObject({
      // The code, not the sentence. 'check_violation' is what the trigger raises.
      code: '23514',
    });
  });

  it('the trail of a LIVE ticket cannot be DELETEd', async () => {
    const t = await open();
    await expect(sql!`DELETE FROM support.ticket_events WHERE ticket_id = ${t.id}`).rejects.toMatchObject({ code: '23514' });
    expect(await store().listEvents(t.id)).toHaveLength(1);
  });

  it('erasing the ticket does not erase its history', async () => {
    const t = await open();
    await expect(sql!`DELETE FROM support.tickets WHERE id = ${t.id}`).rejects.toMatchObject({ code: '23503' });
    expect(await store().listEvents(t.id)).toHaveLength(1);
    const left = await sql!`SELECT 1 FROM support.ticket_events WHERE ticket_id = ${t.id}`;
    expect(left).toHaveLength(1);
  });

  it('erasing a ticket does not erase its case file', async () => {
    const s = store();
    const t = await open();
    await s.putCaseFile({
      ticketId: t.id,
      escalatedBy: OP_A,
      reason: 'other',
      citations: [{ kind: 'kb_article', ref: 'kb-account-access', digest: 'a'.repeat(64), readAt: '2026-08-09T10:00:00.000Z' }],
      grounding: { status: 'unread', reason: 'plane_dark' },
      summary: 'Escalating.',
      createdAt: '2026-08-09T10:00:00.000Z',
    });
    await expect(sql!`DELETE FROM support.tickets WHERE id = ${t.id}`).rejects.toMatchObject({ code: '23503' });
    expect(await s.latestCaseFile(t.id)).not.toBeNull();
  });

  it('sequence is unique per ticket — a duplicate is refused by the index', async () => {
    const t = await open();
    await expect(
      sql!`
        INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role)
        VALUES (${t.id}, 1, 'escalated', ${OP_A}, 'operator')
      `,
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });

  it('a status_changed row that does not say what changed is refused', async () => {
    const t = await open();
    await expect(
      sql!`
        INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role)
        VALUES (${t.id}, 2, 'status_changed', ${OP_A}, 'operator')
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('closed is terminal in the database, not only in lifecycle.ts', async () => {
    const s = store();
    const t = await open();
    expect((await s.setStatus({ ticketId: t.id, status: 'closed', operatorId: OP_A })).status).toBe('ok');
    // The service refuses this too. Here we go around the service entirely.
    await expect(sql!`UPDATE support.tickets SET status = 'open' WHERE id = ${t.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('illegal transitions (e.g. resolved → pending) are refused by the database too', async () => {
    const s = store();
    const t = await open();
    expect((await s.setStatus({ ticketId: t.id, status: 'resolved', operatorId: OP_A })).status).toBe('ok');
    // 0001 only blocked leaving closed. 0002 mirrors lifecycle.ts fully so a
    // psql bypass cannot invent a status history the service would refuse.
    await expect(sql!`UPDATE support.tickets SET status = 'pending' WHERE id = ${t.id}`).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('claim trail reconstructs status even when racing setStatus', async () => {
    const s = store();
    const t = await open();
    // Concurrent: operator A moves status, operator B claims. Whatever wins,
    // every status_changed.from must equal the status the trail held just before.
    await Promise.all([
      s.setStatus({ ticketId: t.id, status: 'pending', operatorId: OP_A }),
      s.claimTicket({ ticketId: t.id, operatorId: OP_B }),
    ]);
    const trail = await s.listEvents(t.id);
    let status: string = 'open'; // after `opened`
    for (const e of trail) {
      if (e.kind === 'status_changed') {
        expect(e.fromStatus).toBe(status);
        status = e.toStatus!;
      }
    }
    const final = await s.findById(t.id);
    expect(final?.status).toBe(status);
  });

  it('claim after setStatus(pending) records assigned only — no invented open→pending', async () => {
    const s = store();
    const t = await open();
    await s.setStatus({ ticketId: t.id, status: 'pending', operatorId: OP_A });
    expect((await s.claimTicket({ ticketId: t.id, operatorId: OP_B })).status).toBe('ok');
    const trail = await s.listEvents(t.id);
    const changes = trail.filter((e) => e.kind === 'status_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromStatus: 'open', toStatus: 'pending', actorId: OP_A });
    expect(trail.filter((e) => e.kind === 'assigned')).toHaveLength(1);
  });

  it('a lifecycle move and its trail row commit together', async () => {
    const s = store();
    const t = await open();
    const moved = await s.setStatus({ ticketId: t.id, status: 'pending', operatorId: OP_A, note: 'picked up' });
    expect(moved.status).toBe('ok');

    const trail = await s.listEvents(t.id);
    expect(trail.map((e) => e.kind)).toEqual(['opened', 'status_changed']);
    expect(trail[1]).toMatchObject({ sequence: 2, fromStatus: 'open', toStatus: 'pending', actorId: OP_A, note: 'picked up' });
  });

  it('a refused lifecycle move writes no trail row', async () => {
    const s = store();
    const t = await open();
    const same = await s.setStatus({ ticketId: t.id, status: 'open', operatorId: OP_A });
    expect(same).toEqual({ status: 'refuse', reason: 'same_status' });
    expect(await s.listEvents(t.id)).toHaveLength(1);
  });

  it('a winning claim records assignment and the status move it caused', async () => {
    const s = store();
    const t = await open();
    expect((await s.claimTicket({ ticketId: t.id, operatorId: OP_A })).status).toBe('ok');
    const trail = await s.listEvents(t.id);
    expect(trail.map((e) => e.kind)).toEqual(['opened', 'assigned', 'status_changed']);
    expect(trail.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('a losing claim writes no trail row at all', async () => {
    const s = store();
    const t = await open();
    await Promise.all([s.claimTicket({ ticketId: t.id, operatorId: OP_A }), s.claimTicket({ ticketId: t.id, operatorId: OP_B })]);
    const trail = await s.listEvents(t.id);
    // Exactly one operator's assignment, never two.
    expect(trail.filter((e) => e.kind === 'assigned')).toHaveLength(1);
    expect(trail.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('a user reply on resolved reopens and clears the assignee in the same transaction', async () => {
    const s = store();
    const t = await open();
    expect((await s.claimTicket({ ticketId: t.id, operatorId: OP_A })).status).toBe('ok');
    expect((await s.setStatus({ ticketId: t.id, status: 'resolved', operatorId: OP_A })).status).toBe('ok');

    const result = await s.addComment({
      ticketId: t.id,
      authorId: USER,
      authorRole: 'user',
      body: 'This is not fixed.',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.reopened).toBe(true);
    expect(result.ticket.status).toBe('open');
    expect(result.ticket.assigneeId).toBeNull();

    const trail = await s.listEvents(t.id);
    const reopen = trail.filter((e) => e.kind === 'status_changed' && e.toStatus === 'open' && e.fromStatus === 'resolved');
    expect(reopen).toHaveLength(1);
    expect(reopen[0]).toMatchObject({ actorId: USER, actorRole: 'user', note: 'user_reply_reopen' });
  });

  it('a user comment on closed is refused and writes neither comment nor trail', async () => {
    const s = store();
    const t = await open();
    expect((await s.setStatus({ ticketId: t.id, status: 'closed', operatorId: OP_A })).status).toBe('ok');
    const before = await s.listEvents(t.id);

    const result = await s.addComment({
      ticketId: t.id,
      authorId: USER,
      authorRole: 'user',
      body: 'Please reopen.',
    });
    expect(result).toEqual({ status: 'refuse', reason: 'terminal' });
    expect(await s.listComments(t.id)).toHaveLength(0);
    expect(await s.listEvents(t.id)).toHaveLength(before.length);
    expect((await s.findById(t.id))?.status).toBe('closed');
  });

  it('a case file round-trips its citations and grounding through jsonb', async () => {
    const s = store();
    const t = await open();
    const caseFile = {
      ticketId: t.id,
      escalatedBy: OP_A,
      reason: 'kyc_review' as const,
      citations: [
        { kind: 'kb_article' as const, ref: 'kb-account-access', digest: 'a'.repeat(64), readAt: '2026-08-09T10:00:00.000Z' },
        { kind: 'account_state' as const, ref: USER, digest: 'b'.repeat(64), readAt: '2026-08-09T10:00:00.000Z' },
      ],
      grounding: {
        status: 'read' as const,
        state: { userId: USER, status: 'frozen' as const, kycTier: 'basic' as const },
        readAt: '2026-08-09T10:00:00.000Z',
      },
      summary: 'Tier does not match the deposit route.',
      createdAt: '2026-08-09T10:00:00.000Z',
    };
    await s.putCaseFile(caseFile);
    const read = await s.latestCaseFile(t.id);
    expect(read?.citations).toEqual(caseFile.citations);
    expect(read?.grounding).toEqual(caseFile.grounding);
    expect(read?.reason).toBe('kyc_review');
  });

  it('a case file cannot be edited after the fact', async () => {
    const s = store();
    const t = await open();
    await s.putCaseFile({
      ticketId: t.id,
      escalatedBy: OP_A,
      reason: 'other',
      citations: [{ kind: 'kb_article', ref: 'kb-account-access', digest: 'a'.repeat(64), readAt: '2026-08-09T10:00:00.000Z' }],
      grounding: { status: 'unread', reason: 'plane_dark' },
      summary: 'Escalating.',
      createdAt: '2026-08-09T10:00:00.000Z',
    });
    // A mutable case file can be brought into line with whatever the outcome
    // turned out to be, which is worse than none: it reads as contemporaneous
    // evidence while being a later reconstruction.
    await expect(sql!`UPDATE support.case_files SET summary = 'different' WHERE ticket_id = ${t.id}`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(sql!`DELETE FROM support.case_files WHERE ticket_id = ${t.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('a case file citing nothing is refused by the database too', async () => {
    const t = await open();
    await expect(
      sql!`
        INSERT INTO support.case_files (ticket_id, escalated_by, reason, citations, grounding, summary)
        VALUES (${t.id}, ${OP_A}, 'other', '[]'::jsonb, '{"status":"unread","reason":"not_attempted"}'::jsonb, 'Escalating.')
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('there is no money column on either new table', async () => {
    const columns = await sql!<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'support' AND table_name IN ('ticket_events', 'case_files')
    `;
    const names = columns.map((c) => c.column_name);
    expect(names.length).toBeGreaterThan(0);
    for (const banned of ['amount', 'currency', 'asset', 'balance', 'value', 'credit', 'debit', 'payout']) {
      expect(names).not.toContain(banned);
    }
  });
});

describe.skipIf(!available)('PostgresSupportStore — published KB', () => {
  const store = () => new PostgresSupportStore(sql!);

  async function restoreSeed() {
    await sql!`DELETE FROM support.kb_article_versions`;
    await sql!`DELETE FROM support.kb_articles`;
    await sql!.unsafe(MIGRATION_0003);
    await sql!.unsafe(MIGRATION_0004);
  }

  beforeEach(async () => {
    await restoreSeed();
  });

  it('seeds five published spine rows and lists only those', async () => {
    const list = await store().listPublishedKb();
    expect(list).toHaveLength(5);
    expect(list.every((a) => a.published === true && a.revision === 1)).toBe(true);
    expect(list.every((a) => a.titleKey.startsWith('support.kb.'))).toBe(true);
  });

  it('unpublish hides the row from getPublishedKb', async () => {
    const s = store();
    const hidden = await s.putKbRevision({ id: 'kb-paper-vs-live', baseRevision: 1, published: false });
    expect(hidden.status).toBe('ok');
    expect(await s.getPublishedKb('kb-paper-vs-live')).toBeNull();
    expect((await s.listPublishedKb()).some((a) => a.id === 'kb-paper-vs-live')).toBe(false);
  });

  it('stale publish refuses and leaves the current revision', async () => {
    const s = store();
    const first = await s.putKbRevision({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      baseRevision: 1,
      published: true,
    });
    expect(first).toMatchObject({ status: 'ok', article: { revision: 2 } });
    const stale = await s.putKbRevision({
      id: 'kb-account-access',
      titleKey: 'support.kb.account_access.title',
      bodyKey: 'support.kb.account_access.body',
      baseRevision: 1,
      published: true,
    });
    expect(stale).toEqual({ status: 'refuse', reason: 'revision_stale' });
    expect(await s.getPublishedKb('kb-account-access')).toMatchObject({ revision: 2, version: 2 });
    expect(await s.listKbVersions('kb-account-access')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: 1, bodyKey: 'support.kb.account_access.body' }),
        expect.objectContaining({ version: 2, bodyKey: 'support.kb.account_access.body' }),
      ]),
    );
  });

  it('kb_articles table has no amount/balance/currency column', async () => {
    const columns = await sql!<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'support' AND table_name = 'kb_articles'
    `;
    const names = columns.map((c) => c.column_name);
    expect(names.length).toBeGreaterThan(0);
    for (const banned of ['amount', 'currency', 'asset', 'balance', 'value', 'credit', 'debit', 'payout']) {
      expect(names).not.toContain(banned);
    }
  });
});
