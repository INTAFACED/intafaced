import { describe, expect, it } from 'vitest';
import { WORK_LIST_CAP_UNSET, type HomeConfig, type WorkItem } from '@intafaced/contracts/home-work-items';
import { HOME_CONFIG_FAILED, HOME_CONFIG_UNWIRED, ratioPercent, sourceAnswer, workList, type SourceRead } from './work-list';

const config = (over: Partial<HomeConfig> = {}) =>
  ({ state: 'ready', config: { workListCap: 5, workListOrder: null, searchResultCap: null, revision: 1, ...over } }) as const;

const verify: WorkItem = {
  id: 'verification:u1',
  kind: 'verification',
  source: 'identity',
  severity: 'action',
  titleKey: 'identity.verification.start',
  link: '/verification',
};
const card: WorkItem = {
  id: 'card_frozen:c1',
  kind: 'card_frozen',
  source: 'bank',
  severity: 'warning',
  titleKey: 'bank.card.frozen',
  link: '/bank/cards',
  reasonCode: 'card.frozen_by_owner',
};
const loan: WorkItem = {
  id: 'loan_payment_due:l1',
  kind: 'loan_payment_due',
  source: 'bank',
  severity: 'action',
  titleKey: 'bank.loan.payment_due',
  link: '/bank/loans',
  dueAt: '2026-11-01T00:00:00Z',
  amount: { value: '12.50', asset: 'USDT' },
};
const payout: WorkItem = {
  id: 'payout_waiting:p1',
  kind: 'payout_waiting',
  source: 'pay',
  severity: 'info',
  titleKey: 'pay.payout.waiting',
  link: '/pay/payouts',
};

const ready = (...items: WorkItem[]): SourceRead => ({ state: 'ready', items });
const all = (identity: SourceRead, bank: SourceRead, pay: SourceRead) => ({ identity, bank, pay });

describe('Home work list (HM-dashboard-03)', () => {
  it('is refused, with its code, while the owner values are blank or unreadable', () => {
    const sources = all(ready(verify), ready(), ready());
    expect(workList(config({ workListCap: null }), sources)).toEqual({ state: 'refused', code: WORK_LIST_CAP_UNSET });
    expect(workList({ state: 'unwired' }, sources)).toEqual({ state: 'refused', code: HOME_CONFIG_UNWIRED });
    expect(workList({ state: 'failed' }, sources)).toEqual({ state: 'refused', code: HOME_CONFIG_FAILED });
    expect(workList({ state: 'failed', code: 'ops.home_config_denied' }, sources)).toEqual({
      state: 'refused',
      code: 'ops.home_config_denied',
    });
    expect(workList({ state: 'loading' }, sources)).toEqual({ state: 'loading' });
  });

  it('waits for every owner rather than showing a list that reshuffles', () => {
    expect(workList(config(), all(ready(verify), { state: 'loading' }, ready()))).toEqual({ state: 'loading' });
  });

  it('keeps the owners’ order while the owner has not set one, and says so', () => {
    const list = workList(config(), all(ready(verify), ready(card, loan), ready(payout)));
    expect(list).toMatchObject({ state: 'ready', ordered: false, more: 0, missing: [] });
    expect(list.state === 'ready' && list.items.map((item) => item.id)).toEqual([verify.id, card.id, loan.id, payout.id]);
  });

  it('follows the owner’s order by kind, keeps each owner’s order within a kind, and puts unlisted kinds last', () => {
    const list = workList(
      config({ workListOrder: ['payout_waiting', 'loan_payment_due', 'verification'] }),
      all(ready(verify), ready(card, loan), ready(payout)),
    );
    expect(list.state === 'ready' && list.items.map((item) => item.kind)).toEqual([
      'payout_waiting',
      'loan_payment_due',
      'verification',
      'card_frozen',
    ]);
    expect(list).toMatchObject({ ordered: true });
  });

  it('shows at most the owner’s cap and counts the rest', () => {
    const list = workList(config({ workListCap: 2 }), all(ready(verify), ready(card, loan), ready(payout)));
    expect(list).toMatchObject({ state: 'ready', more: 2 });
    expect(list.state === 'ready' && list.items).toHaveLength(2);
  });

  it('names every owner that has not answered, so an empty list never claims nothing needs the person', () => {
    const list = workList(config(), all(ready(), { state: 'unwired' }, { state: 'failed', code: 'pay.denied' }));
    expect(list).toEqual({
      state: 'ready',
      items: [],
      more: 0,
      ordered: false,
      missing: [
        { source: 'bank', state: 'unwired' },
        { source: 'pay', state: 'failed', code: 'pay.denied' },
      ],
    });
    expect(workList(config(), all(ready(), ready(), ready()))).toMatchObject({ items: [], missing: [] });
  });

  it("takes an owner's verify-first refusal as covered by identity's verification item, and only then", () => {
    const verifyFirst: SourceRead = { state: 'failed', code: 'denied.kyc_required', status: 403 };
    expect(workList(config(), all(ready(verify), verifyFirst, verifyFirst))).toMatchObject({ items: [verify], missing: [] });
    // Without the verification item a verify-first refusal is still a source Home could not check.
    expect(workList(config(), all(ready(), verifyFirst, ready()))).toMatchObject({
      items: [],
      missing: [{ source: 'bank', state: 'failed', code: 'denied.kyc_required' }],
    });
    // A KYC-sounding code on an outage is not a verify-first answer.
    expect(
      workList(config(), all(ready(verify), { state: 'failed', code: 'kyc.provider_unavailable', status: 503 }, ready())),
    ).toMatchObject({ missing: [{ source: 'bank', state: 'failed', code: 'kyc.provider_unavailable' }] });
    // Any other refusal stays named, verification item or not.
    expect(workList(config(), all(ready(verify), { state: 'failed', code: 'bank.unavailable' }, ready()))).toMatchObject({
      missing: [{ source: 'bank', state: 'failed', code: 'bank.unavailable' }],
    });
  });

  it('drops an owner’s whole answer when it is not the contract or names another owner’s kind', () => {
    expect(sourceAnswer('identity', { items: [verify] })).toEqual({ state: 'ready', items: [verify] });
    expect(sourceAnswer('identity', { items: [card] })).toEqual({ state: 'failed', code: 'home.work_items_invalid' });
    expect(sourceAnswer('bank', { items: [{ ...card, link: '/pay/x' }] })).toMatchObject({ state: 'failed' });
    expect(sourceAnswer('bank', { items: [card, card] })).toMatchObject({ state: 'failed' });
    expect(sourceAnswer('pay', { items: [{ ...payout, amount: { value: 12.5, asset: 'USDT' } }] })).toMatchObject({ state: 'failed' });
    expect(sourceAnswer('pay', null)).toMatchObject({ state: 'failed' });
  });
});

describe('the loan-to-value a margin row shows', () => {
  it.each([
    ['0.85', '85%'],
    ['0.8512', '85.12%'],
    ['1', '100%'],
    ['1.2', '120%'],
    ['0.05', '5%'],
    ['0.005', '0.5%'],
    ['0', '0%'],
  ])('reads %s as %s, digit for digit', (ratio, shown) => {
    expect(ratioPercent(ratio)).toBe(shown);
  });
});
