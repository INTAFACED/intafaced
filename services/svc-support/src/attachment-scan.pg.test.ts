import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAttachmentStore, type MalwareScanner, type ScanVerdict } from './attachments.js';
import { PostgresSupportStore } from './store.js';
import { SupportError, SupportService } from './support-service.js';

/**
 * SP-tickets-02 — scan state on Postgres: a file is `scanning` from its row, moves once, is read live on a replay, is
 * served only when clean, and a held file is scanned again. Per-run database as in kb-audience.pg.test.ts; the name ends
 * in _test and is never intafaced_test.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_attscan_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '55555555-5555-4555-8555-555555555555';

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

class Scanner implements MalwareScanner {
  constructor(public verdict: ScanVerdict) {}
  async scan(): Promise<ScanVerdict> {
    return this.verdict;
  }
}

const BODY = Buffer.from('hello').toString('base64');

function serviceWith(files: MemoryAttachmentStore, scanner: Scanner, store = new PostgresSupportStore(sql)) {
  return new SupportService(store, undefined, {
    store: files,
    scanner,
    maxBytes: 100,
    allowedTypes: ['text/plain'],
    maxCount: 2,
  });
}

const attach = (service: SupportService, ticketId: string, id: string) =>
  service.attach({ userId: OWNER, ticketId, clientRequestId: id, contentType: 'text/plain', bodyBase64: BODY });

describe('scan state on Postgres', () => {
  it('rows from before the column read clean, and the table refuses a state outside the three', async () => {
    const column = await sql<{ column_default: string }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'support' AND table_name = 'ticket_attachments' AND column_name = 'scan_state'
    `;
    expect(column[0]?.column_default).toContain('clean');
    const check = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ticket_attachments_scan_state_ck'
    `;
    expect(check[0]?.def).toMatch(/scanning.*clean.*blocked/s);
  });

  it('a clean file is clean in the row, served as a fixed-type download, and a replay does not scan or store again', async () => {
    const files = new MemoryAttachmentStore();
    const service = serviceWith(files, new Scanner('clean'));
    const ticket = await service.createTicket({ userId: OWNER, category: 'account', subject: 'Clean', body: 'One file' });
    const saved = await attach(service, ticket.id, 'scan-clean');
    expect(saved.scanState).toBe('clean');
    expect(await attach(service, ticket.id, 'scan-clean')).toEqual(saved);
    expect(files.puts).toBe(1);
    expect(await service.attachmentDownload({ userId: OWNER, attachmentId: saved.id })).toEqual({
      id: saved.id,
      contentType: 'application/octet-stream',
      disposition: 'attachment',
      byteLength: 5,
      bodyBase64: BODY,
    });
    await expect(service.attachmentDownload({ userId: OTHER, attachmentId: saved.id })).rejects.toMatchObject({
      code: 'support.not_found',
    });
  });

  it('infected is blocked and takes no place; a late clean answer does not change it', async () => {
    const files = new MemoryAttachmentStore();
    const store = new PostgresSupportStore(sql);
    const service = serviceWith(files, new Scanner('infected'), store);
    const ticket = await service.createTicket({ userId: OWNER, category: 'account', subject: 'Infected', body: 'Blocked' });
    await expect(attach(service, ticket.id, 'scan-bad')).rejects.toMatchObject({ code: 'support.attachment_scan_refused' });
    expect(files.puts).toBe(0);
    const [row] = await sql<{ id: string; scan_state: string }[]>`
      SELECT id, scan_state FROM support.ticket_attachments WHERE client_request_id = 'scan-bad'
    `;
    expect(row?.scan_state).toBe('blocked');
    expect(await store.setAttachmentScanState({ attachmentId: row!.id, state: 'clean' })).toMatchObject({ scanState: 'blocked' });
    await expect(service.attachmentDownload({ userId: OWNER, attachmentId: row!.id })).rejects.toMatchObject({
      code: 'support.attachment_scan_refused',
    });
    // Two places remain for good files: the blocked one holds none.
    const ok = serviceWith(files, new Scanner('clean'), store);
    await attach(ok, ticket.id, 'scan-good-1');
    await attach(ok, ticket.id, 'scan-good-2');
    await expect(attach(ok, ticket.id, 'scan-good-3')).rejects.toMatchObject({ code: 'support.attachment_count_reached' });
  });

  it('a crash between the bytes and the mark leaves a held file that the owner’s retry settles without a second row', async () => {
    const files = new MemoryAttachmentStore();
    const real = new PostgresSupportStore(sql);
    let crash = true;
    const crashing = Object.create(real) as PostgresSupportStore;
    crashing.setAttachmentScanState = async (input) => {
      if (crash) {
        crash = false;
        throw new Error('crashed before the mark');
      }
      return real.setAttachmentScanState(input);
    };
    const service = serviceWith(files, new Scanner('clean'), crashing);
    const ticket = await service.createTicket({ userId: OWNER, category: 'account', subject: 'Crash', body: 'Held' });
    await expect(attach(service, ticket.id, 'scan-crash')).rejects.toThrow('crashed before the mark');
    const [held] = await sql<{ id: string; scan_state: string }[]>`
      SELECT id, scan_state FROM support.ticket_attachments WHERE client_request_id = 'scan-crash'
    `;
    expect(held?.scan_state).toBe('scanning');
    await expect(service.attachmentDownload({ userId: OWNER, attachmentId: held!.id })).rejects.toMatchObject({
      code: 'support.attachment_scan_unknown',
    });
    const settled = await attach(service, ticket.id, 'scan-crash');
    expect(settled).toMatchObject({ id: held!.id, scanState: 'clean' });
    expect(await sql`SELECT 1 FROM support.ticket_attachments WHERE client_request_id = 'scan-crash'`).toHaveLength(1);
  });

  it('a pass scans held files again, oldest first, and leaves one whose bytes are missing held', async () => {
    const files = new MemoryAttachmentStore();
    const scanner = new Scanner('unknown');
    const service = serviceWith(files, scanner);
    const ticket = await service.createTicket({ userId: OWNER, category: 'account', subject: 'Pass', body: 'Rescan' });
    await expect(attach(service, ticket.id, 'scan-unknown')).rejects.toMatchObject({ code: 'support.attachment_scan_unknown' });
    expect(await service.rescanHeldAttachments(10)).toEqual({ clean: 0, blocked: 0, held: 1 });
    scanner.verdict = 'clean';
    expect(await service.rescanHeldAttachments(10)).toEqual({ clean: 1, blocked: 0, held: 0 });
    const [row] = await sql<{ scan_state: string }[]>`
      SELECT scan_state FROM support.ticket_attachments WHERE client_request_id = 'scan-unknown'
    `;
    expect(row?.scan_state).toBe('clean');
    expect(await new PostgresSupportStore(sql).listScanningAttachments(10)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ scanState: 'clean' })]),
    );
  });
});

describe('operator attach on Postgres', () => {
  const OPERATOR = '33333333-3333-4333-8333-333333333333';
  const upload = (service: SupportService, ticketId: string, id: string, operatorId = OPERATOR) =>
    service.attachAsOperator({ operatorId, ticketId, clientRequestId: id, contentType: 'text/plain', bodyBase64: BODY });

  it('stores the operator in uploaded_by, keeps the owner as owner, and replays under the operator’s own key', async () => {
    const files = new MemoryAttachmentStore();
    const service = serviceWith(files, new Scanner('clean'));
    const ticket = await service.createTicket({ userId: OWNER, category: 'account', subject: 'Agent file', body: 'Help' });
    await service.claimForOperator({ operatorId: OPERATOR, ticketId: ticket.id });
    const saved = await upload(service, ticket.id, 'agent-1');
    expect(saved).toMatchObject({ ownerId: OWNER, uploadedBy: OPERATOR, scanState: 'clean' });
    expect(await upload(service, ticket.id, 'agent-1')).toEqual(saved);
    expect(files.puts).toBe(1);
    const [row] = await sql<{ owner_id: string; uploaded_by: string | null }[]>`
      SELECT owner_id, uploaded_by FROM support.ticket_attachments WHERE id = ${saved.id}
    `;
    expect(row).toEqual({ owner_id: OWNER, uploaded_by: OPERATOR });
    const own = await attach(service, ticket.id, 'owner-1');
    expect(own.uploadedBy).toBeNull();
    // Both files count toward the one request limit.
    await expect(upload(service, ticket.id, 'agent-2')).rejects.toMatchObject({ code: 'support.attachment_count_reached' });
  });

  it('refuses an operator the ticket is not assigned to, and writes nothing', async () => {
    const files = new MemoryAttachmentStore();
    const service = serviceWith(files, new Scanner('clean'));
    const ticket = await service.createTicket({ userId: OWNER, category: 'account', subject: 'Not yours', body: 'Help' });
    await service.claimForOperator({ operatorId: OPERATOR, ticketId: ticket.id });
    await expect(upload(service, ticket.id, 'agent-x', '44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({
      code: 'support.not_found',
    });
    expect(files.puts).toBe(0);
    const rows = await sql`SELECT 1 FROM support.ticket_attachments WHERE client_request_id = 'agent-x'`;
    expect(rows).toHaveLength(0);
  });
});
