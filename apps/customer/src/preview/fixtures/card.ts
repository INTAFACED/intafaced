import { definePreviewFixture } from './types';

/**
 * SAMPLE data for the Card Preview. Invented numbers and merchants; never mixed with real data. Money is a decimal STRING
 * (a spend is a negative string). The card has no logo and no network mark: those are empty slots. See ../README.md.
 */

export type CardStatus = 'active' | 'frozen';
export type CardTxStatus = 'pending' | 'settled';

export interface SampleCard {
  readonly kind: string;
  readonly last4: string;
  readonly holder: string;
  /** "month/year" as printed on the card. */
  readonly expires: string;
  readonly fundedFrom: string;
}
export interface CardLimit {
  readonly id: string;
  readonly label: string;
  /** Spent in the period (decimal string), or null when the limit is per purchase. */
  readonly used: string | null;
  readonly limit: string;
  readonly period: string;
}
export interface CardControl {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly on: boolean;
}
export interface CardCategory {
  readonly id: string;
  readonly label: string;
  readonly amount: string;
}
export interface CardTransaction {
  readonly id: string;
  readonly merchant: string;
  readonly category: string;
  /** A relative day, so no time zone is involved. */
  readonly when: string;
  /** Negative for a spend (decimal string). */
  readonly amount: string;
  readonly status: CardTxStatus;
  /** Sample IFC cashback (decimal string), or null. */
  readonly cashback: string | null;
}
export interface CardFixtureRows {
  readonly card: SampleCard;
  readonly spend: { readonly spent: string; readonly limit: string; readonly resets: string };
  readonly limits: readonly CardLimit[];
  readonly controls: readonly CardControl[];
  readonly categories: readonly CardCategory[];
  readonly transactions: readonly CardTransaction[];
}

export const cardFixture = definePreviewFixture<CardFixtureRows>('card', 'Card: sample card, limits, controls and spending.', {
  card: { kind: 'Virtual card', last4: '4821', holder: 'SAMPLE HOLDER', expires: '12/29', fundedFrom: 'Your USDT balance' },
  spend: { spent: '1284.60', limit: '5000.00', resets: 'in 17 days' },
  limits: [
    { id: 'daily', label: 'Daily spend', used: '142.80', limit: '1500.00', period: 'Resets tonight' },
    { id: 'monthly', label: 'Monthly spend', used: '1284.60', limit: '5000.00', period: 'Resets in 17 days' },
    { id: 'purchase', label: 'Single purchase', used: null, limit: '1000.00', period: 'Per purchase' },
    { id: 'cash', label: 'Cash withdrawal', used: '0.00', limit: '300.00', period: 'Resets in 17 days' },
  ],
  controls: [
    { id: 'online', label: 'Online payments', detail: 'Shops and apps', on: true },
    { id: 'abroad', label: 'Spending abroad', detail: 'Outside your home country', on: true },
    { id: 'contactless', label: 'Contactless', detail: 'Tap to pay', on: true },
    { id: 'cash', label: 'Cash machines', detail: 'Physical card only', on: false },
  ],
  categories: [
    { id: 'food', label: 'Food and groceries', amount: '412.30' },
    { id: 'travel', label: 'Travel', amount: '368.00' },
    { id: 'software', label: 'Software and services', amount: '241.50' },
    { id: 'shopping', label: 'Shopping', amount: '176.80' },
    { id: 'other', label: 'Everything else', amount: '86.00' },
  ],
  transactions: [
    {
      id: 't1',
      merchant: 'Corner Market',
      category: 'Food and groceries',
      when: 'Today',
      amount: '-23.90',
      status: 'pending',
      cashback: null,
    },
    { id: 't2', merchant: 'Metro Transit', category: 'Travel', when: 'Today', amount: '-2.75', status: 'pending', cashback: null },
    {
      id: 't3',
      merchant: 'Cloud Notes',
      category: 'Software and services',
      when: 'Yesterday',
      amount: '-9.99',
      status: 'settled',
      cashback: '0.20',
    },
    {
      id: 't4',
      merchant: 'Harbour Cafe',
      category: 'Food and groceries',
      when: 'Yesterday',
      amount: '-14.20',
      status: 'settled',
      cashback: '0.28',
    },
    { id: 't5', merchant: 'Skyline Air', category: 'Travel', when: '3 days ago', amount: '-212.40', status: 'settled', cashback: '4.25' },
    { id: 't6', merchant: 'Pixel Store', category: 'Shopping', when: '4 days ago', amount: '-79.00', status: 'settled', cashback: '1.58' },
    {
      id: 't7',
      merchant: 'Daily Bakery',
      category: 'Food and groceries',
      when: '5 days ago',
      amount: '-6.80',
      status: 'settled',
      cashback: '0.14',
    },
  ],
});
