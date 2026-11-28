import { describe, expect, it } from 'vitest';
import {
  CHARGEBACK_LEDGER_SOCKET_ID,
  DisputeCaseError,
  isTerminalDisputeStatus,
  MemoryDisputeCaseStore,
  railOutcomeConflicts,
} from './dispute-case.js';

describe('D26-P1-P5 chargeback dispute case mechanism', () => {
  it('opens a case keyed by disputeId (not payment id) and refuse-closes ledger via named socket', () => {
    const store = new MemoryDisputeCaseStore();
    const a = store.open({
      disputeId: 'dsp-1',
      paymentId: 'pay-1',
      merchantId: 'mer-1',
      amount: '40.5',
      assetId: 'USDT',
      reasonCode: '4855',
      paymentMarkedDisputed: true,
    });
    expect(a.status).toBe('open');
    expect(a.ledgerWire).toBe('refused');
    const refused = a.ledgerRefuse;
    if (!refused) throw new Error('expected the refused chargeback ledger wire');
    expect(refused.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
    expect(refused.code).toBe('pay.chargeback_ledger_unwired');
    expect(a.paymentMarkedDisputed).toBe(true);
    // Second presentment is a different disputeId.
    const b = store.open({
      disputeId: 'dsp-2',
      paymentId: 'pay-1',
      merchantId: 'mer-1',
      amount: '10',
      assetId: 'USDT',
    });
    expect(store.listForPayment('pay-1')).toHaveLength(2);
    expect(b.disputeId).toBe('dsp-2');
  });

  it('supports contest → won without inventing a money post', () => {
    const store = new MemoryDisputeCaseStore();
    store.open({
      disputeId: 'dsp-w',
      paymentId: 'pay-1',
      merchantId: 'mer-1',
      amount: '12',
      assetId: 'USDT',
    });
    expect(store.contest('dsp-w').status).toBe('contested');
    const won = store.markWon('dsp-w');
    expect(won.status).toBe('won');
    expect(won.closedAt).toBeTruthy();
    expect(won.ledgerWire).toBe('refused');
    const refused = won.ledgerRefuse;
    if (!refused) throw new Error('expected the refused chargeback ledger wire');
    expect(refused.socket).toBe(CHARGEBACK_LEDGER_SOCKET_ID);
  });

  it('blank ledgerPost txId cannot claim posted', () => {
    const store = new MemoryDisputeCaseStore();
    const opened = store.open({
      disputeId: 'dsp-blank-tx',
      paymentId: 'p-blank',
      merchantId: 'm-blank',
      amount: '1',
      assetId: 'USDT',
      ledgerPost: { txId: '  ' },
    });
    expect(opened.ledgerWire).toBe('refused');
    expect(opened.ledgerTxId).toBeNull();
    expect(opened.ledgerRefuse?.code).toBe('pay.chargeback_ledger_unwired');
  });

  it('records the idempotent ledger transaction when the production wire posts', () => {
    const store = new MemoryDisputeCaseStore();
    const opened = store.open({
      disputeId: 'dsp-posted',
      paymentId: 'p-posted',
      merchantId: 'm-posted',
      amount: '12',
      assetId: 'USDT',
      ledgerPost: { txId: 'tx-chargeback-1' },
    });
    expect(opened.ledgerWire).toBe('posted');
    expect(opened.ledgerTxId).toBe('tx-chargeback-1');
    expect(opened.ledgerRefuse).toBeNull();
    expect(store.markWon('dsp-posted').ledgerTxId).toBe('tx-chargeback-1');
  });

  it('applies a rail outcome once per event id', () => {
    const store = new MemoryDisputeCaseStore();
    store.open({ disputeId: 'dsp-rail', paymentId: 'p', merchantId: 'm', amount: '1', assetId: 'USDT' });
    const won = store.applyRailResolution({ disputeId: 'dsp-rail', railEventId: 'rail:1', outcome: 'won' });
    expect(won?.status).toBe('won');
    const again = store.applyRailResolution({ disputeId: 'dsp-rail', railEventId: 'rail:1', outcome: 'won' });
    expect(again?.status).toBe('won');
    expect(again?.closedAt).toBe(won?.closedAt);
    expect(() => store.applyRailResolution({ disputeId: 'dsp-rail', railEventId: 'rail:2', outcome: 'lost' })).toThrow(DisputeCaseError);
    expect(store.applyRailResolution({ disputeId: 'missing', railEventId: 'rail:3', outcome: 'lost' })).toBeNull();
  });

  it('treats only a different close of an already-closed dispute as a conflicting outcome', () => {
    expect(isTerminalDisputeStatus('won')).toBe(true);
    expect(isTerminalDisputeStatus('lost')).toBe(true);
    expect(isTerminalDisputeStatus('accepted')).toBe(true);
    expect(isTerminalDisputeStatus('open')).toBe(false);
    expect(isTerminalDisputeStatus('contested')).toBe(false);
    expect(railOutcomeConflicts('won', 'lost')).toBe(true);
    expect(railOutcomeConflicts('won', 'closed')).toBe(true);
    expect(railOutcomeConflicts('lost', 'won')).toBe(true);
    expect(railOutcomeConflicts('accepted', 'won')).toBe(true);
    expect(railOutcomeConflicts('won', 'won')).toBe(false);
    expect(railOutcomeConflicts('accepted', 'closed')).toBe(false);
    expect(railOutcomeConflicts('open', 'lost')).toBe(false);
    expect(railOutcomeConflicts('contested', 'won')).toBe(false);
  });

  it('refuses invalid transitions and blank dispute ids', () => {
    const store = new MemoryDisputeCaseStore();
    expect(() =>
      store.open({
        disputeId: '  ',
        paymentId: 'p',
        merchantId: 'm',
        amount: '1',
        assetId: 'USDT',
      }),
    ).toThrowError(DisputeCaseError);
    store.open({
      disputeId: 'dsp-x',
      paymentId: 'p',
      merchantId: 'm',
      amount: '1',
      assetId: 'USDT',
    });
    store.accept('dsp-x');
    expect(() => store.contest('dsp-x')).toThrowError(/already accepted/);
  });

  it('module never imports chargeback ledger recipes (Class M park)', () => {
    // The case records what the ledger answered and never books an outcome itself: through every path a case can take,
    // its ledger fields stay as the opening left them, and a case opened without a tx id never claims one.
    const ledgerOf = (c: { ledgerWire: string; ledgerTxId: string | null; ledgerRefuse: unknown }) => ({
      ledgerWire: c.ledgerWire,
      ledgerTxId: c.ledgerTxId,
      ledgerRefuse: c.ledgerRefuse,
    });
    const paths: Array<[string, (store: MemoryDisputeCaseStore, id: string) => unknown]> = [
      ['contest then won', (store, id) => (store.contest(id), store.markWon(id))],
      ['contest then lost', (store, id) => (store.contest(id), store.markLost(id))],
      ['accept', (store, id) => store.accept(id)],
      ['rail won', (store, id) => store.applyRailResolution({ disputeId: id, railEventId: `evt-${id}`, outcome: 'won' })],
      ['rail lost', (store, id) => store.applyRailResolution({ disputeId: id, railEventId: `evt-${id}`, outcome: 'lost' })],
      ['rail closed', (store, id) => store.applyRailResolution({ disputeId: id, railEventId: `evt-${id}`, outcome: 'closed' })],
    ];
    for (const [name, walk] of paths) {
      for (const ledgerPost of [undefined, { txId: 'tx-opening-1' }]) {
        const store = new MemoryDisputeCaseStore();
        const id = `dsp-${name.replace(/ /g, '-')}`;
        const opened = store.open({
          disputeId: id,
          paymentId: 'p',
          merchantId: 'm',
          amount: '10',
          assetId: 'USDT',
          ...(ledgerPost ? { ledgerPost } : {}),
        });
        expect(ledgerOf(opened), name).toEqual(
          ledgerPost
            ? { ledgerWire: 'posted', ledgerTxId: 'tx-opening-1', ledgerRefuse: null }
            : { ledgerWire: 'refused', ledgerTxId: null, ledgerRefuse: expect.objectContaining({ socket: CHARGEBACK_LEDGER_SOCKET_ID }) },
        );
        walk(store, id);
        const after = store.get(id)!;
        expect(after.status, name).not.toBe('open');
        expect(ledgerOf(after), name).toEqual(ledgerOf(opened));
        expect(
          Object.keys(after).filter((key) => /tx/i.test(key)),
          name,
        ).toEqual(['ledgerTxId']);
      }
    }
  });
});
