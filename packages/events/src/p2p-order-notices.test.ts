import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const uid = () => crypto.randomUUID();
const ts = () => new Date().toISOString();

describe('P-trade-orders-23 p2p order notice events', () => {
  it('bumps disputed, resolved and expired to version 2 with optional party ids', () => {
    for (const k of ['p2pTradeDisputed', 'p2pDisputeResolved', 'p2pTradeExpired'] as const) {
      expect(EVENT_CATALOG[k].version).toBe(2);
    }
    const buyerId = uid();
    const sellerId = uid();
    const exp = EVENT_CATALOG.p2pTradeExpired.schema.parse({
      tradeId: uid(),
      buyerId,
      sellerId,
      from: 'awaiting_payment',
      outcome: 'refunded',
    });
    expect(exp).toMatchObject({ buyerId, sellerId });
    // A version-1 shaped payload (no party ids) still parses while svc-p2p catches up.
    expect(EVENT_CATALOG.p2pTradeExpired.schema.safeParse({ tradeId: uid(), from: 'x', outcome: 'voided' }).success).toBe(true);
    expect(
      EVENT_CATALOG.p2pDisputeResolved.schema.safeParse({
        disputeId: uid(),
        tradeId: uid(),
        buyerId: 'not-a-uuid',
        moderatorId: uid(),
        resolution: 'release',
        automatic: false,
      }).success,
    ).toBe(false);
  });

  it('declares the four new subjects under the subject law', () => {
    expect(EVENT_CATALOG.p2pTradeFiatSent.subject).toBe('intafaced.p2p.trade_fiat.sent');
    expect(EVENT_CATALOG.p2pChatMessageSent.subject).toBe('intafaced.p2p.chat_message.sent');
    expect(EVENT_CATALOG.p2pDisputeEscalated.subject).toBe('intafaced.p2p.dispute.escalated');
    expect(EVENT_CATALOG.p2pQuoteExpired.subject).toBe('intafaced.p2p.quote.expired');
  });

  it('refuses payloads missing a recipient or carrying a non-uuid party', () => {
    expect(EVENT_CATALOG.p2pTradeFiatSent.schema.safeParse({ tradeId: uid(), buyerId: uid(), markedAt: ts() }).success).toBe(false);
    expect(
      EVENT_CATALOG.p2pChatMessageSent.schema.safeParse({
        tradeId: uid(),
        messageId: uid(),
        senderId: uid(),
        recipientId: 'bob',
        sentAt: ts(),
      }).success,
    ).toBe(false);
    expect(
      EVENT_CATALOG.p2pDisputeEscalated.schema.safeParse({
        disputeId: uid(),
        tradeId: uid(),
        buyerId: uid(),
        sellerId: uid(),
        escalatedBy: '',
        escalatedAt: ts(),
      }).success,
    ).toBe(false);
    expect(EVENT_CATALOG.p2pQuoteExpired.schema.safeParse({ quoteId: uid(), userId: uid(), expiredAt: 'yesterday' }).success).toBe(false);
  });

  it('carries no chat message text on the bus', () => {
    const parsed = EVENT_CATALOG.p2pChatMessageSent.schema.parse({
      tradeId: uid(),
      messageId: uid(),
      senderId: uid(),
      recipientId: uid(),
      sentAt: ts(),
      body: 'secret',
    });
    expect(parsed).not.toHaveProperty('body');
  });
});
