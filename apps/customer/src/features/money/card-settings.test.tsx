import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { cardDepthCopy } from './card-depth-copy';
import { channelSpec, freshCardCheck, limitsSpec } from './CardSettings';
import { orderSpec } from './CardPanels';
import { refusal, sendReviewed, wire } from './write-flow';
import { cardSchema } from './contracts';

const copy = cardDepthCopy.forLocale('en');
const id = '7d0a2cd4-6a46-4f6b-9d8f-0d5f27ec7b11';
const requestId = '0c1f0a52-5c7f-4c1c-8e7b-6f2d3b9a1e44';
const card = cardSchema.parse({
  id,
  assetId: 'USDT',
  settlementAssetId: 'USDT',
  issuer: 'issuer-x',
  simulated: false,
  panTail: '4242',
  status: 'active',
  cashbackBps: 0,
  perAuthorizationLimit: '250.5',
  dailyLimit: '1000',
  monthlyLimit: null,
  cashLimit: '200',
  online: true,
  contactless: false,
  atm: true,
  abroad: false,
  cardType: 'virtual',
  shippingAddress: null,
});
const ok = async () => ({ ok: true as const, data: null });
const values = { perAuthorizationLimit: '300', dailyLimit: '900', monthlyLimit: '', cashLimit: '200' };
const saved = { ...card, perAuthorizationLimit: '300', dailyLimit: '900' };

describe('changing the limits on a card', () => {
  const spec = limitsSpec(card, copy, ok);
  it('starts from the real caps, with a blank one left blank', () => {
    expect(spec.procedure).toBe('cards.setLimits');
    expect(spec.initial).toEqual({ perAuthorizationLimit: '250.5', dailyLimit: '1000', monthlyLimit: '', cashLimit: '200' });
    expect(spec.fields?.map((field) => [field.name, field.optional ?? false])).toEqual([
      ['perAuthorizationLimit', false],
      ['dailyLimit', true],
      ['monthlyLimit', true],
      ['cashLimit', true],
    ]);
  });
  it('shows what changes, from what to what, as it is typed', () => {
    expect(spec.liveRows?.(values)).toEqual([
      ['Change · Per purchase', '250.5 USDT → 300 USDT'],
      ['Change · Per day', '1,000 USDT → 900 USDT'],
    ]);
    expect(spec.liveRows?.({ ...values, dailyLimit: '', cashLimit: '' })).toContainEqual(['Change · Per day', '1,000 USDT → No limit']);
    expect(spec.liveRows?.({ ...values, monthlyLimit: '5' })).toContainEqual(['Change · Per month', 'No limit → 5 USDT']);
    expect(spec.liveRows?.({ perAuthorizationLimit: 'abc', dailyLimit: '', monthlyLimit: '', cashLimit: '' })).not.toContainEqual(
      expect.arrayContaining(['Per purchase']),
    );
  });
  it('refuses a form that changes nothing, in words', () => {
    const same = spec.input({ perAuthorizationLimit: '250.50', dailyLimit: '1000', monthlyLimit: '', cashLimit: '200' }, requestId);
    expect(spec.validate?.(same)).toBe('Nothing is different from the current limits. Change at least one.');
    expect(spec.validate?.(spec.input(values, requestId))).toBeNull();
  });
  it('checks each typed figure and says what a good one looks like', () => {
    const per = spec.fields!.find((field) => field.name === 'perAuthorizationLimit')!;
    expect(per.validate?.('0')).toBe('Enter an exact amount greater than zero.');
    expect(per.validate?.('12.5')).toBeNull();
    expect(spec.fields!.find((field) => field.name === 'dailyLimit')!.validate?.('-1')).toBe('Enter an exact amount greater than zero.');
  });
  it('builds the same request for the same change, with the request id as the command id', () => {
    const first = spec.input(values, requestId);
    const again = spec.input(values, requestId);
    expect(again).toEqual(first);
    expect(first).toEqual({
      cardId: id,
      commandId: requestId,
      perAuthorizationLimit: '300',
      dailyLimit: '900',
      monthlyLimit: null,
      cashLimit: '200',
    });
  });
  it('sends one POST with the exact caps, and accepts only the reply that matches them', async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('/api/bank/trpc/cards.setLimits');
      bodies.push(JSON.parse(String(init?.body)));
      return wire(saved);
    };
    const done = await sendReviewed(spec, values, requestId, fetcher);
    expect(done.outcome.ok).toBe(true);
    expect(bodies).toEqual([done.input]);
    // The bank answering with a different cap is not the change that was reviewed.
    const wrong = await sendReviewed(spec, values, requestId, async () => wire({ ...saved, dailyLimit: '901' }));
    expect(wrong.outcome).toMatchObject({ ok: false, reason: 'uncertain' });
  });
  it('sends a resend byte for byte the same, so the bank applies it once', async () => {
    const bodies: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return wire(saved);
    };
    await sendReviewed(spec, values, requestId, fetcher);
    await sendReviewed(spec, values, requestId, fetcher);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });
  it('turns a refused limit into plain words and lets it be corrected', async () => {
    const done = await sendReviewed(spec, values, requestId, async () => refusal(400, 'bank.card_limit_exceeded'));
    expect(done.refusedFirst).toBe(true);
    expect(done.outcome).toMatchObject({ ok: false, message: 'A card limit must be more than zero.' });
  });
  it('explains a raised limit that needs an extra security confirmation, and says nothing changed', async () => {
    const done = await sendReviewed(spec, values, requestId, async () => refusal(412, 'bank.step_up_required'));
    expect(done.refusedFirst).toBe(true);
    expect(done.outcome).toMatchObject({
      ok: false,
      message: 'This change needs an extra security confirmation, and this app does not offer one. Nothing was changed.',
    });
  });
  it('warns before sending that raising or removing a limit can need an extra confirmation', () => {
    expect(spec.notes.join(' ')).toContain('Raising or removing a limit can need an extra security confirmation. Lowering one never does.');
  });
});

