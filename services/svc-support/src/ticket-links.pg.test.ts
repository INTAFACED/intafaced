import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { SqlLinkBook, TicketLinks } from './ticket-links.js';
import type { TicketOrderReadResult, TicketOrderSource } from './ticket-order.js';

/**
 * J-support-public-20 #1 on Postgres, through the wiring index.ts uses: links kept in support.ticket_links (SqlLinkBook),
 * the queue reading them through `useRecoveryLinks`, and each linked order's hold read live. A request linked to an
 * unresolved order ranks above a withdrawal request of the same age; a resolved one, and a closed request, do not.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_links_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;
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

const ORDER = 'aaaaaaaa-0000-4000-8000-0000000000c1';

describe('ticket links and the queue on Postgres', () => {
  it('ranks a request linked to an unresolved order first, read live, and keeps a link once', async () => {
    const service = new SupportService(new PostgresSupportStore(sql));
    let status = 'recovery_required';
    const orders: TicketOrderSource = {
      async read(orderId): Promise<TicketOrderReadResult> {
        return {
          kind: 'order',
          order: {
            orderId,
            userId: OWNER,
            status,
            symbol: 'BTC/USDT',
            side: 'buy',
            filledQuantity: '0',
            feeAsset: 'USDT',
            feeAmount: '0',
          } as never,
        };
      },
    };
    const links = new TicketLinks(new SqlLinkBook(sql), service, orders, null);
    service.useRecoveryLinks(() => links.recoveryTickets());

    const withdrawal = await service.createTicket({
      userId: OTHER,
      category: 'deposit_withdraw',
      subject: 'TEST withdrawal',
      body: 'TEST missing',
    });
    const stuck = await service.createTicket({ userId: OWNER, category: 'trading', subject: 'TEST order stuck', body: 'TEST hold' });
    // Same age, so only the link can change their order.
    await sql`UPDATE support.tickets SET created_at = '2026-11-09T09:00:00Z' WHERE id IN (${withdrawal.id}, ${stuck.id})`;
    const order = async () => {
      const queue = await service.listOperatorQueue({ limit: 50 });
      if (queue.status !== 'ok') throw new Error('the queue answered empty');
      return queue.entries.map((e) => e.ticketId).filter((id) => id === withdrawal.id || id === stuck.id);
    };
    expect(await order()).toEqual([withdrawal.id, stuck.id]);

    const first = await links.link('op-1', { ticketId: stuck.id, kind: 'order', recordId: ORDER });
    expect(await links.link('op-1', { ticketId: stuck.id, kind: 'order', recordId: ORDER })).toEqual(first);
    expect(await sql`SELECT 1 FROM support.ticket_links WHERE ticket_id = ${stuck.id}`).toHaveLength(1);
    expect(await order()).toEqual([stuck.id, withdrawal.id]);

    // The hold resolves: the request drops back, though the link row still says recovery_required.
    status = 'filled';
    expect(await order()).toEqual([withdrawal.id, stuck.id]);
    status = 'hold_unknown';
    expect(await order()).toEqual([stuck.id, withdrawal.id]);

    // A closed request's links are not read, and the link row refuses an edit.
    await sql`UPDATE support.tickets SET status = 'closed' WHERE id = ${stuck.id}`;
    expect(await links.recoveryTickets()).toEqual(new Set());
    await expect(sql`UPDATE support.ticket_links SET recovery_required = false WHERE ticket_id = ${stuck.id}`).rejects.toThrow(
      /append-only/,
    );
  });
});
