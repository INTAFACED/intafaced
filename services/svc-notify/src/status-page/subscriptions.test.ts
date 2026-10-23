import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { statusChallengeMet, statusChallengeText, statusPageConfigureInputSchema, type StatusChallenge } from '@intafaced/contracts';
import { MemoryStatusPageBook } from './book.js';
import { NoMailer, openStatusMailer, type MailOutcome, type StatusMail, type StatusMailer } from './mailer.js';
import { MemorySubscriptionStore, StatusSubscriptionError, StatusSubscriptions } from './subscriptions.js';
import { pinnedPost, privateAddress, webhookTargetProblem } from './webhook.js';

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const SECRET = 'status-subscription-test-pepper-0123456789';

class Outbox implements StatusMailer {
  readonly kind = 'local-outbox' as const;
  readonly notConnected = null;
  readonly origin = 'https://site.test';
  readonly mail: StatusMail[] = [];
  async send(mail: StatusMail): Promise<MailOutcome> {
    this.mail.push(mail);
    return { status: 'accepted' };
  }
}

const solve = (challenge: StatusChallenge): string => {
  for (let n = 0; ; n += 1) {
    const nonce = n.toString(36);
    if (statusChallengeMet(createHash('sha256').update(statusChallengeText(challenge.token, nonce)).digest(), challenge.bits)) return nonce;
  }
};

const linkIn = (mail: StatusMail, path: string): string => {
  const match = new RegExp(`${path}\\?token=([^\\s]+)`).exec(mail.text);
  if (!match) throw new Error(`no ${path} link in: ${mail.text}`);
  return decodeURIComponent(match[1]!);
};

async function harness(opts: { mailer?: StatusMailer; settings?: Record<string, unknown>; secret?: string | null } = {}) {
  let now = NOW;
  const book = new MemoryStatusPageBook();
  await book.configure({
    input: statusPageConfigureInputSchema.parse({
      reason: 'TEST',
      expectedRevision: 0,
      componentCap: 5,
      challengeBits: 4,
      subscribeRatePerHour: 3,
      components: [
        { id: 'trading', name: 'Trading', group: null, source: null },
        { id: 'deposits', name: 'Deposits', group: null, source: null },
      ],
      ...opts.settings,
    }),
    by: FOUNDER,
    at: NOW.toISOString(),
  });
  const store = new MemorySubscriptionStore();
  const mailer = opts.mailer ?? new Outbox();
  const posts: { url: string; body: string; key: string | null }[] = [];
  const subs = new StatusSubscriptions({
    store,
    page: book,
    mailer,
    secret: opts.secret === undefined ? SECRET : opts.secret,
    linkTtlMinutes: 30,
    webhookTimeoutMs: 1000,
    resolve: async (host) => (host === 'hooks.example.com' ? ['93.184.216.34'] : host === 'sneaky.example.com' ? ['10.0.0.5'] : []),
    post: async (url, body, headers) => {
      posts.push({ url, body, key: headers['idempotency-key'] ?? null });
      return { ok: true };
    },
    now: () => now,
  });
  const subscribe = async (email: string, componentIds: string[] | null = null) => {
    const challenge = await subs.challenge();
    return subs.subscribe({ email, componentIds, challenge: { token: challenge.token, nonce: solve(challenge) } });
  };
  return { subs, store, mailer, posts, subscribe, at: (iso: string) => (now = new Date(iso)) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof StatusSubscriptionError) return err.code;
    throw err;
  }
  return 'no error';
};