describe('switching a channel', () => {
  const turnOn = channelSpec(card, 'contactless', copy, ok);
  const turnOff = channelSpec(card, 'online', copy, ok);
  it('asks for a confirmation that says what it is now and what it becomes', () => {
    expect(turnOn.title).toBe('Contactless: turn on');
    expect(turnOn.facts).toContainEqual(['Now', 'Off → On']);
    expect(turnOff.title).toBe('Online payments: turn off');
    // Turning off only protects the card, so its confirmation is short.
    expect(turnOff.facts).toEqual([['Where', 'Online payments']]);
    expect(turnOff.submit).toBe('Turn off');
    expect(turnOn.submit).toBe('Confirm');
    expect(turnOn.facts).toHaveLength(3);
    expect(turnOff.notes[0]).toContain('declined once you confirm');
    expect(turnOn.notes[0]).toContain('accepted again once you confirm');
  });
  it('sends all four switches with only the chosen one changed', () => {
    expect(turnOn.input({}, requestId)).toEqual({
      cardId: id,
      commandId: requestId,
      online: true,
      contactless: true,
      atm: true,
      abroad: false,
    });
    expect(turnOff.input({}, requestId)).toEqual({
      cardId: id,
      commandId: requestId,
      online: false,
      contactless: false,
      atm: true,
      abroad: false,
    });
  });
  it('sends the same request every time the same switch is confirmed', async () => {
    const bodies: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return wire({ ...card, contactless: true });
    };
    const first = await sendReviewed(turnOn, {}, requestId, fetcher);
    await sendReviewed(turnOn, {}, requestId, fetcher);
    expect(first.outcome.ok).toBe(true);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ commandId: requestId });
  });
  it('does not accept a reply where the switch did not move', async () => {
    const done = await sendReviewed(turnOn, {}, requestId, async () => wire(card));
    expect(done.outcome).toMatchObject({ ok: false, reason: 'uncertain' });
  });
  it('reads the card again before sending and stops if another screen changed it', async () => {
    const same = freshCardCheck(async () => ({ ok: true, data: [card] }), card, copy);
    expect(await same(['online', 'contactless', 'atm', 'abroad'])).toEqual({ ok: true, data: null });
    const changed = freshCardCheck(async () => ({ ok: true, data: [{ ...card, atm: false }] }), card, copy);
    expect(await changed(['online', 'contactless', 'atm', 'abroad'])).toMatchObject({
      ok: false,
      message: 'This card was changed somewhere else. Refresh your cards and try again. Nothing was sent.',
    });
    // A change to a switch this request does not carry is not a conflict.
    expect(await changed(['online'])).toEqual({ ok: true, data: null });
    const closed = freshCardCheck(async () => ({ ok: true, data: [{ ...card, status: 'closed' as const }] }), card, copy);
    expect(await closed(['online'])).toMatchObject({ ok: false });
    const gone = freshCardCheck(async () => ({ ok: true, data: [] }), card, copy);
    expect(await gone(['online'])).toMatchObject({ ok: false });
    const down = freshCardCheck(async () => ({ ok: false, reason: 'unreachable', message: 'x' }), card, copy);
    expect(await down(['online'])).toMatchObject({
      ok: false,
      message: 'The card could not be read again before sending, so nothing was changed.',
    });
  });
});

