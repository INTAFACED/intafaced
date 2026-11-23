import { expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { LedgerClient } from '@intafaced/ledger-client';
import { BillPayService, type BillView } from './bills.js';
import { personalPayError } from './errors.js';
import type { SpaceService } from '../spaces/space-service.js';
import type { BillPorts } from './ports.js';

it('retries the final recurring bill after an unknown rail outcome', async () => {
  const start = new Date('2026-11-01T00:00:00Z');
  const schedule = {
    id: '51111111-1111-4111-8111-111111111111',
    user_id: 'alice',
    biller_id: 'water',
    reference: 'invoice',
    amount: '10',
    from_space_id: 'main',
    cadence: 'weekly',
    starts_at: start,
    ends_at: new Date('2026-11-02T00:00:00Z'),
    next_run_at: start,
    status: 'active',
  };
  const handle = async (parts: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const query = parts.join('?');
    if (query.includes('FROM bank.bill_recurring_firings')) return [];
    if (query.includes('FROM bank.bill_recurring')) {
      return schedule.status === 'active' && schedule.next_run_at <= new Date(String(values[0])) ? [schedule] : [];
    }
    if (query.includes('INSERT INTO bank.bill_recurring_firings')) return [];
    if (query.includes('UPDATE bank.bill_recurring')) {
      [schedule.next_run_at, schedule.status] = [new Date(String(values[0])), String(values[1])];
      return [];
    }
    throw new Error(query);
  };
  const sql = handle as Sql;
  const bills = new BillPayService(sql, {} as LedgerClient, {} as SpaceService, {} as BillPorts);
  const pay = vi
    .spyOn(bills, 'pay')
    .mockRejectedValueOnce(personalPayError('bank.bills_outcome_unknown'))
    .mockResolvedValue({ id: 'paid-bill', status: 'paid' } as BillView);
  const first = await bills.runDue(10, start);
  expect(first.failures[0]?.code).toBe('bank.bills_outcome_unknown');
  const second = await bills.runDue(10, new Date('2026-11-03T00:00:00Z'));
  expect(second.settled).toBe(1);
  expect(pay.mock.calls.map(([ask]) => ask.idempotencyKey)).toEqual([`bill-recur:${schedule.id}:0`, `bill-recur:${schedule.id}:0`]);
});