describe('status subscriptions', () => {
  it('refuses with typed codes while the owner values or the secret are blank', async () => {
    const blank = await harness({ settings: { challengeBits: null, subscribeRatePerHour: null } });
    expect(await code(blank.subs.challenge())).toBe('status.challenge_unset');
    expect(await blank.subs.policy()).toMatchObject({ challengeBits: null, rateLimitSet: false, sms: 'vendor.sms', push: 'vendor.push' });
    const noRate = await harness({ settings: { subscribeRatePerHour: null } });
    expect(await code(noRate.subscribe('a@example.com'))).toBe('status.rate_limit_unset');
    const noSecret = await harness({ secret: null });
    expect(await code(noSecret.subs.challenge())).toBe('status.challenge_unset');
  });

  it('stores nothing for a failed proof of work, and a challenge works once', async () => {
    const h = await harness();
    const challenge = await h.subs.challenge();
    let wrong = 0;
    while (
      statusChallengeMet(
        createHash('sha256')
          .update(statusChallengeText(challenge.token, wrong.toString(36)))
          .digest(),
        challenge.bits,
      )
    )
      wrong += 1;
    expect(
      await code(
        h.subs.subscribe({ email: 'a@example.com', componentIds: null, challenge: { token: challenge.token, nonce: wrong.toString(36) } }),
      ),
    ).toBe('status.challenge_failed');
    expect(await h.subs.find('a@example.com')).toBeNull();
    const nonce = solve(challenge);
    await h.subs.subscribe({ email: 'a@example.com', componentIds: null, challenge: { token: challenge.token, nonce } });
    expect(await code(h.subs.subscribe({ email: 'b@example.com', componentIds: null, challenge: { token: challenge.token, nonce } }))).toBe(
      'status.challenge_failed',
    );
    expect(await h.subs.find('b@example.com')).toBeNull();
  });

  it('double opt-in: sends only the confirmation, and confirming twice leaves one active subscriber', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    expect(await h.subscribe('Person@Example.com', ['trading'])).toEqual({ state: 'confirmation_sent', notConnected: null });
    expect(outbox.mail).toHaveLength(1);
    await h.subs.fanOut({ id: 'n1', kind: 'incident', title: 'Trading slow', body: 'Looking.', components: ['trading'] });
    expect(outbox.mail).toHaveLength(1);
    const token = linkIn(outbox.mail[0]!, '/status/confirm');
    const first = await h.subs.confirm(token);
    const second = await h.subs.confirm(token);
    expect(first.state).toBe('active');
    expect(second).toEqual(first);
    expect(first.email).toBe('p*****@example.com');
    const found = await h.subs.find('person@example.com');
    expect(found).toMatchObject({ state: 'active', email: 'person@example.com', componentIds: ['trading'] });
  });

  it('sends a notice once to subscribers it concerns, with a working unsubscribe link', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('trading@example.com', ['trading']);
    await h.subscribe('deposits@example.com', ['deposits']);
    await h.subscribe('all@example.com', null);
    for (const mail of [...outbox.mail]) await h.subs.confirm(linkIn(mail, '/status/confirm'));
    const notice = { id: 'n1', kind: 'incident' as const, title: 'Trading slow', body: 'Looking.', components: ['trading'] };
    await h.subs.fanOut(notice);
    await h.subs.fanOut(notice);
    const updates = outbox.mail.filter((m) => m.subject.startsWith('Status update'));
    expect(updates.map((m) => m.to).sort()).toEqual(['all@example.com', 'trading@example.com']);
    const leave = linkIn(
      updates.find((m) => m.to === 'trading@example.com')!,
      '/status/unsubscribe',
    );
    expect((await h.subs.unsubscribe(leave)).state).toBe('unsubscribed');
    expect((await h.subs.unsubscribe(leave)).state).toBe('unsubscribed');
    await h.subs.fanOut({ ...notice, id: 'n2' });
    expect(outbox.mail.filter((m) => m.subject.startsWith('Status update') && m.to === 'trading@example.com')).toHaveLength(1);
    await h.subs.fanOut({ ...notice, id: 'n3', kind: 'changelog' });
    expect(outbox.mail.filter((m) => m.subject.includes('n3'))).toHaveLength(0);
  });

  it('refuses a private webhook, and posts a public one once per notice', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('hook@example.com');
    const { manageToken } = await h.subs.confirm(linkIn(outbox.mail[0]!, '/status/confirm'));
    for (const url of [
      'https://127.0.0.1/x',
      'https://192.168.1.4/x',
      'https://sneaky.example.com/x',
      'http://hooks.example.com/x',
      'https://[::1]/x',
    ])
      expect(await code(h.subs.updateSubscription({ token: manageToken, componentIds: null, webhookUrl: url }))).toBe(
        'status.webhook_target_refused',
      );
    expect(await code(h.subs.updateSubscription({ token: manageToken, componentIds: ['nope'], webhookUrl: null }))).toBe(
      'status.component_unknown',
    );
    const view = await h.subs.updateSubscription({
      token: manageToken,
      componentIds: ['deposits'],
      webhookUrl: 'https://hooks.example.com/status',
    });
    expect(view).toMatchObject({ componentIds: ['deposits'], webhookUrl: 'https://hooks.example.com/status' });
    const notice = { id: 'n1', kind: 'maintenance' as const, title: 'Deposits paused', body: 'Planned.', components: ['deposits'] };
    await h.subs.fanOut(notice);
    await h.subs.fanOut(notice);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.key).toMatch(/^n1:.+:webhook$/);
  });

  it('limits subscribe requests per address per hour', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) await h.subscribe('busy@example.com');
    expect(await code(h.subscribe('busy@example.com'))).toBe('status.rate_limited');
    h.at('2026-10-23T13:00:01.000Z');
    expect(await h.subscribe('busy@example.com')).toMatchObject({ state: 'confirmation_sent' });
  });

  it('rejects tampered, expired and stale links', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('late@example.com');
    const token = linkIn(outbox.mail[0]!, '/status/confirm');
    expect(await code(h.subs.confirm(`${token}x`))).toBe('status.subscription_link_invalid');
    expect(await code(h.subs.confirm(token.replace(/^confirm/, 'manage')))).toBe('status.subscription_link_invalid');
    h.at('2026-10-23T12:31:00.000Z');
    expect(await code(h.subs.confirm(token))).toBe('status.subscription_link_invalid');
  });

  it('with no email sender, records the confirmation as pending with vendor.email', async () => {
    const h = await harness({ mailer: new NoMailer() });
    expect(await h.subscribe('wait@example.com')).toEqual({ state: 'confirmation_pending', notConnected: 'vendor.email' });
    expect((await h.subs.find('wait@example.com'))!.deliveries).toEqual([
      expect.objectContaining({ channel: 'email', status: 'pending', refusalCode: 'vendor.email' }),
    ]);
    expect((await h.subs.policy()).email).toBe('vendor.email');
  });
});

