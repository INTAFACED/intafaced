import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAttachmentStore, MemoryMalwareScanner } from './attachments.js';
import { AttachmentSettingsStaleError, SqlAttachmentSettingsBook } from './attachment-settings.js';
import { PostgresSupportStore } from './store.js';
import { SupportError, SupportService } from './support-service.js';

/**
 * SP-tickets-02 — the attachment limits book and the per-request file count against Postgres: one row, a business-keyed
 * append-only log, a revision check under a race, and a count that holds when two files race for the last place. Per-run
 * database as in kb-audience.pg.test.ts; the name ends in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_attset_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
const OWNER = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-20T14:00:00.000Z';

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 8, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  for (const f of files) await sql.unsafe(readFileSync(join(migrationsDir, f), 'utf8'));
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

const change = (over: Record<string, unknown> = {}) => ({
  changes: { maxBytes: 100 },
  expectedRevision: 0,
  by: 'lead-1',
  reason: 'Owner set the largest file',
  at: AT,
  ...over,
});

describe('SqlAttachmentSettingsBook', () => {
  it('reads blank before the owner sets anything, and a read writes nothing', async () => {
    const book = new SqlAttachmentSettingsBook(sql);
    expect(await book.get()).toEqual({ maxBytes: null, allowedTypes: null, maxCount: null, revision: 0, updatedAt: null });
    expect(await sql`SELECT 1 FROM support.attachment_settings`).toHaveLength(0);
  });

  it('sets, logs under the business key, replays a lost reply, and refuses a stale revision', async () => {
    const book = new SqlAttachmentSettingsBook(sql);
    const first = await book.set(change());
    expect(first).toMatchObject({ maxBytes: 100, allowedTypes: null, revision: 1, updatedAt: AT });
    expect(await book.set(change())).toEqual(first);
    await expect(book.set(change({ changes: { maxBytes: 200 } }))).rejects.toBeInstanceOf(AttachmentSettingsStaleError);
    const second = await book.set(change({ changes: { allowedTypes: ['text/plain', 'image/png'], maxCount: 3 }, expectedRevision: 1 }));
    expect(second).toMatchObject({ maxBytes: 100, allowedTypes: ['text/plain', 'image/png'], maxCount: 3, revision: 2 });
    const cleared = await book.set(change({ changes: { allowedTypes: null }, expectedRevision: 2 }));
    expect(cleared).toMatchObject({ allowedTypes: null, revision: 3 });
    const log = await sql<{ key: string; revision_after: number }[]>`
      SELECT key, revision_after FROM support.attachment_settings_log ORDER BY revision_after
    `;
    expect(log.map((r) => r.key)).toEqual([
      'support.attachment_settings:r0',
      'support.attachment_settings:r1',
      'support.attachment_settings:r2',
    ]);
  });

  it('the log refuses update and delete, and the table refuses a value the contract would refuse', async () => {
    await expect(sql`UPDATE support.attachment_settings_log SET reason = 'x'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM support.attachment_settings_log`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE support.attachment_settings SET max_bytes = 0`).rejects.toThrow();
    await expect(sql`UPDATE support.attachment_settings SET max_count = 0`).rejects.toThrow();
    await expect(sql`UPDATE support.attachment_settings SET allowed_types = '{}'`).rejects.toThrow();
    await expect(sql`INSERT INTO support.attachment_settings (singleton) VALUES (false)`).rejects.toThrow();
  });

  it('two writers from the same revision: one wins, the other is refused and nothing is lost', async () => {
    const book = new SqlAttachmentSettingsBook(sql);
    const at = (await book.get()).revision;
    const results = await Promise.allSettled([
      book.set(change({ expectedRevision: at, changes: { maxCount: 7 } })),
      book.set(change({ expectedRevision: at, changes: { maxBytes: 999 } })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await book.get()).revision).toBe(at + 1);
  });
});

describe('the file count on Postgres', () => {
  it('two files racing for the last place: one is stored, the other is refused', async () => {
    const files = new MemoryAttachmentStore();
    const service = new SupportService(new PostgresSupportStore(sql), undefined, {
      store: files,
      scanner: new MemoryMalwareScanner('clean'),
      maxBytes: 100,
      allowedTypes: ['text/plain'],
      maxCount: 1,
    });
    const ticket = await service.createTicket({ userId: OWNER, category: 'account', subject: 'Race', body: 'Two files' });
    const body = Buffer.from('hello').toString('base64');
    const results = await Promise.allSettled(
      ['race-1', 'race-2'].map((clientRequestId) =>
        service.attach({ userId: OWNER, ticketId: ticket.id, clientRequestId, contentType: 'text/plain', bodyBase64: body }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SupportError);
    expect((rejected.reason as SupportError).code).toBe('support.attachment_count_reached');
    expect(files.puts).toBe(1);
    expect(await sql`SELECT 1 FROM support.ticket_attachments WHERE ticket_id = ${ticket.id}`).toHaveLength(1);
  });
});
