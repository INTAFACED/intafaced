import { describe, expect, it } from 'vitest';
import {
  WORK_ITEM_SOURCES,
  ownsAll,
  workItemSchema,
  workItemsOutputSchema,
  homeConfigOutputSchema,
  type WorkItem,
} from './home-work-items.js';

const frozenCard: WorkItem = {
  id: 'card_frozen:card-1',
  kind: 'card_frozen',
  source: 'bank',
  severity: 'action',
  titleKey: 'work.card_frozen',
  link: '/bank/cards/card-1',
  reasonCode: 'card.frozen_by_owner',
};

describe('Home work items (HM-dashboard-03)', () => {
  it('accepts an owner item with decimal-string figures', () => {
    expect(workItemSchema.parse(frozenCard)).toEqual(frozenCard);
    const margin = {
      id: 'margin_health:loan-1',
      kind: 'margin_health',
      source: 'bank',
      severity: 'warning',
      titleKey: 'work.margin_health',
      link: '/bank/loans/loan-1',
      ratio: '0.8125',
      amount: { value: '1250.000000000000000001', asset: 'USDT' },
      dueAt: '2026-10-24T09:00:00Z',
    };
    expect(workItemSchema.parse(margin)).toEqual(margin);
  });

  it('refuses a kind answered by a service that does not own it', () => {
    expect(workItemSchema.safeParse({ ...frozenCard, source: 'pay' }).success).toBe(false);
    const rooms = { identity: '/verification', bank: '/bank/cards', pay: '/pay/settlements' };
    for (const [kind, source] of Object.entries(WORK_ITEM_SOURCES))
      expect(workItemSchema.safeParse({ ...frozenCard, id: `${kind}:1`, kind, source, link: rooms[source] }).success, kind).toBe(true);
  });

  it('refuses a number where money goes, and a link that leaves the customer app', () => {
    expect(workItemSchema.safeParse({ ...frozenCard, amount: { value: 12.5, asset: 'USDT' } }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, ratio: '-0.1' }).success).toBe(false);
    for (const link of ['https://evil.example/x', '//evil.example', '/bank\\x', 'bank/cards', '/bank cards'])
      expect(workItemSchema.safeParse({ ...frozenCard, link }).success, link).toBe(false);
  });

  it('refuses fields it does not define, and sentences where codes go, so no words or other person ride along', () => {
    expect(workItemSchema.safeParse({ ...frozenCard, title: 'Your card is frozen' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, userId: 'someone' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, titleKey: 'Your card is frozen, call support' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, reasonCode: 'Frozen because of John Doe' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, ratio: '1'.repeat(81) }).success).toBe(false);
  });

  it('an item links only into its owner’s rooms, and its id names its kind', () => {
    expect(workItemSchema.safeParse({ ...frozenCard, link: '/pay/settlements' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, link: '/bankrupt' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, link: '/bank' }).success).toBe(true);
    expect(workItemSchema.safeParse({ ...frozenCard, link: '/bank?tab=cards' }).success).toBe(true);
    for (const link of ['/bank/../admin/ops', '/bank/%2e%2e/pay', '/bank/./cards', '/bank/%2E%2E', '/bank/..'])
      expect(workItemSchema.safeParse({ ...frozenCard, link }).success, link).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, link: '/bank/cards?note=a%20b' }).success).toBe(true);
    expect(workItemSchema.safeParse({ ...frozenCard, id: 'margin_health:card-1' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, id: 'card_frozen:' }).success).toBe(false);
    const verify = { ...frozenCard, id: 'verification:me', kind: 'verification', source: 'identity', link: '/verification' };
    expect(workItemSchema.safeParse(verify).success).toBe(true);
  });

  it('one owner answer holds each item once', () => {
    expect(workItemsOutputSchema.safeParse({ items: [frozenCard, frozenCard] }).success).toBe(false);
  });

  it('ownsAll tells a consumer to drop an answer that carries another owner’s kind', () => {
    const answer = workItemsOutputSchema.parse({ items: [frozenCard] });
    expect(ownsAll('bank', answer)).toBe(true);
    expect(ownsAll('identity', answer)).toBe(false);
    expect(ownsAll('pay', { items: [] })).toBe(true);
  });

  it('keeps a blank owner value blank', () => {
    const blank = { workListCap: null, workListOrder: null, searchResultCap: null, noticeStripLimit: null, revision: 0 };
    expect(homeConfigOutputSchema.parse(blank)).toEqual(blank);
    // An answer from before the strip count existed reads it as blank, never as a number.
    const { noticeStripLimit: _absent, ...older } = blank;
    expect(homeConfigOutputSchema.parse(older).noticeStripLimit).toBeNull();
    expect(homeConfigOutputSchema.safeParse({ ...blank, noticeStripLimit: 0 }).success).toBe(false);
    expect(homeConfigOutputSchema.safeParse({ ...blank, noticeStripLimit: 11 }).success).toBe(false);
    expect(homeConfigOutputSchema.safeParse({ ...blank, workListCap: 0 }).success).toBe(false);
    expect(homeConfigOutputSchema.safeParse({ ...blank, searchResultCap: 0 }).success).toBe(false);
    expect(homeConfigOutputSchema.safeParse({ ...blank, workListOrder: [] }).success).toBe(false);
    expect(homeConfigOutputSchema.safeParse({ ...blank, workListOrder: ['unknown'] }).success).toBe(false);
    expect(homeConfigOutputSchema.safeParse({ ...blank, workListOrder: ['card_frozen', 'card_frozen'] }).success).toBe(false);
    expect(
      homeConfigOutputSchema.parse({ ...blank, workListCap: 5, workListOrder: ['verification'], searchResultCap: 3 }).searchResultCap,
    ).toBe(3);
  });
});
