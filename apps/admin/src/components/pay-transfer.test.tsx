import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecordView } from './pay-transfer';
import { TransferLookup } from './pay-transfer';
import { PAY_TRANSFER_DETAIL } from '@/lib/ops-desk/catalog';
import { readData } from '@/lib/ops-desk/model';
import type { OwnFetch } from '@/lib/ops-desk/own-server';

const AT = '2026-10-18T03:00:00.000Z';
const html = (result: OwnFetch) => renderToStaticMarkup(<RecordView result={result} />);
const fail = (status: number | null): OwnFetch => ({ ok: false, status, code: null });

describe('the transfer record view', () => {
  it('401: tells the founder to sign in again, not that the server is unreachable', () => {
    const out = html(fail(401));
    expect(out).toContain('Your founder session has ended; sign in again');
    expect(out).not.toContain('could not reach');
  });
  it('400: says it is not a transfer id this desk can look up', () => {
    expect(html(fail(400))).toContain('That isn’t a transfer id this desk can look up');
  });
  it('404: says the desk is switched off', () => {
    expect(html(fail(404))).toContain('This desk is switched off');
  });
  it('500 and no reply: say the console could not reach its own server', () => {
    expect(html(fail(500))).toContain('could not reach its own server');
    expect(html(fail(null))).toContain('could not reach its own server');
  });
  it('a service refusal keeps its sentence and code', () => {
    const out = html({
      ok: true,
      outcome: {
        id: 'x',
        asOf: AT,
        part: {
          kind: 'failed',
          message: 'No such transfer, in words.',
          code: 'bank.ops_transfer_not_found',
          notBuilt: false,
          forbidden: false,
        },
      },
    });
    expect(out).toContain('No such transfer, in words.');
    expect(out).toContain('Code: bank.ops_transfer_not_found');
  });
  it('a record shows its fields with the time it was read', () => {
    const data = readData(PAY_TRANSFER_DETAIL, {
      id: '5a3b9c10-1111-4222-8333-444455556666',
      kind: 'one_off',
      senderUserId: 'u1',
      receiverUserId: 'u2',
      amount: '5',
      assetId: 'USDC',
      status: 'posted',
      rejectionCode: null,
      reason: null,
      ledgerTxId: 'tx-1',
      scheduleId: null,
      occurrence: null,
      attemptedAt: AT,
      settledAt: null,
    })!;
    const out = html({ ok: true, outcome: { id: 'pay.transfer-detail', asOf: AT, part: { kind: 'ok', data } } });
    expect(out).toContain('One-off send');
    expect(out).toContain('As of 03:00:00 UTC');
  });
});

describe('the lookup box', () => {
  it('asks for an id of 8 to 64 characters before it will look', () => {
    const out = renderToStaticMarkup(<TransferLookup />);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Find this transfer<\/button>/);
    expect(out).toContain('8 to 64 characters');
  });
});
