import { describe, expect, it } from 'vitest';
import {
  WORK_ITEM_SOURCES,
  ownsAll,
  workItemSchema,
  workItemsOutputSchema,
  workListConfigOutputSchema,
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
    for (const [kind, source] of Object.entries(WORK_ITEM_SOURCES))
      expect(workItemSchema.safeParse({ ...frozenCard, id: kind, kind, source }).success).toBe(true);
  });

  it('refuses a number where money goes, and a link that leaves the customer app', () => {
    expect(workItemSchema.safeParse({ ...frozenCard, amount: { value: 12.5, asset: 'USDT' } }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, ratio: '-0.1' }).success).toBe(false);
    for (const link of ['https://evil.example/x', '//evil.example', '/bank\\x', 'bank/cards', '/bank cards'])
      expect(workItemSchema.safeParse({ ...frozenCard, link }).success, link).toBe(false);
  });

  it('refuses fields it does not define, so no sentence or other person rides along', () => {
    expect(workItemSchema.safeParse({ ...frozenCard, title: 'Your card is frozen' }).success).toBe(false);
    expect(workItemSchema.safeParse({ ...frozenCard, userId: 'someone' }).success).toBe(false);
  });

  it('ownsAll tells a consumer to drop an answer that carries another owner’s kind', () => {
    const answer = workItemsOutputSchema.parse({ items: [frozenCard] });
    expect(ownsAll('bank', answer)).toBe(true);
    expect(ownsAll('identity', answer)).toBe(false);
    expect(ownsAll('pay', { items: [] })).toBe(true);
  });

  it('keeps a blank owner value blank', () => {
    expect(workListConfigOutputSchema.parse({ cap: null, order: null, revision: 0 })).toEqual({ cap: null, order: null, revision: 0 });
    expect(workListConfigOutputSchema.safeParse({ cap: 0, order: null, revision: 1 }).success).toBe(false);
    expect(workListConfigOutputSchema.safeParse({ cap: 3, order: [], revision: 1 }).success).toBe(false);
    expect(workListConfigOutputSchema.safeParse({ cap: 3, order: ['unknown'], revision: 1 }).success).toBe(false);
  });
});
