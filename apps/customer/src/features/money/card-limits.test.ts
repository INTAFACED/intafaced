import { describe, expect, it } from 'vitest';
import {
  buildChannelsInput,
  buildLimitsInput,
  channelsMatch,
  limitMove,
  limitsMatch,
  limitsUnchanged,
  limitValueProblem,
  loosensCard,
  sameSettings,
  type CardChannels,
  type CardLimits,
} from './card-limits';

const cardId = '7d0a2cd4-6a46-4f6b-9d8f-0d5f27ec7b11';
const commandId = '0c1f0a52-5c7f-4c1c-8e7b-6f2d3b9a1e44';
const card: CardLimits & CardChannels = {
  perAuthorizationLimit: '250.5',
  dailyLimit: '1000',
  monthlyLimit: null,
  cashLimit: '200',
  online: true,
  contactless: false,
  atm: true,
  abroad: false,
};

describe('typing a limit', () => {
  it('needs an exact figure above zero for the per-purchase cap', () => {
    expect(limitValueProblem('250.5', false)).toBeNull();
    expect(limitValueProblem('0.000000000000000001', false)).toBeNull();
    expect(limitValueProblem('', false)).toBe('invalid');
    expect(limitValueProblem('0', false)).toBe('zero');
    expect(limitValueProblem('-5', false)).toBe('invalid');
    expect(limitValueProblem('1e3', false)).toBe('invalid');
    expect(limitValueProblem('1,000', false)).toBe('invalid');
  });
  it('lets the other caps be blank, meaning no cap, but never zero', () => {
    expect(limitValueProblem('', true)).toBeNull();
    expect(limitValueProblem('   ', true)).toBeNull();
    expect(limitValueProblem('0', true)).toBe('zero');
  });
});

describe('the limits request', () => {
  it('sends all four caps, with a blank one as null (no cap) and never as zero or empty text', () => {
    expect(
      buildLimitsInput(cardId, commandId, { perAuthorizationLimit: ' 300 ', dailyLimit: '', monthlyLimit: '5000.50', cashLimit: ' ' }),
    ).toEqual({
      cardId,
      commandId,
      perAuthorizationLimit: '300',
      dailyLimit: null,
      monthlyLimit: '5000.50',
      cashLimit: null,
    });
  });
  it('is the same request every time the same change is sent, so a resend is the same command', () => {
    const values = { perAuthorizationLimit: '300', dailyLimit: '900', monthlyLimit: '', cashLimit: '' };
    expect(buildLimitsInput(cardId, commandId, values)).toEqual(buildLimitsInput(cardId, commandId, values));
    expect(buildLimitsInput(cardId, commandId, values).commandId).toBe(commandId);
  });
});

describe('which way a cap moves', () => {
  it('reads exact figures, so 250.50 and 250.5 are the same cap', () => {
    expect(limitMove('250.5', '250.50')).toBe('same');
    expect(limitMove('250.5', '250.51')).toBe('higher');
    expect(limitMove('250.5', '250.49')).toBe('lower');
    expect(limitMove(null, '10')).toBe('added');
    expect(limitMove('10', null)).toBe('removed');
    expect(limitMove(null, null)).toBe('same');
  });
  it('treats raising or removing a cap as loosening, and lowering or adding one as tightening', () => {
    const next = (patch: Partial<typeof card>) => ({ ...card, ...patch });
    expect(loosensCard(card, next({ perAuthorizationLimit: '300' }))).toBe(true);
    expect(loosensCard(card, next({ dailyLimit: null }))).toBe(true);
    expect(loosensCard(card, next({ dailyLimit: '10' }))).toBe(false);
    expect(loosensCard(card, next({ monthlyLimit: '5000' }))).toBe(false);
    expect(loosensCard(card, next({ cashLimit: '300', dailyLimit: '10' }))).toBe(true);
  });
  it('spots a form that changes nothing', () => {
    expect(limitsUnchanged(card, { ...card, perAuthorizationLimit: '250.50' })).toBe(true);
    expect(limitsUnchanged(card, { ...card, monthlyLimit: '1' })).toBe(false);
  });
});

describe('the limits reply', () => {
  const input = buildLimitsInput(cardId, commandId, {
    perAuthorizationLimit: '300',
    dailyLimit: '',
    monthlyLimit: '5000',
    cashLimit: '200',
  });
  const reply = { id: cardId, perAuthorizationLimit: '300', dailyLimit: null, monthlyLimit: '5000.0', cashLimit: '200' };
  it('is accepted only when it is the same card with every cap as reviewed', () => {
    expect(limitsMatch(reply, input)).toBe(true);
    expect(limitsMatch({ ...reply, id: cardId.toUpperCase() }, input)).toBe(true);
    expect(limitsMatch({ ...reply, id: '00000000-0000-4000-8000-000000000000' }, input)).toBe(false);
    expect(limitsMatch({ ...reply, perAuthorizationLimit: '301' }, input)).toBe(false);
    expect(limitsMatch({ ...reply, dailyLimit: '1' }, input)).toBe(false);
    expect(limitsMatch({ ...reply, monthlyLimit: null }, input)).toBe(false);
    expect(limitsMatch({ ...reply, cashLimit: undefined }, input)).toBe(false);
    expect(limitsMatch(null, input)).toBe(false);
  });
});

describe('the channels request', () => {
  const channels = { online: true, contactless: false, atm: true, abroad: false };
  it('sends all four switches with only the flipped one changed', () => {
    expect(buildChannelsInput(cardId, commandId, channels, 'contactless', true)).toEqual({
      cardId,
      commandId,
      online: true,
      contactless: true,
      atm: true,
      abroad: false,
    });
    expect(buildChannelsInput(cardId, commandId, channels, 'online', false)).toMatchObject({ online: false, atm: true });
  });
  it('accepts the reply only when it is that card with those four switches', () => {
    const input = buildChannelsInput(cardId, commandId, channels, 'abroad', true);
    expect(channelsMatch({ id: cardId, online: true, contactless: false, atm: true, abroad: true }, input)).toBe(true);
    expect(channelsMatch({ id: cardId, online: true, contactless: false, atm: true, abroad: false }, input)).toBe(false);
    expect(channelsMatch({ id: cardId, online: true, contactless: false, atm: true }, input)).toBe(false);
    expect(channelsMatch({ id: 'other', online: true, contactless: false, atm: true, abroad: true }, input)).toBe(false);
  });
});

describe('has the card changed since it was looked at', () => {
  it('compares the switches and the caps exactly', () => {
    expect(sameSettings(card, { ...card }, ['online', 'atm'])).toBe(true);
    expect(sameSettings({ ...card, atm: false }, card, ['atm'])).toBe(false);
    expect(sameSettings({ ...card, perAuthorizationLimit: '250.50' }, card, ['perAuthorizationLimit'])).toBe(true);
    expect(sameSettings({ ...card, dailyLimit: null }, card, ['dailyLimit'])).toBe(false);
    expect(sameSettings(undefined, card, ['online'])).toBe(false);
  });
});
