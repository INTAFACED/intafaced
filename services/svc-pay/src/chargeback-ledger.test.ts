import { describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  insuranceFund,
  merchantClearing,
  merchantProceeds,
  parseAmount as amt,
  recipes,
  railBoundary,
} from '@intafaced/ledger-client';
import {
  chargebackKeys,
  disputeOpeningKey,
  disputeShortfallKey,
  disputeShortfallRecoveredKey,
  disputeWonKey,
  postDisputeOpening,
  postDisputeShortfall,
  postDisputeShortfallRecovered,
  postDisputeWon,
} from './chargeback-ledger.js';
import { MemoryDisputeCaseStore } from './fraud/dispute-case.js';
import { CHARGEBACK_LEDGER_REFUSE_CODE, CHARGEBACK_LEDGER_UNCOVERED_CODE } from './fraud/chargeback-ledger-socket.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';

const MERCHANT = '33333333-3333-4333-8333-333333333333';
const MERCHANT_USER = '44444444-4444-4444-8444-444444444444';
const PAYMENT = 'pay-cb-1';
const RAIL = 'card-sandbox';

describe('postDisputeOpening — ledger-client only', () => {
  it('posts chargebackOpen and does not invent shortfall', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.paymentCapture({
        paymentId: PAYMENT,
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('40.50'),
        rail: RAIL,
        railRef: `ch_${PAYMENT}`,
      }),
    );

    const { txId } = await postDisputeOpening(ledger, {
      disputeId: 'dsp-1',
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      rail: RAIL,
      fromClearing: amt('40.50'),
      fromMerchantBalance: amt('0'),
    });

    expect(txId.length).toBeGreaterThan(0);
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(railBoundary(RAIL, 'USDT'))).amount)).toBe('0');
    expect(ledger.journal().map((t) => t.reason)).toContain('pay.chargeback.opened');
    expect(ledger.journal().some((t) => t.reason.includes('shortfall'))).toBe(false);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('pins lookup keys to the recipes and posts shortfall then won recovery once', async () => {
    const ledger = new MemoryLedger();
    const open = {
      disputeId: 'dsp-keys',
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      merchantUserId: MERCHANT_USER,
      assetId: 'USDT',
      rail: RAIL,
      fromClearing: amt('10'),
      fromMerchantBalance: amt('0'),
    };
    const short = {
      disputeId: 'dsp-keys',
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      assetId: 'USDT',
      rail: RAIL,
      amount: amt('5'),
    };
    expect(chargebackKeys('dsp-keys')).toEqual({
      open: disputeOpeningKey(open),
      shortfall: disputeShortfallKey(short),
      won: disputeWonKey(open),
      recovered: disputeShortfallRecoveredKey(short),
    });
    await ledger.post(
      recipes.paymentCapture({
        paymentId: PAYMENT,
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('10'),
        rail: RAIL,
        railRef: `ch_${PAYMENT}`,
      }),
    );
    await ledger.post({
      idempotencyKey: 'test.insurance.seed:dsp-keys',
      module: 'pay',
      reason: 'test.insurance.funded',
      entries: [
        { account: railBoundary('test-seed', 'USDT'), direction: 'credit', amount: amt('5') },
        { account: insuranceFund('USDT'), direction: 'debit', amount: amt('5') },
      ],
    });
    await postDisputeOpening(ledger, open);
    await postDisputeShortfall(ledger, short);
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('0');
    await postDisputeShortfallRecovered(ledger, short);
    await postDisputeWon(ledger, open);
    const again = await postDisputeWon(ledger, open);
    expect(again.txId).toBe((await ledger.getTxByKey(disputeWonKey(open)))?.id);
    expect(formatAmount((await ledger.balance(merchantClearing(MERCHANT, 'USDT'))).amount)).toBe('10');
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('5');
    expect(formatAmount((await ledger.balance(merchantProceeds(MERCHANT, 'USDT'))).amount)).toBe('0');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.won')).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a blank txId cannot mark the case posted', () => {
    const store = new MemoryDisputeCaseStore();
    const opened = store.open({
      disputeId: 'dsp-blank',
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      amount: '1',
      assetId: 'USDT',
      ledgerPost: { txId: '   ' },
    });
    expect(opened.ledgerWire).toBe('refused');
    expect(opened.ledgerTxId).toBeNull();
    expect(opened.ledgerRefuse?.code).toBe(CHARGEBACK_LEDGER_REFUSE_CODE);
  });

  it('card-sandbox parses dispute.opened with disputeId (HTTP door)', () => {
    const rail = new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 });
    const req = rail.signWebhook({
      id: 'evt_dsp',
      type: 'dispute.opened',
      ref: 'ch_1',
      amount: '10',
      assetId: 'USDT',
      disputeId: 'dsp-parse',
      reasonCode: '4855',
    });
    const event = rail.verifyWebhook(req);
    expect(event?.type).toBe('dispute.opened');
    expect(event?.disputeId).toBe('dsp-parse');
    expect(event?.reasonCode).toBe('4855');
    expect(event?.evidenceDueBy).toBeUndefined();
    expect(formatAmount(event?.amount ?? 0n)).toBe('10');
  });

  it('card-sandbox keeps a rail evidence due date and treats a malformed one as absent', () => {
    const noted: string[] = [];
    const rail = new CardSandboxAdapter({
      secret: 'svc-pay-test-secret-at-least-32-characters',
      toleranceSeconds: 300,
      noteMalformedEvidenceDueBy: (eventId) => noted.push(eventId),
    });
    const due = '2026-11-01T15:04:05.000Z';
    const event = rail.verifyWebhook(
      rail.signWebhook({
        id: 'evt_due',
        type: 'dispute.opened',
        ref: 'ch_1',
        amount: '10',
        assetId: 'USDT',
        disputeId: 'dsp-due',
        evidenceDueBy: due,
      }),
    );
    expect(event?.evidenceDueBy?.toISOString()).toBe(due);
    expect(event?.type).toBe('dispute.opened');
    const bad = rail.verifyWebhook(
      rail.signWebhook({
        id: 'evt_bad_due',
        type: 'dispute.opened',
        ref: 'ch_1',
        amount: '10',
        disputeId: 'dsp-bad',
        evidenceDueBy: 'not-a-date',
      }),
    );
    expect(bad?.type).toBe('dispute.opened');
    expect(bad?.disputeId).toBe('dsp-bad');
    expect(bad?.evidenceDueBy).toBeUndefined();
    const numeric = rail.verifyWebhook(
      rail.signWebhook({
        id: 'evt_num_due',
        type: 'dispute.opened',
        ref: 'ch_1',
        amount: '10',
        disputeId: 'dsp-num',
        evidenceDueBy: 30,
      }),
    );
    expect(numeric?.type).toBe('dispute.opened');
    expect(numeric?.evidenceDueBy).toBeUndefined();
    expect(noted).toEqual(['evt_bad_due', 'evt_num_due']);
  });

  it('cover-fail refuse uses the uncovered code, not posted', () => {
    const store = new MemoryDisputeCaseStore();
    const opened = store.open({
      disputeId: 'dsp-uncovered',
      paymentId: PAYMENT,
      merchantId: MERCHANT,
      amount: '1',
      assetId: 'USDT',
      ledgerRefuse: {
        code: CHARGEBACK_LEDGER_UNCOVERED_CODE,
        socket: 'socket.pay-chargeback-ledger-wire',
        message: 'uncovered',
        disputeId: 'dsp-uncovered',
        paymentId: PAYMENT,
      },
    });
    expect(opened.ledgerWire).toBe('refused');
    expect(opened.ledgerRefuse?.code).toBe(CHARGEBACK_LEDGER_UNCOVERED_CODE);
  });
});