describe('status subscription review fixes', () => {
  it('answers the same for a new and an already active address, with or without a sender', async () => {
    const h = await harness({ mailer: new NoMailer() });
    const first = await h.subscribe('known@example.com');
    const stored = await h.subs.find('known@example.com');
    await h.store.update((await h.store.byEmail('known@example.com'))!.id, { state: 'active' });
    expect(stored!.state).toBe('unconfirmed');
    expect(await h.subscribe('known@example.com')).toEqual(first);
    expect(await h.subscribe('stranger@example.com')).toEqual(first);
  });

  it('sends a fresh confirmation when an unconfirmed address asks again after its link expired', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('again@example.com');
    h.at('2026-10-23T12:45:00.000Z');
    expect(await code(h.subs.confirm(linkIn(outbox.mail[0]!, '/status/confirm')))).toBe('status.subscription_link_invalid');
    await h.subscribe('again@example.com');
    expect(outbox.mail).toHaveLength(2);
    expect((await h.subs.confirm(linkIn(outbox.mail[1]!, '/status/confirm'))).state).toBe('active');
  });

  it('voids manage links from an earlier subscription once the address leaves and comes back', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('back@example.com');
    const { manageToken } = await h.subs.confirm(linkIn(outbox.mail[0]!, '/status/confirm'));
    await h.subs.unsubscribe(manageToken);
    await h.subscribe('back@example.com');
    const { manageToken: next } = await h.subs.confirm(linkIn(outbox.mail.at(-1)!, '/status/confirm'));
    expect(await code(h.subs.subscription(manageToken))).toBe('status.subscription_link_invalid');
    expect((await h.subs.subscription(next)).state).toBe('active');
  });

  it('puts a manage link and an unsubscribe link in every update', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('links@example.com');
    const { manageToken } = await h.subs.confirm(linkIn(outbox.mail[0]!, '/status/confirm'));
    await h.subs.fanOut({ id: 'n9', kind: 'incident', title: 'T', body: 'B', components: [] });
    const update = outbox.mail.at(-1)!;
    expect(linkIn(update, '/status/manage')).toBe(manageToken);
    expect(linkIn(update, '/status/unsubscribe')).toBe(manageToken);
  });
});

describe('status mail transport', () => {
  it('allows the local outbox only in dev or test, with an absolute path', () => {
    const base = { transport: 'local-outbox', outboxPath: '/tmp/outbox.log', email: undefined, publicOrigin: undefined };
    expect(openStatusMailer({ ...base, appEnv: 'test' }).notConnected).toBeNull();
    expect(() => openStatusMailer({ ...base, appEnv: 'production' })).toThrow(/status_mail_transport_refused/);
    expect(() => openStatusMailer({ ...base, appEnv: 'staging' })).toThrow(/status_mail_transport_refused/);
    expect(() => openStatusMailer({ ...base, appEnv: 'dev', outboxPath: 'relative.log' })).toThrow(/must be absolute/);
    expect(openStatusMailer({ ...base, transport: undefined, appEnv: 'production' }).notConnected).toBe('vendor.email');
  });
});

