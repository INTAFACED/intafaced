import { describe, expect, it } from 'vitest';
import { buildIssueInput, CARD_CHANNELS, cardsLive, issuedMatches, limitProblem, maskedPan, orderBlock } from './card-controls';

describe('card programme gate', () => {
  it('treats only a real issuer as live', () => {
    expect(cardsLive(null)).toBe(false);
    expect(cardsLive({ id: 'none', simulated: false })).toBe(false);
    expect(cardsLive({ id: 'card-sim', simulated: true })).toBe(false);
    expect(cardsLive({ id: 'issuer-x', simulated: false })).toBe(true);
  });
  it('names the first thing that blocks an order', () => {
    expect(orderBlock(undefined, 2)).toBe('loading');
    expect(orderBlock({ id: 'issuer-x', simulated: false }, undefined)).toBe('loading');
    expect(orderBlock(null, 2)).toBe('none');
    expect(orderBlock({ id: 'none', simulated: false }, 2)).toBe('none');
    expect(orderBlock({ id: 'card-sim', simulated: true }, 2)).toBe('simulated');
    expect(orderBlock({ id: 'issuer-x', simulated: false }, 0)).toBe('noAssets');
    expect(orderBlock({ id: 'issuer-x', simulated: false }, 1)).toBeNull();
  });
  it('lists the four channels a customer switches', () => {
    expect([...CARD_CHANNELS]).toEqual(['online', 'contactless', 'atm', 'abroad']);
  });
});

describe('card numbers and limits', () => {
  it('shows only a real four digit tail', () => {
    expect(maskedPan('1234')).toBe('•••• 1234');
    expect(maskedPan('12')).toBe('••••');
    expect(maskedPan('')).toBe('••••');
  });
  it('checks a limit as an exact positive decimal', () => {
    expect(limitProblem('0.000000000000000001')).toBeNull();
    expect(limitProblem('250')).toBeNull();
    expect(limitProblem('0')).toBe('zero');
    expect(limitProblem('-1')).toBe('invalid');
    expect(limitProblem('1e3')).toBe('invalid');
    expect(limitProblem('')).toBe('invalid');
  });
});

describe('card order identity', () => {
  const requestId = '7d0a2cd4-6a46-4f6b-9d8f-0d5f27ec7b11';
  it('uses the request id as the card id so a retry is the same card', () => {
    expect(buildIssueInput(requestId, { assetId: ' USDT ', perAuthorizationLimit: ' 100.50 ' })).toEqual({
      cardId: requestId,
      assetId: 'USDT',
      perAuthorizationLimit: '100.50',
    });
  });
  it('accepts only the card that was asked for, to the digit', () => {
    const input = buildIssueInput(requestId, { assetId: 'USDT', perAuthorizationLimit: '100.50' });
    const card = { id: requestId.toUpperCase(), assetId: 'USDT', status: 'active', perAuthorizationLimit: '100.5' };
    expect(issuedMatches(card, input)).toBe(true);
    expect(issuedMatches({ ...card, id: '00000000-0000-4000-8000-000000000000' }, input)).toBe(false);
    expect(issuedMatches({ ...card, assetId: 'BTC' }, input)).toBe(false);
    expect(issuedMatches({ ...card, perAuthorizationLimit: '100.51' }, input)).toBe(false);
    expect(issuedMatches({ ...card, status: 'frozen' }, input)).toBe(false);
    expect(issuedMatches(null, input)).toBe(false);
  });
});
