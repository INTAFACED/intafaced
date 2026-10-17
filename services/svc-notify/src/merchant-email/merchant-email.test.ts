import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderInboxCopy } from '../channels/render.js';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import {
  EMAIL_PROVIDER_UNSET,
  MERCHANT_PAY_EVENT_NAMES,
  deliverMerchantEmail,
  merchantEmailProviderFromEnv,
  renderMerchantEmail,
  type MerchantEmailProvider,
  type MerchantPayEvent,
} from './merchant-email.js';

const USER = 'merchant-user-1';
const OTHER = 'merchant-user-2';
const MAIL = 'merchant@example.test';
const CANARY = 'tok_live_secret_4242424242424242';

const refund = (over: Partial<Extract<MerchantPayEvent, { name: 'payment.refunded' }>> = {}): MerchantPayEvent => ({
  name: 'payment.refunded',
  eventId: 'evt-refund-1',
  recipientUserId: USER,
  email: MAIL,
  paymentId: 'pay-1',
  amount: '10.500',
  assetId: 'USDT',
  outcome: 'refunded',
  ...over,
});

const payout = (over: Partial<Extract<MerchantPayEvent, { name: 'rail_refused' }>> = {}): MerchantPayEvent => ({
  name: 'rail_refused',
  eventId: 'evt-payout-1',
  recipientUserId: USER,
  email: MAIL,
  settlementId: 'set-1',
  failureCode: 'rail.declined',
  ...over,
});

const dispute = (over: Partial<Extract<MerchantPayEvent, { name: 'dispute_due' }>> = {}): MerchantPayEvent => ({
  name: 'dispute_due',
  eventId: 'evt-dispute-1',
  recipientUserId: USER,
  email: MAIL,
  disputeId: 'dsp-1',
  responseDueAt: '2026-10-20T00:00:00.000Z',
  ...over,
});

const invite = (over: Partial<Extract<MerchantPayEvent, { name: 'invited' }>> = {}): MerchantPayEvent => ({
  name: 'invited',
  eventId: 'evt-invite-1',
  recipientUserId: USER,
  email: MAIL,
  role: 'finance',
  expiresAt: '2026-10-20T00:00:00.000Z',
  inviteOpen: true,
  ...over,
});

const samples: readonly MerchantPayEvent[] = [refund(), payout(), dispute(), invite()];

function inbox() {
  const store = new MemoryNotifyStore();
  return { store, notify: new NotifyService(store) };
}

