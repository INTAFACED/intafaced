import { describe, expect, it, vi } from 'vitest';
import { MemoryEventBus, MemorySeenStore, idempotent } from '@intafaced/events';
import { MemoryCertStore, type CertGrantRecord } from './progress.js';
import {
  BusCertXpPublisher,
  CERT_XP_ACTION,
  CERT_XP_SOURCE_MODULE,
  certXpDeltaToInt,
  certXpIntentFor,
  certXpPlaneStatus,
  NullCertXpPublisher,
} from './xp-publish.js';

/**
 * Cert → XP, and the two ways that goes wrong.
 *
 * DOUBLE AWARD is the risk TRK-academy.certs §7 names first, and rank inflation
 * is not a cosmetic bug: rank drives real perks and real limits. So the proof
 * here is not "publish was called once" — it is that a REPEAT publish, through
 * the same `idempotent()` wrapper svc-identity uses, awards once. That is the
 * property, and it survives a retry, a redelivery and a second grant call.
 *
 * NO AWARD is the other one. A bus that is down must not cost a user the
 * certification they earned, and must not report success it did not have.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-07T12:00:00.000Z');
const LATER = new Date('2026-08-09T09:30:00.000Z');

/** A real grant, through the real Stage-1 store — not a hand-shaped record. */
function grantOf(userId = USER, now = NOW): CertGrantRecord {
  const store = new MemoryCertStore();
  store.registerCert({ id: 'foundations-v1', title: 'Foundations', requiredItemSlugs: ['a', 'b'] });
  store.markComplete(userId, 'a', now);
  store.markComplete(userId, 'b', now);
  return store.grant(userId, 'foundations-v1', now);
}

describe('certXpDeltaToInt — the policy string is not a float and not a guess', () => {
  it('accepts a positive integer string', () => {
    expect(certXpDeltaToInt('100')).toBe(100);
    expect(certXpDeltaToInt(' 150 ')).toBe(150);
  });

  it('refuses zero, negative, fractional and non-numeric rather than rounding', () => {
    expect(certXpDeltaToInt('0')).toBeNull();
    expect(certXpDeltaToInt('-5')).toBeNull();
    expect(certXpDeltaToInt('1.5')).toBeNull();
    expect(certXpDeltaToInt('100.0')).toBeNull();
    expect(certXpDeltaToInt('lots')).toBeNull();
    expect(certXpDeltaToInt('')).toBeNull();
  });

  it('refuses a value past safe-integer instead of silently losing precision', () => {
    expect(certXpDeltaToInt('9007199254740993')).toBeNull();
  });
});

describe('certXpIntentFor — the payload identity will actually accept', () => {
  it('names academy as the awarding module and puts the cert in meta', () => {
    const decided = certXpIntentFor(grantOf());
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    expect(decided.intent.payload).toEqual({
      userId: USER,
      sourceModule: CERT_XP_SOURCE_MODULE,
      action: CERT_XP_ACTION,
      xpDelta: 100,
      meta: { certId: 'foundations-v1' },
    });
  });

  it('keys the award on the grant — a business key, never a random uuid', () => {
    const decided = certXpIntentFor(grantOf());
    if (!decided.ok) throw new Error('expected a publishable intent');

    expect(decided.intent.idempotencyKey).toBe(`academy.cert:cert:${USER}:foundations-v1`);
  });

  it('gives the same key for the same user and cert at a different time', () => {
    const first = certXpIntentFor(grantOf(USER, NOW));
    const second = certXpIntentFor(grantOf(USER, LATER));
    if (!first.ok || !second.ok) throw new Error('expected publishable intents');

    expect(second.intent.idempotencyKey).toBe(first.intent.idempotencyKey);
  });

  it('gives a different key to a different user — one key per award, not per cert', () => {
    const mine = certXpIntentFor(grantOf(USER));
    const theirs = certXpIntentFor(grantOf(OTHER));
    if (!mine.ok || !theirs.ok) throw new Error('expected publishable intents');

    expect(theirs.intent.idempotencyKey).not.toBe(mine.intent.idempotencyKey);
  });

  it('refuses a cert with no XP policy rather than inventing an amount', () => {
    const store = new MemoryCertStore();
    store.registerCert({ id: 'not-in-policy-v1', title: 'Unpriced', requiredItemSlugs: ['a'] });
    store.markComplete(USER, 'a', NOW);

    expect(certXpIntentFor(store.grant(USER, 'not-in-policy-v1', NOW))).toEqual({ ok: false, reason: 'no_policy' });
  });
});

