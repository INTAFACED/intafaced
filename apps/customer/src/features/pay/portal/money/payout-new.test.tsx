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
import { conversionRequestScope } from './Conversion';
import { useRequestId } from '../payments/invoice-model';
import { SaveReview, normaliseReference, referenceProblem, saveBlock } from './Destinations';
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
  it.each(['expired', 'voided', 'rejected'] as const)('refuses plainly, never "with your team", when the request is %s', async (status) => {
    const { portal, sendPayout } = fakePortal({ ask: { ok: true, data: approvalRow(status) } });
    const out = await run(portal);
    expect(out.ok).toBe(false);
    expect(sendPayout).not.toHaveBeenCalled();
    expect(message(out)).toContain('Ask again.');
    if (status === 'expired') expect(message(out)).toBe('That request has expired. Ask again.');
  });
  it('says the payout already went, and opens it, when the request was already used', async () => {
    const { portal, sendPayout } = fakePortal({ ask: { ok: true, data: approvalRow('consumed') } });
    const out = await run(portal);
    expect(sendPayout).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, data: { route: 'used', id: SETTLEMENT.id } });
    expect(t('pnDoneUsed')).toContain('already used to send this payout');
    expect(t('pnDoneUsed')).not.toContain('Ask again');
  });
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
  it('says money still clearing in plain words, keeps the service code, and never sends (RC-merchant-10)', async () => {
    const refusal = {
      ok: false as const,
      reason: 'error' as const,
      code: 'pay.payout_clearing_pending',
      message: 'Settlement bb000002 is still clearing: 40.00 USDT the rail has not made available yet, so there is nothing to pay out',
    };
    const { portal, sendPayout } = fakePortal({ ask: refusal });
    const out = await run(portal);
    expect(sendPayout).not.toHaveBeenCalled();
    expect(out).toEqual({ ...refusal, message: t('rClearingPending') });
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
  it('neither asks nor sends when the person cannot begin a payout (asking is a payout step too)', async () => {
    const why = 'Only the account owner can send payouts.';
    const asking = fakePortal({});
    expect(message(await run(asking.portal, { stepReason: why }))).toBe(why);
    expect(asking.requestPayoutApproval).not.toHaveBeenCalled();
    const sending = fakePortal({});
    expect(message(await run(sending.portal, { sending: true, stepReason: why }))).toBe(why);
    expect(sending.sendPayout).not.toHaveBeenCalled();
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
    expect(payoutProblem(t, { ...base, stepReason: 'Only the account owner can send payouts.' })).toBe(
      'Only the account owner can send payouts.',
    );
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

describe('saving a destination waits for the saved list', () => {
  const ready = { owner: true, listState: 'ready' as const, hasRail: true, problem: null };
  it('turns Save off, with a plain reason, while the list is loading or failed', () => {
    expect(saveBlock({ ...ready, listState: 'loading' })).toBe('dstListLoading');
    expect(saveBlock({ ...ready, listState: 'failed' })).toBe('dstListFailed');
    expect(t('dstListLoading')).toContain('still loading');
    expect(t('dstListFailed')).toContain('did not load');
  });
  it('leaves Save on once the list is read and the form is complete', () => {
    expect(saveBlock(ready)).toBeNull();
  });
  it('keeps the older reasons in their order', () => {
    expect(saveBlock({ ...ready, owner: false, listState: 'loading' })).toBe('dstOwnerOnly');
    expect(saveBlock({ ...ready, hasRail: false })).toBe('dstPickRail');
    expect(saveBlock({ ...ready, problem: 'crypto' })).toBe('dstRefCrypto');
  });
});

describe('a conversion keeps its request id across a reload', () => {
  const SETTLEMENT_ID = 'bb000002-0000-4000-8000-000000000002';
  function withStorage<T>(run: (values: Map<string, string>) => T): T {
    const values = new Map<string, string>();
    const store = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k),
    };
    vi.stubGlobal('sessionStorage', store);
    try {
      return run(values);
    } finally {
      vi.unstubAllGlobals();
    }
  }
  function Probe({ onId }: { onId: (id: { id: string; renew: () => void }) => void }) {
    onId(useRequestId(conversionRequestScope(SETTLEMENT_ID)));
    return null;
  }
  const mount = () => {
    let seen: { id: string; renew: () => void } | null = null;
    renderToString(<Probe onId={(v) => (seen = v)} />);
    return seen!;
  };
  it('sends the same id after a reload until the outcome is confirmed, then a fresh one', () => {
    withStorage((values) => {
      const first = mount();
      const reloaded = mount();
      expect(reloaded.id).toBe(first.id);
      // The key names the settlement only: no amount or address.
      expect([...values.keys()]).toEqual([`portal:request:conversion:${SETTLEMENT_ID}`]);
      reloaded.renew();
      expect(mount().id).not.toBe(first.id);
    });
  });
  it('keeps ids apart per settlement', () => {
    expect(conversionRequestScope('a')).not.toBe(conversionRequestScope('b'));
    expect(conversionRequestScope(null)).toBe('conversion:none');
  });
});