describe('merchant email templates', () => {
  it('names the pay events this channel consumes', () => {
    expect([...MERCHANT_PAY_EVENT_NAMES]).toEqual(['payment.refunded', 'rail_refused', 'dispute_due', 'invited']);
  });

  it('renders plain text and HTML for each event without secrets or credential links', () => {
    for (const event of samples) {
      const rendered = renderMerchantEmail(event);
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(rendered.html).toContain('<!DOCTYPE html>');
      expect(rendered.html).toContain(`<a href="${rendered.href}">`);
      expect(rendered.text).toContain(rendered.href);
      expect(rendered.href.startsWith('/pay/')).toBe(true);
      expect(rendered.href).not.toContain('?');
      expect(rendered.href).not.toContain(MAIL);
      expect(rendered.text).not.toContain(MAIL);
      expect(rendered.html).not.toContain(MAIL);
      expect(rendered.text).not.toContain(CANARY);
      expect(rendered.html).not.toContain(CANARY);
      expect(rendered.text).not.toMatch(/\b\d{13,19}\b/);
    }
    expect(renderMerchantEmail(refund()).text).toContain('10.500');
    expect(renderMerchantEmail(refund()).text).not.toContain('10.5 ');
  });

  it('refuses a payload that carries a secret field', async () => {
    const store = new MemoryNotifyStore();
    await expect(deliverMerchantEmail({ store, provider: null }, { ...refund(), cardNumber: CANARY, token: CANARY })).rejects.toThrow();
    expect(await store.list({ userId: USER, cursor: null, limit: 20, unreadOnly: false })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('merchant email delivery', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('records notify.email_provider_unset and does not send when the provider is blank', async () => {
    const h = inbox();
    const first = await deliverMerchantEmail({ store: h.store, provider: null }, refund());
    expect(first).toMatchObject({ status: 'recorded', code: EMAIL_PROVIDER_UNSET });
    const page = await h.notify.list({ userId: USER, cursor: null, limit: 20, unreadOnly: false });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.params.code).toBe(EMAIL_PROVIDER_UNSET);
    expect(renderInboxCopy(page.items[0]!, 'en').title).toBe('email not set up yet');
  });

  it('sends nothing when email is muted for a team invite, and still records a money alert', async () => {
    const store = new MemoryNotifyStore();
    const sent: string[] = [];
    const provider: MerchantEmailProvider = {
      async send(input) {
        sent.push(input.idempotencyKey);
        return { reference: 'spy' };
      },
    };
    const muted = { muted: new Set(['email' as const]) };
    const skipped = await deliverMerchantEmail({ store, provider, muteFor: () => muted }, invite());
    expect(skipped).toEqual({ status: 'preference_off' });
    expect(sent).toEqual([]);
    const money = await deliverMerchantEmail({ store, provider, muteFor: () => muted }, refund({ eventId: 'evt-refund-muted' }));
    expect(money.status).toBe('sent');
    expect(sent).toEqual(['payment.refunded:evt-refund-muted:merchant-user-1']);
    const page = await new NotifyService(store).list({ userId: USER, cursor: null, limit: 20, unreadOnly: false });
    expect(page.items.map((row) => row.kind)).toEqual(['payment.refunded']);
  });

  it('keeps one record when the same event is delivered twice', async () => {
    const h = inbox();
    const first = await deliverMerchantEmail({ store: h.store, provider: null }, dispute());
    const second = await deliverMerchantEmail({ store: h.store, provider: null }, dispute());
    expect(first.status).toBe('recorded');
    expect(second).toEqual({ status: 'duplicate' });
    const page = await h.notify.list({ userId: USER, cursor: null, limit: 20, unreadOnly: false });
    expect(page.items).toHaveLength(1);
    const other = await deliverMerchantEmail({ store: h.store, provider: null }, dispute({ recipientUserId: OTHER }));
    expect(other.status).toBe('recorded');
    const otherPage = await h.notify.list({ userId: OTHER, cursor: null, limit: 20, unreadOnly: false });
    expect(otherPage.items).toHaveLength(1);
  });

  it('does not email a team invite that has already expired', async () => {
    const store = new MemoryNotifyStore();
    const sent: unknown[] = [];
    const provider: MerchantEmailProvider = {
      async send(input) {
        sent.push(input);
        return { reference: 'spy' };
      },
    };
    const closed = await deliverMerchantEmail(
      { store, provider, now: () => new Date('2026-10-18T00:00:00.000Z') },
      invite({ inviteOpen: false }),
    );
    const past = await deliverMerchantEmail(
      { store, provider, now: () => new Date('2026-10-21T00:00:00.000Z') },
      invite({ eventId: 'evt-invite-past', expiresAt: '2026-10-20T00:00:00.000Z' }),
    );
    expect(closed).toEqual({ status: 'expired' });
    expect(past).toEqual({ status: 'expired' });
    expect(sent).toEqual([]);
    expect((await store.list({ userId: USER, cursor: null, limit: 20, unreadOnly: false })).items).toEqual([]);
  });

  it('writes one eml under the TEST flag and does not invent a provider otherwise', async () => {
    expect(merchantEmailProviderFromEnv({})).toBeNull();
    expect(merchantEmailProviderFromEnv({ NOTIFY_MERCHANT_EMAIL_TEST: '1' })).toBeNull();
    expect(merchantEmailProviderFromEnv({ NOTIFY_MERCHANT_EMAIL_TEST_DIR: '/tmp/merch-mail' })).toBeNull();
    const dir = await mkdtemp(join(tmpdir(), 'merchmail-'));
    dirs.push(dir);
    const provider = merchantEmailProviderFromEnv({
      NOTIFY_MERCHANT_EMAIL_TEST: '1',
      NOTIFY_MERCHANT_EMAIL_TEST_DIR: dir,
    });
    expect(provider).not.toBeNull();
    const store = new MemoryNotifyStore();
    const first = await deliverMerchantEmail({ store, provider }, payout());
    const second = await deliverMerchantEmail({ store, provider }, payout());
    expect(first.status).toBe('sent');
    expect(second).toEqual({ status: 'duplicate' });
    if (first.status !== 'sent') return;
    const eml = await readFile(first.reference, 'utf8');
    expect(eml).toContain('text/plain');
    expect(eml).toContain('text/html');
    expect(eml).toContain('/pay/payouts/set-1');
    expect(eml).not.toContain(CANARY);
    const page = await new NotifyService(store).list({ userId: USER, cursor: null, limit: 20, unreadOnly: false });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.params.code).toBe('sent');
  });
});