describe('webhook targets', () => {
  it('names private addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ])
      expect(privateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '2606:4700::1111', '::ffff:5db8:d822', '2002:5db8:d822::1'])
      expect(privateAddress(ip), ip).toBe(false);
  });

  it('refuses localhost names and unresolved names', async () => {
    expect(await webhookTargetProblem('https://localhost/x', async () => ['93.184.216.34'])).toBe('private_address');
    expect(await webhookTargetProblem('https://svc.internal/x', async () => ['93.184.216.34'])).toBe('private_address');
    expect(await webhookTargetProblem('https://nowhere.example/x', async () => [])).toBe('unresolved');
    expect(await webhookTargetProblem('https://u:p@hooks.example.com/x', async () => ['93.184.216.34'])).toBe('credentials_in_url');
  });

  it('connects only to the address it checked: a name that answers private at send time is refused', async () => {
    let calls = 0;
    const rebinding = async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    expect(await webhookTargetProblem('https://rebind.example.com/x', rebinding)).toBeNull();
    await expect(pinnedPost(rebinding)('https://rebind.example.com/x', '{}', {}, 1000)).rejects.toThrow(/status.webhook_target_refused/);
  });
});

describe('subscriber desk (SP-status-04 delivery rows and safeguards)', () => {
  const notice = { id: 'n-desk', kind: 'incident' as const, title: 'Trading slow', body: 'Looking.', components: ['trading'] };

  it('one delivery row per subscriber and channel, however many fan-outs, and two at once send once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class SlowOutbox extends Outbox {
      slow = false;
      override async send(mail: StatusMail): Promise<MailOutcome> {
        if (this.slow) await gate;
        return super.send(mail);
      }
    }
    const mailer = new SlowOutbox();
    const h = await harness({ mailer });
    await h.subscribe('one@example.com');
    await h.subs.confirm(linkIn(mailer.mail[0]!, '/status/confirm'));
    mailer.slow = true;
    const both = Promise.all([h.subs.fanOut(notice), h.subs.fanOut(notice)]);
    release();
    await both;
    await h.subs.fanOut(notice);
    expect(mailer.mail.filter((m) => m.subject.startsWith('Status update'))).toHaveLength(1);
    expect(await h.subs.eventDeliveries(notice.id)).toEqual({
      rows: [expect.objectContaining({ email: 'one@example.com', channel: 'email', status: 'accepted', attempts: 1 })],
      more: false,
    });
  });

  it('with no sender the rows wait pending with vendor.email, and the desk names every channel without one', async () => {
    const h = await harness({ mailer: new NoMailer() });
    expect(h.subs.channels()).toEqual({ email: { sender: null, notConnected: 'vendor.email' }, sms: 'vendor.sms', push: 'vendor.push' });
    await h.subs.importSubscribers({ source: 'test-list', emails: ['wait@example.com'] });
    const [row] = await h.subs.list({ state: null, limit: 10 });
    expect(row).toMatchObject({
      email: 'wait@example.com',
      state: 'unconfirmed',
      source: 'test-list',
      deliveries: { pending: 1, accepted: 0 },
    });
  });

  it('an import with a duplicate address makes one record, and importing it again sends nothing new', async () => {
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('known@example.com');
    const result = await h.subs.importSubscribers({
      source: 'test-list',
      emails: ['new@example.com', ' NEW@example.com ', 'known@example.com', 'not an address'],
    });
    expect(result).toEqual({ received: 4, distinct: 2, added: 1, alreadyKnown: 1, invalid: ['not an address'], limited: 0 });
    const rows = await h.subs.list({ state: null, limit: 10 });
    expect(rows.filter((r) => r.email === 'new@example.com')).toHaveLength(1);
    expect(rows.find((r) => r.email === 'known@example.com')!.source).toBeNull();
    const confirmations = () => outbox.mail.filter((m) => m.to === 'new@example.com').length;
    expect(confirmations()).toBe(1);
    await h.subs.importSubscribers({ source: 'test-list', emails: ['new@example.com'] });
    expect(confirmations()).toBe(1);
    // Imported is not active: nothing but the confirmation reaches it.
    await h.subs.fanOut(notice);
    expect(confirmations()).toBe(1);
  });

  it('a blank rate limit refuses an import as it refuses subscribing; a malformed import is refused whole', async () => {
    const blank = await harness({ settings: { subscribeRatePerHour: null } });
    expect(await code(blank.subs.importSubscribers({ source: 'test-list', emails: ['a@example.com'] }))).toBe('status.rate_limit_unset');
    expect(await blank.subs.list({ state: null, limit: 10 })).toEqual([]);
    const h = await harness();
    expect(await code(h.subs.importSubscribers({ source: 'Bad Source', emails: ['a@example.com'] }))).toBe('status.import_invalid');
    expect(await code(h.subs.importSubscribers({ source: 'test-list', emails: [] }))).toBe('status.import_invalid');
  });

  it('a resend tries pending rows again once a sender is there, and leaves accepted ones', async () => {
    const store = new MemorySubscriptionStore();
    const at = new Date('2026-10-23T12:00:00.000Z');
    await store.claimDelivery({ key: 'k', subscriberId: 's', event: 'e', channel: 'email' }, at);
    expect(await store.takeDelivery('k', at, new Date(at.getTime() + 1000))).toBe(true);
    expect(await store.takeDelivery('k', at, new Date(at.getTime() + 1000))).toBe(false);
    await store.settleDelivery('k', 'pending', 'vendor.email', at);
    expect(await store.takeDelivery('k', at, new Date(at.getTime() + 1000))).toBe(true);
    await store.settleDelivery('k', 'accepted', null, at);
    expect(await store.takeDelivery('k', at, new Date(at.getTime() + 1000))).toBe(false);
  });

  it("send again tries only the notice's unsettled rows: no one who joined since is reached", async () => {
    let failing = true;
    class Flaky extends Outbox {
      override async send(mail: StatusMail): Promise<MailOutcome> {
        if (failing && mail.subject.startsWith('Status update') && mail.to === 'first@example.com') throw new Error('disk full');
        return super.send(mail);
      }
    }
    const mailer = new Flaky();
    const h = await harness({ mailer });
    await h.subscribe('first@example.com');
    await h.subscribe('second@example.com');
    for (const mail of [...mailer.mail]) await h.subs.confirm(linkIn(mail, '/status/confirm'));
    await h.subs.fanOut(notice);
    // A transport that throws fails its own row and the fan-out goes on to the next subscriber.
    const statuses = async () => Object.fromEntries((await h.subs.eventDeliveries(notice.id)).rows.map((r) => [r.email, r.status]));
    expect(await statuses()).toEqual({ 'first@example.com': 'failed', 'second@example.com': 'accepted' });
    await h.subscribe('late@example.com');
    await h.subs.confirm(linkIn(mailer.mail.at(-1)!, '/status/confirm'));
    failing = false;
    await h.subs.retry(notice);
    expect(await statuses()).toEqual({ 'first@example.com': 'accepted', 'second@example.com': 'accepted' });
    expect(mailer.mail.filter((m) => m.to === 'late@example.com' && m.subject.startsWith('Status update'))).toHaveLength(0);
    expect(mailer.mail.filter((m) => m.to === 'second@example.com' && m.subject.startsWith('Status update'))).toHaveLength(1);
  });

  it('a blank proof of work refuses an import; a known unconfirmed address gets no confirmation from an import', async () => {
    const blank = await harness({ settings: { challengeBits: null } });
    expect(await code(blank.subs.importSubscribers({ source: 'test-list', emails: ['a@example.com'] }))).toBe('status.challenge_unset');
    const h = await harness();
    const outbox = h.mailer as Outbox;
    await h.subscribe('waiting@example.com');
    for (let i = 0; i < 5; i += 1) await h.subs.importSubscribers({ source: 'test-list', emails: ['waiting@example.com'] });
    expect(outbox.mail.filter((m) => m.to === 'waiting@example.com')).toHaveLength(1);
    // Its own hourly budget was not spent by the imports.
    expect(await h.subscribe('waiting@example.com')).toMatchObject({ state: 'confirmation_sent' });
  });

  it('a sender that lost its lease records nothing over the one that took the row', async () => {
    const store = new MemorySubscriptionStore();
    const at = new Date('2026-10-23T12:00:00.000Z');
    await store.claimDelivery({ key: 'k', subscriberId: 's', event: 'e', channel: 'email' }, at);
    const first = new Date(at.getTime() + 1000);
    expect(await store.takeDelivery('k', at, first)).toBe(true);
    const later = new Date(at.getTime() + 2000);
    const second = new Date(at.getTime() + 5000);
    expect(await store.takeDelivery('k', later, second)).toBe(true);
    await store.settleDelivery('k', 'failed', null, later, first);
    expect((await store.deliveries('s'))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    await store.settleDelivery('k', 'accepted', null, later, second);
    expect((await store.deliveries('s'))[0]).toMatchObject({ status: 'accepted', attempts: 1 });
  });
});
