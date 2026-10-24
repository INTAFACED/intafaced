import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase } from '@intafaced/db';
import {
  ATTACHMENT_ALLOWED_TYPES_KEY,
  ATTACHMENT_MAX_BYTES_KEY,
  ATTACHMENT_SCANNER_KEY,
  ATTACHMENT_STORE_KEY,
  MemoryAttachmentStore,
  MemoryMalwareScanner,
  type AttachmentDesk,
  type ScanVerdict,
} from './attachments.js';
import { SupportError, SupportService } from './support-service.js';
import { PostgresSupportStore } from './store.js';

/**
 * Owner close, rate, attach, and KB topic/feedback against Postgres.
 * The admin URL is TEST_DATABASE_URL. This file creates its own database
 * whose name ends in _test and drops it. It does not start Docker.
 */

const adminUrl = process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl) throw new Error('TEST_DATABASE_URL unset');

const here = dirname(fileURLToPath(import.meta.url));
const database = `itf_run_support_${process.pid}_${Math.random().toString(36).slice(2, 8)}_test`;
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort();

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';

const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let service: SupportService;
let files: MemoryAttachmentStore;

function desk(overrides: Partial<AttachmentDesk> = {}): AttachmentDesk {
  return {
    store: files,
    scanner: new MemoryMalwareScanner('clean'),
    maxBytes: 8,
    allowedTypes: ['text/plain'],
    maxCount: 10,
    ...overrides,
  };
}

async function refuse(run: Promise<unknown>): Promise<SupportError> {
  try {
    await run;
    throw new Error('expected a refusal');
  } catch (err) {
    if (err instanceof SupportError) return err;
    throw err;
  }
}

