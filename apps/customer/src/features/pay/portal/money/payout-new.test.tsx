import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { ApiResult } from '../../../../shared/api';
import type { PortalApi } from '../api';
import type { Approval } from '../schemas';
import { mc } from './copy';
import { SaveReview, normaliseReference, referenceProblem } from './Destinations';
import { payoutProblem, submitPayout, type PayoutOutcome } from './PayoutNew';

// Everything here is TEST DATA written for these tests.
const t = mc.t;
const SETTLEMENT = { id: 'bb000002-0000-4000-8000-000000000002' };
const DEST = { railId: 'crypto-native' };
const approvalRow = (status: Approval['status']) => ({ approvalId: 'cc1', settlementId: SETTLEMENT.id, status }) as Approval;

function fakePortal(opts: { ask?: ApiResult<Approval>; sentStatus?: string }) {
  const sendPayout = vi.fn(async () => ({ ok: true as const, data: { id: SETTLEMENT.id, status: opts.sentStatus ?? 'paid_out' } }));
  const requestPayoutApproval = vi.fn(async () => opts.ask ?? { ok: true as const, data: approvalRow('pending') });
  return { portal: { sendPayout, requestPayoutApproval } as unknown as PortalApi, sendPayout, requestPayoutApproval };
}
const run = (portal: PortalApi, over: Partial<Parameters<typeof submitPayout>[0]> = {}) =>
  submitPayout({ portal, merchantId: 'm', t, settlement: SETTLEMENT, dest: DEST, sending: false, maySend: true, ...over });
const message = (r: ApiResult<PayoutOutcome>) => (r.ok ? null : r.message);

describe('asking for a payout', () => {
  it('goes to the team only when the service says the request is pending', async () => {
    const { portal, sendPayout } = fakePortal({ ask: { ok: true, data: approvalRow('pending') } });
    const out = await run(portal);
    expect(out).toEqual({ ok: true, data: { route: 'approval', id: SETTLEMENT.id } });
    expect(sendPayout).not.toHaveBeenCalled();
  });
  it('sends when the live request is approved', async () => {
    const { portal, sendPayout } = fakePortal({ ask: { ok: true, data: approvalRow('approved') } });
    const out = await run(portal);
    expect(sendPayout).toHaveBeenCalledOnce();
    expect(out).toEqual({ ok: true, data: { route: 'sent', id: SETTLEMENT.id, status: 'paid_out' } });
  });
  it.each(['expired', 'voided', 'rejected', 'consumed'] as const)(
    'refuses plainly, never "with your team", when the request is %s',
    async (status) => {
      const { portal, sendPayout } = fakePortal({ ask: { ok: true, data: approvalRow(status) } });
      const out = await run(portal);
      expect(out.ok).toBe(false);
      expect(sendPayout).not.toHaveBeenCalled();
      expect(message(out)).toContain('Ask again.');
      if (status === 'expired') expect(message(out)).toBe('That request has expired. Ask again.');
    },
  );
  it('sends directly below the approval limit', async () => {
    const { portal, sendPayout } = fakePortal({
      ask: { ok: false, reason: 'error', code: 'pay.approval_not_required', message: 'pay.approval_not_required' },
    });
    const out = await run(portal);
    expect(sendPayout).toHaveBeenCalledOnce();
    expect(out.ok && out.data.route).toBe('sent');
  });
  it('keeps the service refusal when it is any other', async () => {
    const refusal = { ok: false as const, reason: 'error' as const, code: 'pay.guard_halted', message: 'pay.guard_halted' };
    const { portal } = fakePortal({ ask: refusal });
    expect(await run(portal)).toEqual(refusal);
  });
  it('tells a person who cannot send who can, and never calls the send', async () => {
    const { portal, sendPayout } = fakePortal({ ask: { ok: true, data: approvalRow('approved') } });
    const out = await run(portal, { maySend: false });
    expect(sendPayout).not.toHaveBeenCalled();
    expect(message(out)).toBe('Only the account owner can send a payout. Ask them to send it.');
    const direct = fakePortal({});
    expect(message(await run(direct.portal, { maySend: false, sending: true }))).toContain('Only the account owner');
    expect(direct.requestPayoutApproval).not.toHaveBeenCalled();
  });
  it('carries the payout status out, so the page says "sent" only for a paid out one', async () => {
    const { portal } = fakePortal({ sentStatus: 'pending' });
    const out = await run(portal, { sending: true });
    expect(out.ok && out.data.route === 'sent' && out.data.status).toBe('pending');
  });
});

describe('what blocks the payout form', () => {
  const base = {
    allowed: true,
    settlement: SETTLEMENT,
    haltsRead: 'ready' as const,
    block: null,
    dest: DEST,
    sending: false,
    maySend: true,
  };
  it('is nothing when everything is read and fine', () => {
    expect(payoutProblem(t, base)).toBeNull();
  });
  it('blocks while the pause read is loading or failed, instead of treating it as no pause', () => {
    expect(payoutProblem(t, { ...base, haltsRead: 'loading' })).toContain('Checking whether payouts are paused');
    expect(payoutProblem(t, { ...base, haltsRead: 'failed' })).toContain('Couldn’t check payout pauses');
  });
  it('shows who can send, instead of a form that fails, when sending an approved payout as a non-owner', () => {
    expect(payoutProblem(t, { ...base, sending: true, maySend: false })).toBe(
      'Only the account owner can send a payout. Ask them to send it.',
    );
    // Asking for approval stays open to them.
    expect(payoutProblem(t, { ...base, sending: false, maySend: false })).toBeNull();
  });
});

describe('the done messages', () => {
  it('say "sent" only for a paid out payout and otherwise point to the status', () => {
    expect(t('pnDoneSent')).toBe('The payout has been sent.');
    expect(t('pnDoneCheck')).toContain('Check the payout status');
  });
});

describe('saving a destination', () => {
  it('shows the value that is sent: every space removed', () => {
    expect(normaliseReference(' 0x7a3f 1111\n2222 ')).toBe('0x7a3f11112222');
    // The shape check reads the same value that is sent: a pasted address with spaces passes, a short one does not.
    expect(referenceProblem('crypto', ` 0x${'a'.repeat(20)} ${'b'.repeat(20)} `)).toBeNull();
    expect(referenceProblem('crypto', '0x7a3f 4421')).toBe('crypto');
  });
  const out = (replaces: Parameters<typeof SaveReview>[0]['replaces']) =>
    renderToString(<SaveReview railId="crypto-native" kind="crypto" sentRef="0xabc" replaces={replaces} />);
  it('says what it replaces, and warns that waiting requests must be asked again', () => {
    const html = out({ kind: 'crypto', destinationMasked: '0x7a3f…4421', railId: 'crypto-native' });
    expect(html).toContain('Replaces');
    expect(html).toContain('0x7a3f…4421');
    expect(html).toContain('have to be asked for again');
  });
  it('says nothing about replacing when the network has no destination yet', () => {
    expect(out(null)).not.toContain('Replaces');
  });
  it('words the section for add or replace, and the manage line only across networks', () => {
    expect(t('dstAddTitle')).toBe('Add or replace a destination');
    expect(t('dstReplace')).toBe('Replace destination');
    expect(t('dstManageBody')).toContain('on more than one network');
    expect(t('dstManageBody')).not.toContain('pick another destination each time');
  });
});
