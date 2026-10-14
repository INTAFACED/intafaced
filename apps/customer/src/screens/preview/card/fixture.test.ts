import { describe, expect, it } from 'vitest';
import { cardFixture } from '../../../preview/fixtures/card';

const decimal = /^-?\d+(\.\d+)?$/;
const { card, spend, limits, controls, categories, transactions } = cardFixture.rows;

describe('card fixture', () => {
  it('is sample data for card, with a plain note', () => {
    expect(cardFixture.product).toBe('card');
    expect(cardFixture.sample).toBe(true);
    expect(cardFixture.note.length).toBeGreaterThan(10);
  });

  it('never holds a full card number and has no network or brand mark', () => {
    expect(card.last4).toMatch(/^\d{4}$/);
    expect(JSON.stringify(cardFixture)).not.toMatch(/\b\d{12,19}\b/);
    expect(JSON.stringify(cardFixture)).not.toMatch(/visa|mastercard|amex/i);
  });

  it('keeps every amount a decimal string and every spend negative', () => {
    for (const value of [spend.spent, spend.limit]) expect(value).toMatch(decimal);
    for (const limit of limits) {
      expect(limit.limit).toMatch(decimal);
      if (limit.used !== null) expect(limit.used).toMatch(decimal);
    }
    for (const category of categories) expect(category.amount).toMatch(decimal);
    for (const tx of transactions) {
      expect(tx.amount).toMatch(decimal);
      expect(tx.amount.startsWith('-')).toBe(true);
      if (tx.cashback !== null) expect(tx.cashback).toMatch(decimal);
    }
  });

  it('covers limits, controls, categories and both transaction states', () => {
    expect(limits.length).toBeGreaterThanOrEqual(3);
    expect(controls.some((c) => c.on)).toBe(true);
    expect(controls.some((c) => !c.on)).toBe(true);
    expect(categories.length).toBeGreaterThanOrEqual(3);
    expect(transactions.some((t) => t.status === 'pending')).toBe(true);
    expect(transactions.some((t) => t.status === 'settled')).toBe(true);
  });

  it('adds up: the categories equal the month so far', () => {
    const cents = (value: string) => BigInt(value.replace('.', ''));
    const total = categories.reduce((sum, c) => sum + cents(c.amount), 0n);
    expect(total).toBe(cents(spend.spent));
  });
});
