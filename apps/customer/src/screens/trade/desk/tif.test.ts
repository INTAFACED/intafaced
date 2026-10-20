import { describe, expect, it } from 'vitest';
import { draftSchema } from '../../../features/trade/trade-api';
import {
  expiryIsFuture,
  expiryOf,
  orderTag,
  outcomeOf,
  tifFields,
  tifFor,
  tifLabelKey,
  tifOfDraft,
  tifsFor,
  UNSUPPORTED_TYPES,
} from './tif';

const draft = (fields: ReturnType<typeof tifFields>, type: 'limit' | 'market' = 'limit') =>
  draftSchema.safeParse({
    symbol: 'BTC/USDT',
    side: 'buy',
    type,
    amount: '0.001',
    ...(type === 'limit' ? { price: '60000' } : {}),
    ...fields,
    clientOrderId: 'desk:test',
  });

describe('time in force on the ticket', () => {
  it('offers post only, IOC and FOK on a limit order, and only standard or FOK on a market order', () => {
    expect(tifsFor('limit')).toEqual(['GTC', 'GTD', 'PO', 'IOC', 'FOK']);
    expect(tifsFor('market')).toEqual(['GTC', 'FOK']);
  });
  it('an OCO is good till cancelled only and a bracket entry is IOC, FOK or a resting GTC, never post only', () => {
    expect(tifsFor('oco')).toEqual(['GTC']);
    expect(tifsFor('bracket')).toEqual(['IOC', 'FOK', 'GTC']);
    expect(tifFor('bracket', 'GTC')).toBe('GTC');
    expect(tifFor('bracket', 'PO')).toBe('IOC');
    expect(tifFor('bracket', 'FOK')).toBe('FOK');
    expect(tifFor('oco', 'IOC')).toBe('GTC');
  });
  it('falls back to standard when the new order type cannot use the pick', () => {
    expect(tifFor('market', 'PO')).toBe('GTC');
    expect(tifFor('market', 'IOC')).toBe('GTC');
    expect(tifFor('market', 'FOK')).toBe('FOK');
    expect(tifFor('limit', 'PO')).toBe('PO');
  });
  it('sends post only as time in force PO with postOnly true, and every other pick with postOnly false', () => {
    expect(tifFields('PO')).toEqual({ timeInForce: 'PO', postOnly: true });
    for (const tif of ['GTC', 'IOC', 'FOK'] as const) expect(tifFields(tif)).toEqual({ timeInForce: tif, postOnly: false });
  });
  it('builds drafts the trade client accepts, and refuses the combinations the service refuses', () => {
    for (const tif of tifsFor('limit')) expect(draft(tifFields(tif, '2030-01-01T00:00:00.000Z')).success).toBe(true);
    expect(draft(tifFields('FOK'), 'market').success).toBe(true);
    expect(draft(tifFields('PO'), 'market').success).toBe(false);
    expect(draft({ timeInForce: 'IOC', postOnly: true }).success).toBe(false);
  });
  it('reads a draft back to the pick it came from', () => {
    for (const tif of ['GTC', 'PO', 'IOC', 'FOK'] as const) expect(tifOfDraft(tifFields(tif))).toBe(tif);
  });
  it('names a market order standard, never good till cancelled', () => {
    expect(tifLabelKey('market', 'GTC')).toBe('Tif market standard');
    expect(tifLabelKey('limit', 'GTC')).toBe('Tif GTC');
    expect(tifLabelKey('limit', 'PO')).toBe('Tif PO');
  });
  it('a good-till-date order carries its expiry, and only a good-till-date limit order may', () => {
    const at = '2030-01-01T12:00:00.000Z';
    expect(tifFields('GTD', at)).toEqual({ timeInForce: 'GTD', postOnly: false, expireAt: at });
    expect(draft(tifFields('GTD', at)).success).toBe(true);
    expect(draft(tifFields('GTD')).success).toBe(false); // no expiry
    expect(draft(tifFields('GTD', at), 'market').success).toBe(false);
    expect(draft({ ...tifFields('GTC'), expireAt: at }).success).toBe(false); // an expiry on any other pick
    expect(draft({ timeInForce: 'GTD', postOnly: true, expireAt: at }).success).toBe(false);
    expect(tifOfDraft(tifFields('GTD', at))).toBe('GTD');
    expect(tifLabelKey('limit', 'GTD')).toBe('Tif GTD');
    for (const type of ['market', 'stop_limit', 'oco', 'bracket'] as const) expect(tifsFor(type)).not.toContain('GTD');
    expect(tifFor('market', 'GTD')).toBe('GTC');
    expect(tifFor('limit', 'GTD')).toBe('GTD');
  });
  it('reads a local date and time as the UTC instant it names, and refuses anything else', () => {
    expect(expiryOf('2030-01-01T12:00')).toBe(new Date('2030-01-01T12:00').toISOString());
    for (const bad of ['', 'tomorrow', '2030-01-01', '2030-13-01T12:00', '2030-01-01T25:00']) expect(expiryOf(bad)).toBeNull();
    const now = Date.parse('2030-01-01T12:00:00');
    expect(expiryIsFuture('2030-01-01T12:01', now)).toBe(true);
    expect(expiryIsFuture('2030-01-01T12:00', now)).toBe(false);
    expect(expiryIsFuture('2029-12-31T12:00', now)).toBe(false);
    expect(expiryIsFuture('', now)).toBe(false);
  });
  it('lists every order kind the market refuses, none of them as working', () => {
    expect(UNSUPPORTED_TYPES).toEqual(['trailingStop']);
  });
});