describe('ordering a physical card', () => {
  const assets = [{ assetId: 'USDT', available: '500' }];
  const address = { name: 'Ada Lovelace', line1: '1 High St', line2: '', city: 'London', region: '', postalCode: 'N1 9GU', country: 'gb' };
  const physical = orderSpec(copy, assets, 'physical', address);
  const virtual = orderSpec(copy, assets, 'virtual', address);
  it('reads the delivery address back in full in the review', () => {
    expect(physical.facts).toContainEqual(['Card type', 'Physical card']);
    expect(physical.facts).toContainEqual(['Deliver to', 'Ada Lovelace, 1 High St, London, N1 9GU, GB']);
    expect(virtual.facts).toEqual([['Card type', 'Virtual card']]);
  });
  it('sends the address only for a physical card, with the request id as the card id', () => {
    const values = { assetId: 'USDT', perAuthorizationLimit: '100' };
    expect(physical.input(values, requestId)).toEqual({
      cardId: requestId,
      assetId: 'USDT',
      perAuthorizationLimit: '100',
      cardType: 'physical',
      shippingAddress: { name: 'Ada Lovelace', line1: '1 High St', city: 'London', postalCode: 'N1 9GU', country: 'GB' },
    });
    expect(virtual.input(values, requestId)).toEqual({ cardId: requestId, assetId: 'USDT', perAuthorizationLimit: '100' });
    expect(physical.input(values, requestId)).toEqual(physical.input(values, requestId));
  });
  it('confirms the card that came back, and not one for a different address', async () => {
    const values = { assetId: 'USDT', perAuthorizationLimit: '100' };
    const issued = {
      ...card,
      id: requestId,
      perAuthorizationLimit: '100',
      cardType: 'physical',
      shippingAddress: {
        name: 'Ada Lovelace',
        line1: '1 High St',
        line2: null,
        city: 'London',
        region: null,
        postalCode: 'N1 9GU',
        country: 'GB',
      },
    };
    expect((await sendReviewed(physical, values, requestId, async () => wire(issued))).outcome.ok).toBe(true);
    const elsewhere = { ...issued, shippingAddress: { ...issued.shippingAddress, line1: '9 Low Rd' } };
    expect((await sendReviewed(physical, values, requestId, async () => wire(elsewhere))).outcome).toMatchObject({
      ok: false,
      reason: 'uncertain',
    });
  });
  it('keeps the test programme refusal worded when the bank refuses the order', async () => {
    const values = { assetId: 'USDT', perAuthorizationLimit: '100' };
    const refused = await sendReviewed(physical, values, requestId, async () => refusal(503, 'bank.card_sim_not_live'));
    expect(refused.refusedFirst).toBe(true);
    expect(refused.outcome).toMatchObject({
      ok: false,
      message: 'This is a test card programme. Real cards can’t be ordered because no live card issuer is connected.',
    });
    const noAddress = await sendReviewed(physical, values, requestId, async () => refusal(400, 'bank.card_shipping_address_required'));
    expect(noAddress.outcome).toMatchObject({ ok: false });
    expect((noAddress.outcome as { message: string }).message).toContain('full delivery address');
  });
});