describe('BusCertXpPublisher — one award reaches the one XP graph', () => {
  it('publishes an xpEarned the catalog schema accepts', async () => {
    const bus = new MemoryEventBus('svc-academy');

    const result = await new BusCertXpPublisher(bus).publishCertXp(grantOf());

    expect(result).toEqual({ emitted: true, idempotencyKey: `academy.cert:cert:${USER}:foundations-v1`, xpDelta: 100 });
    const [envelope] = bus.emitted('xpEarned');
    expect(bus.emitted('xpEarned')).toHaveLength(1);
    expect(envelope?.subject).toBe('intafaced.identity.xp.earned');
    expect(envelope?.payload).toMatchObject({ sourceModule: 'academy', action: 'cert.granted', xpDelta: 100 });
    expect(envelope?.producer).toBe('svc-academy');
  });

  it('a revoke takes the award back: the same amount negative, its own key, once (J-academy-17 #6)', async () => {
    const bus = new MemoryEventBus('svc-academy');
    const store = new MemorySeenStore();
    const awarded: number[] = [];
    await bus.subscribe(
      'xpEarned',
      idempotent(async (payload) => void awarded.push(payload.xpDelta), store, 'svc-identity-xp'),
      { durable: 'identity-xp-earned' },
    );
    const publisher = new BusCertXpPublisher(bus);
    const grant = grantOf();
    await publisher.publishCertXp(grant);
    const reversed = await publisher.reverseCertXp(grant);
    await publisher.publishCertXp(grant);
    await publisher.reverseCertXp(grant);

    expect(reversed).toEqual({ emitted: true, idempotencyKey: `academy.cert:reverse:cert:${USER}:foundations-v1`, xpDelta: -100 });
    expect(bus.emitted('xpEarned').at(-1)?.payload).toMatchObject({ sourceModule: 'academy', action: 'cert.revoked', xpDelta: -100 });
    // Award and reversal each land once at the writer, however often they are sent: the net is nothing.
    expect(awarded).toEqual([100, -100]);
    expect(awarded.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a revoke of a certificate with no published XP takes nothing back', async () => {
    const bus = new MemoryEventBus('svc-academy');
    const store = new MemoryCertStore();
    store.registerCert({ id: 'not-in-policy-v1', title: 'Unpriced', requiredItemSlugs: ['a'] });
    store.markComplete(USER, 'a', NOW);
    const result = await new BusCertXpPublisher(bus).reverseCertXp(store.grant(USER, 'not-in-policy-v1', NOW));
    expect(result).toEqual({ emitted: false, reason: 'no_policy' });
    expect(bus.emitted('xpEarned')).toHaveLength(0);
  });

  it('re-granting awards the user ONCE — the identity-side dedupe, not a promise', async () => {
    const bus = new MemoryEventBus('svc-academy');
    const store = new MemorySeenStore();
    const awarded: number[] = [];
    // The exact wrapper svc-identity subscribes with (services/svc-identity/src/events.ts).
    await bus.subscribe(
      'xpEarned',
      idempotent(async (payload) => void awarded.push(payload.xpDelta), store, 'svc-identity-xp'),
      {
        durable: 'identity-xp-earned',
      },
    );

    const publisher = new BusCertXpPublisher(bus);
    await publisher.publishCertXp(grantOf(USER, NOW));
    await publisher.publishCertXp(grantOf(USER, LATER));
    await publisher.publishCertXp(grantOf(USER, LATER));

    expect(bus.emitted('xpEarned')).toHaveLength(3);
    expect(awarded).toEqual([100]);
  });

  it('two users each get their own award', async () => {
    const bus = new MemoryEventBus('svc-academy');
    const store = new MemorySeenStore();
    const awarded: string[] = [];
    await bus.subscribe(
      'xpEarned',
      idempotent(async (payload) => void awarded.push(payload.userId), store, 'svc-identity-xp'),
      {
        durable: 'identity-xp-earned',
      },
    );

    const publisher = new BusCertXpPublisher(bus);
    await publisher.publishCertXp(grantOf(USER));
    await publisher.publishCertXp(grantOf(OTHER));

    expect(awarded).toEqual([USER, OTHER]);
  });

  it('reports a publish failure instead of throwing over a durable grant', async () => {
    const onError = vi.fn();
    const broken = { publish: vi.fn(async () => Promise.reject(new Error('nats is gone'))) };

    const result = await new BusCertXpPublisher(broken as never, onError).publishCertXp(grantOf());

    expect(result).toEqual({ emitted: false, reason: 'publish_failed' });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('never publishes for a cert with no policy', async () => {
    const bus = new MemoryEventBus('svc-academy');
    const store = new MemoryCertStore();
    store.registerCert({ id: 'not-in-policy-v1', title: 'Unpriced', requiredItemSlugs: ['a'] });
    store.markComplete(USER, 'a', NOW);

    const result = await new BusCertXpPublisher(bus).publishCertXp(store.grant(USER, 'not-in-policy-v1', NOW));

    expect(result).toEqual({ emitted: false, reason: 'no_policy' });
    expect(bus.emitted('xpEarned')).toHaveLength(0);
  });
});

describe('NullCertXpPublisher — no bus says so, and says nothing else', () => {
  it('reports unavailable rather than implying an award', async () => {
    const publisher = new NullCertXpPublisher();

    expect(publisher.usable).toBe(false);
    await expect(publisher.publishCertXp(grantOf())).resolves.toEqual({ emitted: false, reason: 'publisher_unavailable' });
  });

  it('names no_policy for an unpriced cert even when the bus is down — publishes nothing', async () => {
    const store = new MemoryCertStore();
    store.registerCert({ id: 'not-in-policy-v1', title: 'Unpriced', requiredItemSlugs: ['a'] });
    store.markComplete(USER, 'a', NOW);
    const result = await new NullCertXpPublisher().publishCertXp(store.grant(USER, 'not-in-policy-v1', NOW));
    expect(result).toEqual({ emitted: false, reason: 'no_policy' });
    expect(result).not.toHaveProperty('xpDelta');
  });
});

describe('certXpPlaneStatus — what an operator is told when a rank did not move', () => {
  it('reports the live publisher and the priced certs as integers', () => {
    const status = certXpPlaneStatus(new BusCertXpPublisher(new MemoryEventBus()));

    expect(status).toEqual({
      publisherId: 'bus',
      emitEnabled: true,
      sourceModule: 'academy',
      action: 'cert.granted',
      rankWriter: 'svc-identity',
      policies: [{ certId: 'foundations-v1', xpDelta: 100 }],
    });
  });

  it('separates "not published" from "the ladder disagrees"', () => {
    expect(certXpPlaneStatus(new NullCertXpPublisher())).toMatchObject({ publisherId: 'none', emitEnabled: false });
  });

  it('never claims academy writes rank', () => {
    expect(certXpPlaneStatus(new NullCertXpPublisher()).rankWriter).toBe('svc-identity');
  });
});