describe('support desk owner procedures', () => {
  beforeAll(async () => {
    if (!/^[a-z0-9_]+$/.test(database) || !database.endsWith('_test')) {
      throw new Error(`refusing database name ${database}`);
    }
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });
    await assertTestDatabase(sql, 'desk-owner.pg.test');
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
    for (const file of migrations) {
      await sql.unsafe(readFileSync(join(here, '..', 'drizzle', file), 'utf8'));
    }
    files = new MemoryAttachmentStore();
    service = new SupportService(new PostgresSupportStore(sql), undefined, desk());
  }, 120_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  async function open(subject: string) {
    return service.createTicket({ userId: OWNER, category: 'account', subject, body: 'Body' });
  }

  it('owner closes an open ticket and a resolved ticket, and a replay writes nothing', async () => {
    const opened = await open('Close open');
    const first = await service.close({ userId: OWNER, ticketId: opened.id, clientRequestId: 'close-open' });
    expect(first.status).toBe('closed');
    const trail = await service.listTicketEvents({ userId: OWNER, ticketId: opened.id, limit: 100 });
    expect(trail).toContainEqual(
      expect.objectContaining({ kind: 'status_changed', actorId: OWNER, actorRole: 'user', fromStatus: 'open', toStatus: 'closed' }),
    );
    const again = await service.close({ userId: OWNER, ticketId: opened.id, clientRequestId: 'close-open' });
    expect(again).toEqual(first);
    expect(await service.listTicketEvents({ userId: OWNER, ticketId: opened.id, limit: 100 })).toEqual(trail);

    const resolved = await open('Close resolved');
    await service.setStatus({ operatorId: OP, ticketId: resolved.id, status: 'resolved' });
    const closed = await service.close({ userId: OWNER, ticketId: resolved.id, clientRequestId: 'close-resolved' });
    expect(closed.status).toBe('closed');
    const resolvedTrail = await service.listTicketEvents({ userId: OWNER, ticketId: resolved.id, limit: 100 });
    expect(resolvedTrail).toContainEqual(
      expect.objectContaining({ actorId: OWNER, actorRole: 'user', fromStatus: 'resolved', toStatus: 'closed' }),
    );
  });

  it('a status the lifecycle table forbids stays unchanged, and another account is not found', async () => {
    const ticket = await open('Already closed');
    await service.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'closed' });
    const before = await service.listTicketEvents({ userId: OWNER, ticketId: ticket.id, limit: 100 });
    const err = await refuse(service.close({ userId: OWNER, ticketId: ticket.id, clientRequestId: 'close-again' }));
    expect(err.code).toBe('support.transition_same_status');
    expect((await service.getTicket({ userId: OWNER, ticketId: ticket.id })).status).toBe('closed');
    expect(await service.listTicketEvents({ userId: OWNER, ticketId: ticket.id, limit: 100 })).toEqual(before);

    const hidden = await open('Not yours');
    const leaked = await refuse(service.close({ userId: OTHER, ticketId: hidden.id, clientRequestId: 'close-other' }));
    expect(leaked.code).toBe('support.not_found');
    expect(leaked.message).not.toContain(hidden.id);
    expect((await service.getTicket({ userId: OWNER, ticketId: hidden.id })).status).toBe('open');
  });

  it('rates a resolved ticket once, refuses an open ticket, a bad score, and another account', async () => {
    const pending = await open('Rate open');
    expect((await refuse(service.rate({ userId: OWNER, ticketId: pending.id, score: 5, clientRequestId: 'rate-open' }))).code).toBe(
      'support.rate_status_refused',
    );

    const ticket = await open('Rate resolved');
    await service.setStatus({ operatorId: OP, ticketId: ticket.id, status: 'resolved' });
    expect((await refuse(service.rate({ userId: OWNER, ticketId: ticket.id, score: 0, clientRequestId: 'rate-zero' }))).code).toBe(
      'support.rate_score_out_of_range',
    );
    expect((await refuse(service.rate({ userId: OWNER, ticketId: ticket.id, score: 6, clientRequestId: 'rate-six' }))).code).toBe(
      'support.rate_score_out_of_range',
    );
    expect((await refuse(service.rate({ userId: OWNER, ticketId: ticket.id, score: 1.5, clientRequestId: 'rate-float' }))).code).toBe(
      'support.rate_score_out_of_range',
    );
    const rowsBefore = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM support.ticket_ratings WHERE ticket_id = ${ticket.id}`;
    expect(rowsBefore[0]!.n).toBe(0);

    const rating = await service.rate({ userId: OWNER, ticketId: ticket.id, score: 4, note: 'Clear', clientRequestId: 'rate-once' });
    expect(rating).toMatchObject({ ticketId: ticket.id, userId: OWNER, score: 4, note: 'Clear' });
    const replay = await service.rate({ userId: OWNER, ticketId: ticket.id, score: 1, clientRequestId: 'rate-once' });
    expect(replay).toEqual(rating);
    expect(
      (await refuse(service.rate({ userId: OWNER, ticketId: ticket.id, score: 2, note: 'Changed', clientRequestId: 'rate-second' }))).code,
    ).toBe('support.already_rated');
    expect(await service.rating({ userId: OWNER, ticketId: ticket.id })).toEqual(rating);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM support.ticket_ratings WHERE ticket_id = ${ticket.id}`;
    expect(rows[0]!.n).toBe(1);

    const otherRate = await refuse(service.rate({ userId: OTHER, ticketId: ticket.id, score: 5, clientRequestId: 'rate-other' }));
    expect(otherRate.code).toBe('support.not_found');
    const otherRead = await refuse(service.rating({ userId: OTHER, ticketId: ticket.id }));
    expect(otherRead.code).toBe('support.not_found');
    expect(await service.rating({ userId: OP, ticketId: ticket.id, asOperator: true })).toEqual(rating);
    expect(await service.ratedTicketIds(OWNER)).toContain(ticket.id);
    expect(await service.ratedTicketIds(OTHER)).not.toContain(ticket.id);
  });

  it('stores one clean attachment, and refuses size, type, scanner, another account, and a blank store', async () => {
    const ticket = await open('Attach');
    const body = Buffer.from('hello').toString('base64');

    const bigStore = new MemoryAttachmentStore();
    const big = new SupportService(new PostgresSupportStore(sql), undefined, desk({ store: bigStore, maxBytes: 4 }));
    expect(
      (
        await refuse(
          big.attach({ userId: OWNER, ticketId: ticket.id, clientRequestId: 'attach-big', contentType: 'text/plain', bodyBase64: body }),
        )
      ).code,
    ).toBe('support.attachment_too_large');
    expect(bigStore.puts).toBe(0);

    const wrongStore = new MemoryAttachmentStore();
    const wrong = new SupportService(new PostgresSupportStore(sql), undefined, desk({ store: wrongStore, allowedTypes: ['image/png'] }));
    expect(
      (
        await refuse(
          wrong.attach({ userId: OWNER, ticketId: ticket.id, clientRequestId: 'attach-type', contentType: 'text/plain', bodyBase64: body }),
        )
      ).code,
    ).toBe('support.attachment_type_refused');
    expect(wrongStore.puts).toBe(0);

    for (const verdict of ['infected', 'unknown'] as const) {
      const scanStore = new MemoryAttachmentStore();
      const scanned = new SupportService(
        new PostgresSupportStore(sql),
        undefined,
        desk({ store: scanStore, scanner: new MemoryMalwareScanner(verdict satisfies ScanVerdict) }),
      );
      expect(
        (
          await refuse(
            scanned.attach({
              userId: OWNER,
              ticketId: ticket.id,
              clientRequestId: `attach-${verdict}`,
              contentType: 'text/plain',
              bodyBase64: body,
            }),
          )
        ).code,
      ).toBe(verdict === 'infected' ? 'support.attachment_scan_refused' : 'support.attachment_scan_unknown');
      // An infected file's bytes are never stored. A file the scanner could not judge is held with its bytes, to be scanned again.
      expect(scanStore.puts).toBe(verdict === 'infected' ? 0 : 1);
      const [held] = await sql<{ scan_state: string }[]>`
        SELECT scan_state FROM support.ticket_attachments WHERE client_request_id = ${`attach-${verdict}`}
      `;
      expect(held?.scan_state).toBe(verdict === 'infected' ? 'blocked' : 'scanning');
    }

    const bare = new MemoryAttachmentStore();
    const cases: Array<{ missing: string; overrides: Partial<AttachmentDesk> }> = [
      { missing: ATTACHMENT_STORE_KEY, overrides: { store: null } },
      { missing: ATTACHMENT_SCANNER_KEY, overrides: { scanner: null } },
      { missing: ATTACHMENT_MAX_BYTES_KEY, overrides: { maxBytes: null } },
      { missing: ATTACHMENT_ALLOWED_TYPES_KEY, overrides: { allowedTypes: null } },
    ];
    for (const [index, item] of cases.entries()) {
      const unconfigured = new SupportService(new PostgresSupportStore(sql), undefined, desk({ store: bare, ...item.overrides }));
      const err = await refuse(
        unconfigured.attach({
          userId: OWNER,
          ticketId: ticket.id,
          clientRequestId: `attach-blank-${index}`,
          contentType: 'text/plain',
          bodyBase64: body,
        }),
      );
      expect(err.code).toBe('support.attachments_unconfigured');
      expect(err.missingKey).toBe(item.missing);
    }
    expect(bare.puts).toBe(0);

    const cleanStore = new MemoryAttachmentStore();
    const clean = new SupportService(new PostgresSupportStore(sql), undefined, desk({ store: cleanStore }));
    const saved = await clean.attach({
      userId: OWNER,
      ticketId: ticket.id,
      clientRequestId: 'attach-ok',
      contentType: 'text/plain',
      bodyBase64: body,
    });
    const replay = await clean.attach({
      userId: OWNER,
      ticketId: ticket.id,
      clientRequestId: 'attach-ok',
      contentType: 'text/plain',
      bodyBase64: body,
    });
    expect(replay).toEqual(saved);
    expect(cleanStore.puts).toBe(1);
    const count = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM support.ticket_attachments WHERE ticket_id = ${ticket.id} AND scan_state = 'clean'`;
    expect(count[0]!.n).toBe(1);
    expect(cleanStore.objects.get(saved.storeKey)?.bytes).toEqual(new Uint8Array(Buffer.from('hello')));

    expect((await refuse(clean.attachment({ userId: OTHER, attachmentId: saved.id }))).code).toBe('support.not_found');
    expect((await refuse(clean.attachment({ userId: OP, attachmentId: saved.id, asOperator: true }))).code).toBe('support.not_found');
    await service.claimForOperator({ operatorId: OP, ticketId: ticket.id });
    expect(await clean.attachment({ userId: OP, attachmentId: saved.id, asOperator: true })).toEqual(saved);
  });

  it('keeps category and tags on the version row, one vote per version, and related published articles', async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'support'
        AND table_name IN ('kb_articles', 'kb_article_versions')
        AND column_name IN ('category', 'tags')
    `;
    expect(columns.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual([
      'kb_article_versions.category',
      'kb_article_versions.tags',
    ]);

    const publish = (id: string, category: string, tags: string[]) =>
      service.publishKb({
        id,
        titleKey: `support.kb.${id}.title`,
        bodyKey: `support.kb.${id}.body`,
        baseRevision: 0,
        category,
        tags,
      });
    await publish('kb-supportbe-alpha', 'topic-a', ['shared-tag']);
    await publish('kb-supportbe-beta', 'topic-a', ['other-tag']);
    await publish('kb-supportbe-delta', 'topic-b', ['shared-tag']);
    await publish('kb-supportbe-epsilon', 'topic-c', ['solo']);
    await publish('kb-supportbe-gamma', 'topic-a', ['shared-tag']);
    await service.unpublishKb({ id: 'kb-supportbe-gamma', baseRevision: 1 });

    const article = await service.getKbArticle('kb-supportbe-alpha');
    expect(article).toMatchObject({ category: 'topic-a', tags: ['shared-tag'], published: true });

    const related = (await service.kbRelated({ id: 'kb-supportbe-alpha' })).map((row) => row.id).sort();
    expect(related).toEqual(['kb-supportbe-beta', 'kb-supportbe-delta']);
    expect(await service.kbRelated({ id: 'kb-supportbe-gamma' })).toEqual([]);

    // Votes are bound by the owner's rate; a blank one refuses (kb-feedback.test.ts).
    const voter = new SupportService(
      new PostgresSupportStore(sql),
      undefined,
      desk(),
      undefined,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      { feedbackRateLimit: 100, feedbackRateWindowSeconds: 3600 },
    );
    const hidden = await refuse(voter.kbFeedback({ userId: OWNER, id: 'kb-supportbe-gamma', helpful: true, clientRequestId: 'fb-hidden' }));
    expect(hidden.code).toBe('support.kb.not_published');
    const hiddenVotes = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM support.kb_feedback WHERE article_id = 'kb-supportbe-gamma'`;
    expect(hiddenVotes[0]!.n).toBe(0);

    const vote = await voter.kbFeedback({ userId: OWNER, id: 'kb-supportbe-alpha', helpful: true, clientRequestId: 'fb-1' });
    expect(vote).toMatchObject({ articleId: 'kb-supportbe-alpha', version: 1, helpful: true });
    expect(vote.earlier).toBeUndefined();
    const repeat = await voter.kbFeedback({ userId: OWNER, id: 'kb-supportbe-alpha', helpful: false, clientRequestId: 'fb-2' });
    expect(repeat).toEqual({ ...vote, earlier: true });
    const replay = await voter.kbFeedback({ userId: OWNER, id: 'kb-supportbe-alpha', helpful: false, clientRequestId: 'fb-1' });
    expect(replay).toEqual(vote);
    const votes = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM support.kb_feedback WHERE article_id = 'kb-supportbe-alpha' AND user_id = ${OWNER}`;
    expect(votes[0]!.n).toBe(1);

    await expect(sql`UPDATE support.kb_article_versions SET category = 'rewritten' WHERE id = 'kb-supportbe-alpha'`).rejects.toMatchObject({
      code: '23514',
    });
    const still = await sql<
      { category: string }[]
    >`SELECT category FROM support.kb_article_versions WHERE id = 'kb-supportbe-alpha' AND version = 1`;
    expect(still[0]!.category).toBe('topic-a');
  });
});