describe('what an order reports about itself', () => {
  it('tags post only, IOC and FOK, and leaves a plain order untagged', () => {
    expect(orderTag({ timeInForce: 'GTC', postOnly: false })).toBeNull();
    expect(orderTag({ timeInForce: null, postOnly: false })).toBeNull();
    expect(orderTag({ timeInForce: 'PO', postOnly: true })).toBe('PO');
    expect(orderTag({ timeInForce: 'GTC', postOnly: true })).toBe('PO');
    expect(orderTag({ timeInForce: 'IOC', postOnly: false })).toBe('IOC');
    expect(orderTag({ timeInForce: 'FOK', postOnly: false })).toBe('FOK');
  });
});

describe('outcome of an accepted request', () => {
  it('a resting order is resting', () => {
    expect(outcomeOf({ status: 'open', filled: '0', remaining: '1' }, 'GTC')).toEqual({ kind: 'resting' });
  });
  it('a fully filled order is filled', () => {
    expect(outcomeOf({ status: 'closed', filled: '1', remaining: '0' }, 'IOC')).toEqual({ kind: 'filled' });
  });
  it('a rejected order is never "done", and carries the pick so post only and FOK get their own words', () => {
    expect(outcomeOf({ status: 'rejected', filled: '0', remaining: '1' }, 'PO')).toEqual({ kind: 'rejected', tif: 'PO' });
    expect(outcomeOf({ status: 'rejected', filled: '0', remaining: '1' }, 'FOK')).toEqual({ kind: 'rejected', tif: 'FOK' });
  });
  it('an immediate order that ended with nothing filled says nothing traded', () => {
    expect(outcomeOf({ status: 'canceled', filled: '0', remaining: '1' }, 'IOC')).toEqual({ kind: 'noFill', tif: 'IOC' });
    expect(outcomeOf({ status: 'expired', filled: '0', remaining: '1' }, 'FOK')).toEqual({ kind: 'noFill', tif: 'FOK' });
  });
  it('an IOC order that filled part and cancelled the rest says so', () => {
    expect(outcomeOf({ status: 'canceled', filled: '0.4', remaining: '0.6' }, 'IOC')).toEqual({ kind: 'partCancelled' });
    expect(outcomeOf({ status: 'closed', filled: '0.4', remaining: '0.6' }, 'IOC')).toEqual({ kind: 'partCancelled' });
  });
});
