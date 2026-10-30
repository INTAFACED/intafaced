import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { subject, parseSubject, assertValidSubject, InvalidSubjectError, wildcard, streamName } from './subject.js';
import { ALL_EVENTS, EVENT_CATALOG, WIRING_SOCKETS, wiringSocketReason } from './catalog.js';
import { MemoryEventBus } from './memory-bus.js';
import {
  EventSchemaDriftError,
  EventSubjectMismatchError,
  EventValidationError,
  EventVersionMismatchError,
  MemorySeenStore,
  acceptEnvelope,
  droppedPaths,
  idempotent,
  validatePayload,
} from './bus.js';
import { createEnvelope, decodeEnvelope, encodeEnvelope, type Envelope } from './envelope.js';
import { ACK_WAIT_MS, ACK_WAIT_NS, DEFAULT_MAX_DELIVER } from './jetstream-bus.js';
import type { EventName, PayloadOf } from './catalog.js';

describe('§10 subject law: intafaced.<service>.<entity>.<verb>', () => {
  it('builds a valid subject', () => {
    expect(subject('ledger', 'tx', 'posted')).toBe('intafaced.ledger.tx.posted');
  });

  it('rejects an unregistered service', () => {
    expect(() => assertValidSubject('intafaced.nonsense.tx.posted')).toThrow(InvalidSubjectError);
  });

  it('rejects a present-tense verb — events are facts, not commands', () => {
    expect(() => assertValidSubject('intafaced.ledger.tx.post')).toThrow(InvalidSubjectError);
  });

  it('rejects the wrong token count', () => {
    expect(() => assertValidSubject('intafaced.ledger.posted')).toThrow(InvalidSubjectError);
    expect(() => assertValidSubject('intafaced.ledger.tx.entry.posted')).toThrow(InvalidSubjectError);
  });

  it('rejects a bad prefix', () => {
    expect(() => assertValidSubject('other.ledger.tx.posted')).toThrow(InvalidSubjectError);
  });

  it('parses back to its parts', () => {
    expect(parseSubject('intafaced.trade.order.filled')).toMatchObject({
      service: 'trade',
      entity: 'order',
      verb: 'filled',
    });
  });

  it('produces consumer wildcards and stream names', () => {
    expect(wildcard('ledger')).toBe('intafaced.ledger.>');
    expect(wildcard('trade', 'order')).toBe('intafaced.trade.order.*');
    expect(streamName('mining-pool')).toBe('INTAFACED_MINING_POOL');
  });
});

describe('event catalog', () => {
  it('every declared event has a legal subject', () => {
    for (const def of ALL_EVENTS) {
      expect(() => assertValidSubject(def.subject)).not.toThrow();
    }
  });

  it('has no duplicate subjects', () => {
    const subjects = ALL_EVENTS.map((e) => e.subject);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it('starts every payload at version 1 or higher', () => {
    for (const def of ALL_EVENTS) expect(def.version).toBeGreaterThanOrEqual(1);
  });

  it('rejects float amounts on money events — decimals are strings', () => {
    expect(() =>
      validatePayload('ledgerTxPosted', {
        txId: crypto.randomUUID(),
        module: 'trade',
        reason: 'trade.fill',
        hash: 'abc',
        previousHash: null,
        entries: [
          { accountId: crypto.randomUUID(), assetId: 'USDT', direction: 'debit', amount: 10.5 },
          { accountId: crypto.randomUUID(), assetId: 'USDT', direction: 'credit', amount: '10.5' },
        ],
        postedAt: new Date().toISOString(),
      }),
    ).toThrow(EventValidationError);
  });

  it('carries a margin call as a fact about a loan, not a claim that anyone was told', () => {
    const payload = validatePayload('bankMarginCalled', {
      loanId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      sequence: 3,
      ltvBps: 8_200,
      cureCollateralAmount: '0.041500000000000000',
      collateralAssetId: 'BTC',
      calledAt: new Date().toISOString(),
      graceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // The cure amount is a decimal string end to end — never a number.
    expect(payload.cureCollateralAmount).toBe('0.041500000000000000');
    expect(EVENT_CATALOG.bankMarginCalled.subject).toBe('intafaced.bank.margin_call.created');
    // Nothing on this payload asserts delivery. Delivery is svc-notify's record.
    expect(Object.keys(payload)).not.toContain('notifiedAt');
  });

  it('rejects a margin call with a float cure amount or a zeroth sequence', () => {
    const base = {
      loanId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      sequence: 1,
      ltvBps: 8_200,
      cureCollateralAmount: '0.0415',
      collateralAssetId: 'BTC',
      calledAt: new Date().toISOString(),
      graceExpiresAt: new Date().toISOString(),
    };
    expect(() => validatePayload('bankMarginCalled', { ...base, cureCollateralAmount: 0.0415 })).toThrow(EventValidationError);
    // Sequence starts at 1: a call numbered 0 would collide with "no call yet".
    expect(() => validatePayload('bankMarginCalled', { ...base, sequence: 0 })).toThrow(EventValidationError);
  });

  it('refuses an unexplained freeze — frozen with a null reason is unactionable', () => {
    expect(() =>
      validatePayload('ledgerFreezeUpdated', {
        frozen: true,
        reason: null,
        actor: 'reconciliation',
        changedAt: new Date().toISOString(),
      }),
    ).toThrow(EventValidationError);
  });

  it('accepts a thaw with a null reason', () => {
    expect(() =>
      validatePayload('ledgerFreezeUpdated', {
        frozen: false,
        reason: null,
        actor: 'reconciliation',
        changedAt: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  it('accepts 18-decimal precision', () => {
    const payload = validatePayload('stakeCreated', {
      stakeId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      amount: '1234.123456789012345678',
      tier: 'm12',
      unlocksAt: new Date().toISOString(),
    });
    expect(payload.amount).toBe('1234.123456789012345678');
  });

  it('accepts a futures positionUpdated with decimal-string money fields', () => {
    const payload = validatePayload('positionUpdated', {
      positionId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      marketId: 'btc-usdt-perp',
      symbol: 'BTC/USDT:USDT',
      status: 'open',
      side: 'long',
      contracts: '1.250000000000000000',
      entryPrice: '64000.5',
      markPrice: '64110',
      notional: '80137.5',
      leverage: '5',
      collateral: '16027.5',
      unrealizedPnl: '137.5',
      realizedPnl: '0',
      liquidationPrice: '52000',
      marginMode: 'cross',
      fundingPaid: '-0.004000000000000000',
      ts: new Date().toISOString(),
    });
    expect(EVENT_CATALOG.positionUpdated.subject).toBe('intafaced.trade.position.updated');
    expect(payload.contracts).toBe('1.250000000000000000');
    expect(() =>
      validatePayload('positionUpdated', {
        ...payload,
        contracts: 1.25,
      }),
    ).toThrow(EventValidationError);
  });

  it('refuses a leading minus on unsigned money and keeps it on drift and pnl', () => {
    const uid = () => crypto.randomUUID();
    const ts = new Date().toISOString();
    const filled = {
      marketId: 'btc-usdt',
      makerOrderId: uid(),
      takerOrderId: uid(),
      price: '64000',
      qty: '0.1',
      sequence: 1,
      ts,
    };
    expect(() => validatePayload('orderFilled', { ...filled, price: '-1' })).toThrow(EventValidationError);
    expect(() => validatePayload('orderFilled', { ...filled, qty: '-0.1' })).toThrow(EventValidationError);

    const settled = {
      fillId: uid(),
      orderId: uid(),
      userId: uid(),
      marketId: 'btc-usdt',
      side: 'buy' as const,
      liquidity: 'taker' as const,
      price: '100',
      qty: '1',
      quoteAmount: '100',
      feeAsset: 'USDT',
      feeAmount: '0.1',
      feeBps: 10,
      sequence: 1,
      ts,
    };
    expect(() => validatePayload('fillSettled', { ...settled, price: '-100' })).toThrow(EventValidationError);
    expect(() => validatePayload('fillSettled', { ...settled, qty: '-1' })).toThrow(EventValidationError);
    expect(() => validatePayload('fillSettled', { ...settled, feeAmount: '-0.1' })).toThrow(EventValidationError);

    const position = {
      positionId: uid(),
      userId: uid(),
      marketId: 'btc-usdt-perp',
      symbol: 'BTC/USDT:USDT',
      status: 'open' as const,
      side: 'long' as const,
      contracts: '1',
      entryPrice: '64000',
      markPrice: '64100',
      notional: '64000',
      leverage: '5',
      collateral: '12800',
      unrealizedPnl: '100',
      realizedPnl: '0',
      liquidationPrice: '50000',
      marginMode: 'cross' as const,
      fundingPaid: '0',
      ts,
    };
    expect(() => validatePayload('positionUpdated', { ...position, entryPrice: '-64000' })).toThrow(EventValidationError);
    expect(() => validatePayload('positionUpdated', { ...position, contracts: '-1' })).toThrow(EventValidationError);
    expect(() => validatePayload('positionUpdated', { ...position, notional: '-64000' })).toThrow(EventValidationError);
    expect(() => validatePayload('positionUpdated', { ...position, collateral: '-12800' })).toThrow(EventValidationError);

    const released = {
      tradeId: uid(),
      sellerId: uid(),
      buyerId: uid(),
      asset: 'BTC',
      amount: '0.1',
      fee: '0.001',
      resolvedBy: 'seller' as const,
      releaseSeconds: 60,
    };
    expect(() => validatePayload('p2pEscrowReleased', { ...released, amount: '-0.1' })).toThrow(EventValidationError);
    expect(() => validatePayload('p2pEscrowReleased', { ...released, fee: '-0.001' })).toThrow(EventValidationError);

    expect(() =>
      validatePayload('stakeCreated', {
        stakeId: uid(),
        userId: uid(),
        amount: '-100.00',
        tier: 'flex',
        unlocksAt: null,
      }),
    ).toThrow(EventValidationError);

    expect(() =>
      validatePayload('ledgerTxPosted', {
        txId: uid(),
        module: 'trade',
        reason: 'trade.fill',
        hash: 'h1',
        previousHash: null,
        entries: [
          { accountId: uid(), assetId: 'USDT', direction: 'debit', amount: '-10.00' },
          { accountId: uid(), assetId: 'USDT', direction: 'credit', amount: '10.00' },
        ],
        postedAt: ts,
      }),
    ).toThrow(EventValidationError);

    expect(() =>
      validatePayload('ledgerReconciliationFailed', {
        accountId: uid(),
        assetId: 'USDT',
        snapshotBalance: '1.00',
        replayBalance: '1.01',
        drift: '-0.01',
        module: 'ledger',
      }),
    ).not.toThrow();

    const loss = validatePayload('positionUpdated', {
      ...position,
      unrealizedPnl: '-137.5',
      realizedPnl: '-10.5',
      fundingPaid: '-0.004',
    });
    expect(loss.unrealizedPnl).toBe('-137.5');
    expect(loss.realizedPnl).toBe('-10.5');
  });
});

describe('bus', () => {
  it('validates on publish and refuses a malformed payload', async () => {
    const bus = new MemoryEventBus('svc-identity');
    await expect(
      // @ts-expect-error — deliberately wrong shape
      bus.publish('xpEarned', { userId: 'not-a-uuid', xpDelta: 'lots' }),
    ).rejects.toThrow(EventValidationError);
  });

  it('delivers a valid payload to subscribers', async () => {
    const bus = new MemoryEventBus('svc-trade');
    const seen: number[] = [];
    await bus.subscribe('xpEarned', (p) => void seen.push(p.xpDelta), { durable: 'rank-recalc' });

    await bus.publish('xpEarned', {
      userId: crypto.randomUUID(),
      sourceModule: 'trade',
      action: 'order.filled',
      xpDelta: 25,
    });

    expect(seen).toEqual([25]);
    expect(bus.emitted('xpEarned')).toHaveLength(1);
  });

  it('stamps a complete envelope', async () => {
    const bus = new MemoryEventBus('svc-ledger');
    const env = await bus.publish(
      'xpEarned',
      { userId: crypto.randomUUID(), sourceModule: 'p2p', action: 'trade.completed', xpDelta: 10 },
      { idempotencyKey: 'p2p-trade-42', correlationId: 'corr-1' },
    );
    expect(env.subject).toBe(EVENT_CATALOG.xpEarned.subject);
    expect(env.producer).toBe('svc-ledger');
    expect(env.idempotencyKey).toBe('p2p-trade-42');
    expect(env.correlationId).toBe('corr-1');
    expect(env.version).toBe(1);
    expect(() => new Date(env.occurredAt).toISOString()).not.toThrow();
  });

  it('round-trips an envelope through the wire codec', async () => {
    const bus = new MemoryEventBus('svc-ledger');
    const env = await bus.publish('userCreated', { userId: crypto.randomUUID(), handle: 'sovereign' });
    const decoded = decodeEnvelope(encodeEnvelope(env));
    expect(decoded).toEqual(env);
  });

  it('rejects a corrupted envelope on decode', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ id: 'nope', subject: 'x' }));
    expect(() => decodeEnvelope(bytes)).toThrow(/Malformed event envelope/);
  });
});

describe('schema drift: the bus refuses rather than strips', () => {
  const fill = (extra: Record<string, unknown> = {}) => ({
    marketId: 'btc-usdt',
    makerOrderId: crypto.randomUUID(),
    takerOrderId: crypto.randomUUID(),
    price: '64000.5',
    qty: '0.25',
    sequence: 41,
    ts: new Date().toISOString(),
    ...extra,
  });

  /**
   * THE DISEASE, demonstrated on plain zod so nobody has to take it on faith.
   *
   * This is what every consumer in this repo used to do with every payload, and
   * it is the whole of the `orderFilled` incident: an account id arrives, the
   * schema does not know the key, `success` is true, and the id is gone. No
   * throw, no log, no counter — the only evidence is a field that was there on
   * one side of the bus and not the other.
   */
  it('zod strips an unknown key silently — success: true, field gone', () => {
    const staleSchema = z.object({ marketId: z.string(), qty: z.string() });
    const result = staleSchema.safeParse({ marketId: 'btc-usdt', qty: '0.25', makerAccountId: 'house:market-maker' });

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('makerAccountId');
    // Nothing anywhere records that a field was dropped. That is the bug.
    expect(Object.keys(result.data!)).toEqual(['marketId', 'qty']);
  });

  it('refuses the payload instead, naming the dropped field and the producer', () => {
    expect(() => validatePayload('orderFilled', fill({ settlementAccountId: 'acct-1' }), 'svc-matching')).toThrow(EventSchemaDriftError);

    try {
      validatePayload('orderFilled', fill({ settlementAccountId: 'acct-1' }), 'svc-matching');
      expect.unreachable('drift must not pass');
    } catch (err) {
      const drift = err as EventSchemaDriftError;
      expect(drift.dropped).toEqual(['settlementAccountId']);
      // An error that says "somebody is stale" is a search. This one is a fix.
      expect(drift.message).toContain('svc-matching');
      expect(drift.message).toContain('settlementAccountId');
      expect(drift.message).toContain('intafaced.matching.order.filled');
    }
  });

  /**
   * The expensive shape. `entries[].accountId` is a double-entry line naming
   * whose money moved; a top-level-only check would call this payload clean.
   */
  it('catches a money-adjacent id dropped from INSIDE an array', () => {
    const entry = { accountId: crypto.randomUUID(), assetId: 'USDT', direction: 'debit' as const, amount: '10.00' };
    const posted = {
      txId: crypto.randomUUID(),
      module: 'trade',
      reason: 'trade.fill',
      hash: 'h1',
      previousHash: null,
      entries: [entry, { ...entry, direction: 'credit' as const, subAccountId: 'sub-7' }],
      postedAt: new Date().toISOString(),
    };

    try {
      validatePayload('ledgerTxPosted', posted, 'svc-ledger');
      expect.unreachable('nested drift must not pass');
    } catch (err) {
      expect(err).toBeInstanceOf(EventSchemaDriftError);
      expect((err as EventSchemaDriftError).dropped).toEqual(['entries[1].subAccountId']);
    }
  });

  it('reports every dropped path, not just the first', () => {
    expect(droppedPaths({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 2 } })).toEqual(['b.d']);
    expect(droppedPaths({ a: 1, b: 2 }, {})).toEqual(['a', 'b']);
  });

  // The other half of not crying wolf. Every one of these is a payload that
  // must keep working, and a drift check that fired on any of them would be
  // switched off within a day.
  it('does not fire on anything legitimate', () => {
    // Optional fields present.
    expect(() =>
      validatePayload('orderFilled', fill({ makerAccountId: 'house:market-maker', takerAccountId: crypto.randomUUID() })),
    ).not.toThrow();
    // Optional fields absent.
    expect(() => validatePayload('orderFilled', fill())).not.toThrow();
    // An explicit `undefined` is not a field the wire ever carried.
    expect(() => validatePayload('orderFilled', fill({ makerAccountId: undefined }))).not.toThrow();
    // A nullable field that is null.
    expect(() =>
      validatePayload('orderUpdated', {
        orderId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        marketId: 'btc-usdt',
        status: 'open',
        side: 'buy',
        type: 'limit',
        qty: '1',
        filledQty: '0',
        price: null,
        clientOrderId: null,
        ts: new Date().toISOString(),
      }),
    ).not.toThrow();
    // `z.record(z.string(), z.unknown())` is a declared open bag — its keys are not drift.
    expect(() =>
      validatePayload('xpEarned', {
        userId: crypto.randomUUID(),
        sourceModule: 'p2p',
        action: 'trade.completed',
        xpDelta: 10,
        meta: { tradeId: 'abc', anythingAtAll: { nested: true } },
      }),
    ).not.toThrow();
  });

  it('refuses on the wire too — a consumer never receives a stripped payload', async () => {
    const bus = new MemoryEventBus('svc-matching');
    const handler = vi.fn();
    await bus.subscribe('orderFilled', handler, { durable: 'drift-test' });

    await expect(bus.publish('orderFilled', fill({ settlementAccountId: 'acct-1' }) as never)).rejects.toThrow(EventSchemaDriftError);
    // Refused at the producer, so nothing was delivered half-formed either.
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * VERSION IS NOT THE ANSWER TO THIS, and the test says so out loud.
   *
   * The envelope has carried a `version` all along and the consume path never
   * looked at it. It does now — but `makerAccountId` was added as `.optional()`
   * at version 1, correctly, because the change was additive. So a version
   * comparison would have found the two sides in perfect agreement while one of
   * them was deleting a field the other sent. Version catches a DECLARED break;
   * drift catches an UNDECLARED one, and the undeclared one is the bug that cost
   * a day.
   */
  it('detects a version mismatch — which would NOT have caught the orderFilled bug', () => {
    const ahead = createEnvelope({
      subject: EVENT_CATALOG.orderFilled.subject,
      version: EVENT_CATALOG.orderFilled.version + 1,
      producer: 'svc-matching',
      idempotencyKey: 'k1',
      payload: fill(),
    }) as Envelope;

    expect(() => acceptEnvelope('orderFilled', ahead)).toThrow(EventVersionMismatchError);

    // Same fields, same version, one key this build does not know: version says
    // nothing, drift is the only thing that speaks.
    const same = createEnvelope({
      subject: EVENT_CATALOG.orderFilled.subject,
      version: EVENT_CATALOG.orderFilled.version,
      producer: 'svc-matching',
      idempotencyKey: 'k2',
      payload: fill({ makerAccountId: 'house:market-maker', settlementAccountId: 'acct-1' }),
    }) as Envelope;

    expect(() => acceptEnvelope('orderFilled', same)).not.toThrow(EventVersionMismatchError);
    expect(() => acceptEnvelope('orderFilled', same)).toThrow(EventSchemaDriftError);
  });

  /**
   * Subject is identity. A payload that validates under the *subscription's*
   * schema while the envelope names a different subject used to pass — the
   * gate checked version and drift, never the name on the wire. Same-shape
   * events (several carry only uuids + decimals) would then be accepted under
   * the wrong catalog entry.
   */
  it('refuses an envelope whose subject is not the one the subscription asked for', () => {
    const env = createEnvelope({
      subject: EVENT_CATALOG.orderCancelled.subject,
      version: 1,
      producer: 'svc-matching',
      idempotencyKey: 'wrong-subject',
      payload: fill(),
    }) as Envelope;

    expect(() => acceptEnvelope('orderFilled', env)).toThrow(EventSubjectMismatchError);
    try {
      acceptEnvelope('orderFilled', env);
      expect.unreachable('subject mismatch must not pass');
    } catch (err) {
      const mismatch = err as EventSubjectMismatchError;
      expect(mismatch.expectedSubject).toBe(EVENT_CATALOG.orderFilled.subject);
      expect(mismatch.envelopeSubject).toBe(EVENT_CATALOG.orderCancelled.subject);
      expect(mismatch.message).toContain('svc-matching');
    }
  });
});

describe('declared wiring sockets', () => {
  it('names only events that exist — a socket cannot outlive its event', () => {
    for (const socket of WIRING_SOCKETS) expect(EVENT_CATALOG).toHaveProperty(socket.event);
  });

  it('carries a reason substantial enough to be one', () => {
    for (const socket of WIRING_SOCKETS) {
      expect(socket.reason.trim().length, `${socket.event}/${socket.missing}`).toBeGreaterThanOrEqual(40);
      expect(socket.reason, `${socket.event}/${socket.missing}`).not.toMatch(/^(TODO|TBD|later|n\/a)/i);
    }
  });

  it('records at most one reason per end', () => {
    const keys = WIRING_SOCKETS.map((s) => `${s.event}::${s.missing}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * THE TWO FINDINGS THAT STARTED THIS ARE BOTH CLOSED.
   *
   * `bankMarginCalled` had no publisher anywhere and svc-bank publishes it now;
   * `xpEarned` had no consumer and svc-identity consumes it now. Both socket
   * entries are therefore gone, which is exactly what the old form of this
   * assertion was written to force: a socket must not outlive the gap it
   * describes, so the entry going and this flipping to `toBeNull()` are one
   * event, not two.
   */
  it('no longer records either of the two findings that started this — both ends are wired', () => {
    expect(wiringSocketReason('xpEarned', 'subscriber')).toBeNull();
    expect(wiringSocketReason('bankMarginCalled', 'publisher')).toBeNull();
    expect(wiringSocketReason('agentActionRejected', 'subscriber')).toBeNull();
    expect(wiringSocketReason('agentActionCompleted', 'subscriber')).toBeNull();
    // And says nothing about ends that were always wired.
    expect(wiringSocketReason('bankMarginCalled', 'subscriber')).toBeNull();
    expect(wiringSocketReason('orderFilled', 'publisher')).toBeNull();
  });

  /**
   * THE CLASS IS THE POINT (ADR D-S-13).
   *
   * A written reason proves somebody thought about it; the class is where they
   * say what the answer was. `satisfies readonly WiringSocket[]` already makes a
   * missing class a compile error — this asserts the runtime value too, because
   * `tooling/ci/event-wiring.mjs` parses this file as TEXT, and a rule that only
   * one of those two readers enforces is a rule with a hole in it.
   */
  it('classifies every socket A, B or C', () => {
    for (const socket of WIRING_SOCKETS) {
      expect(['A', 'B', 'C'], `${socket.event}/${socket.missing}`).toContain(socket.class);
    }
  });

  /**
   * Class B is a DEFECT, not a socket. `crewMemberCreated` is the one that
   * remains: two consumers ADR D-S-13 puts on the owner rather than on an agent.
   *
   * THIS ASSERTION PREVIOUSLY READ `toEqual([])`, and it was wrong in the way
   * that matters. It was changed to empty alongside e1b95844, which added a
   * `crew-events.ts` to svc-academy and svc-agents and deleted the socket entry —
   * except NEITHER SUBSCRIBER IS MOUNTED. Nothing imports either file outside its
   * own unit test, and svc-academy has no bus connection at all. So this test
   * spent two days asserting, in the same file as the catalog it guards, that a
   * defect had been fixed by code that has never run. A test written to match a
   * wrong answer is worse than no test: it is a second voice agreeing.
   *
   * Pinned by name and in order, matching `CLASS_B_AWAITING_A_DECISION` in
   * `tooling/ci/event-wiring.mjs` — so quietly downgrading it to A to make the
   * gate green fails here as well as there. Two readers, one rule.
   */
  it('records exactly the Class B wiring defects that are pinned for a named decision', () => {
    const b = WIRING_SOCKETS.filter((s) => s.class === 'B').map((s) => `${s.event}::${s.missing}`);
    expect(b).toEqual(['crewMemberCreated::subscriber']);
  });
});

describe('§10 consumer idempotency', () => {
  it('processes a redelivered envelope exactly once', async () => {
    const bus = new MemoryEventBus('svc-identity');
    const store = new MemorySeenStore();
    const handler = vi.fn();
    await bus.subscribe('xpEarned', idempotent(handler, store, 'rank-recalc'), { durable: 'rank-recalc' });

    const payload = { userId: crypto.randomUUID(), sourceModule: 'academy', action: 'cert.earned', xpDelta: 500 };
    await bus.publish('xpEarned', payload, { idempotencyKey: 'cert-99' });
    await bus.publish('xpEarned', payload, { idempotencyKey: 'cert-99' });
    await bus.publish('xpEarned', payload, { idempotencyKey: 'cert-100' });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  /**
   * A failure is not a completion. The success mark is written only after the
   * handler returns, so a redelivery runs it again. Before this, `checkAndSet`
   * marked on arrival, a thrown handler was already recorded as processed, and
   * the redelivery was swallowed and acked: at-most-once, silently.
   *
   * That mattered most where a throw is the design. `svc-identity/src/events.ts`
   * documents an XP award for an unknown user as an FK violation "which throws,
   * which NAKs, which parks the message after `max_deliver`" — the alternative
   * being that "XP silently vanishes, which is precisely the failure this wiring
   * exists to end". Nothing could park while the first retry was eaten here.
   */
  it('re-runs a redelivered envelope whose handler threw — a failure is not a completion', async () => {
    const store = new MemorySeenStore();
    let attempts = 0;
    const wrapped = idempotent(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient: downstream was down');
      },
      store,
      'rank-recalc',
    );

    const payload = { userId: crypto.randomUUID(), sourceModule: 'academy', action: 'cert.earned', xpDelta: 500 };
    const envelope = { subject: 'xpEarned', idempotencyKey: 'cert-retry-1' } as never;

    // First delivery throws, and the throw must reach the bus so it can NAK.
    await expect(wrapped(payload as never, envelope)).rejects.toThrow('transient');

    // Redelivery actually runs the handler again.
    await wrapped(payload as never, envelope);
    expect(attempts).toBe(2);

    // ...and now that it succeeded, a further redelivery is deduped as before.
    await wrapped(payload as never, envelope);
    expect(attempts).toBe(2);
  });

  it('a mark left behind without a success does not return without running the handler', async () => {
    const store = new MemorySeenStore();
    const scope = 'fill-settle';
    const envelope = { subject: 'xpEarned', idempotencyKey: 'fill-crash-1' } as never;
    // Crash after checkAndSet: the seen-key is marked and the handler never succeeded.
    await store.checkAndSet(`${scope}:xpEarned:fill-crash-1`);

    let runs = 0;
    const wrapped = idempotent(
      async () => {
        runs += 1;
      },
      store,
      scope,
    );

    const outcome = await Promise.resolve(wrapped({} as never, envelope)).then(
      () => 'returned' as const,
      () => 'threw' as const,
    );

    // A normal return is an ack. That is only legal when this delivery ran the handler, or when it throws so the pump naks.
    expect(outcome === 'threw' || runs === 1).toBe(true);

    // An ack-wait redelivery must not return while the first attempt can still throw.
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const racing = idempotent(
      async () => {
        open();
        await blocked;
      },
      store,
      scope,
    );
    const live = { subject: 'xpEarned', idempotencyKey: 'fill-live-1' } as never;
    const first = racing({} as never, live);
    await opened;
    await expect(racing({} as never, live)).rejects.toThrow();
    unblock();
    await first;
  });

  it('keeps failing a handler that always throws, so it can exhaust max_deliver', async () => {
    const store = new MemorySeenStore();
    let attempts = 0;
    const wrapped = idempotent(
      async () => {
        attempts += 1;
        throw new Error('permanent: user does not exist');
      },
      store,
      'rank-recalc',
    );
    const envelope = { subject: 'xpEarned', idempotencyKey: 'cert-park-1' } as never;

    for (let i = 0; i < 5; i++) {
      await expect(wrapped({} as never, envelope)).rejects.toThrow('permanent');
    }

    // Every delivery reached the handler; none was silently acked on its behalf.
    expect(attempts).toBe(5);
  });

  it('does not acknowledge a duplicate from another wrapper while the first delivery later fails', async () => {
    const store = new MemorySeenStore();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let fail!: () => void;
    const waiting = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const firstHandler = vi.fn(async () => {
      started();
      await waiting;
      throw new Error('first failed');
    });
    const retryHandler = vi.fn(async () => undefined);
    const first = idempotent(firstHandler, store, 'rank-recalc');
    const duplicate = idempotent(retryHandler, store, 'rank-recalc');
    const envelope = { subject: 'xpEarned', idempotencyKey: 'concurrent-failure' } as never;
    const pending = first({} as never, envelope);
    const rejected = expect(pending).rejects.toThrow('first failed');
    await ready;
    await expect(duplicate({} as never, envelope)).rejects.toThrow('delivery still in flight');
    expect(retryHandler).not.toHaveBeenCalled();
    fail();
    await rejected;
    await duplicate({} as never, envelope);
    await duplicate({} as never, envelope);
    expect(retryHandler).toHaveBeenCalledTimes(1);
  });

  it('retries a failed commit without requiring a release method', async () => {
    const seen = new Set<string>();
    let commits = 0;
    const store = {
      checkAndSet: async (key: string) => seen.has(key),
      commit: async (key: string) => {
        if (++commits === 1) throw new Error('store unavailable');
        seen.add(key);
      },
    };
    const handler = vi.fn(async () => undefined);
    const wrapped = idempotent(handler, store, 'rank-recalc');
    const envelope = { subject: 'xpEarned', idempotencyKey: 'commit-failure' } as never;
    await expect(wrapped({} as never, envelope)).rejects.toThrow('store unavailable');
    await wrapped({} as never, envelope);
    await wrapped({} as never, envelope);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(commits).toBe(2);
  });

  it('JetStream pump naks in-flight and failed deliveries, then acks success and its redelivery', async () => {
    const payload = { userId: crypto.randomUUID(), sourceModule: 'academy', action: 'cert.earned', xpDelta: 500 };
    const data = encodeEnvelope(
      createEnvelope({
        subject: EVENT_CATALOG.xpEarned.subject,
        version: 1,
        producer: 'svc-academy',
        idempotencyKey: 'pump-failure',
        payload,
      }),
    );
    const messages = Array.from({ length: 4 }, () => ({ data, ack: vi.fn(), nak: vi.fn(), info: { redeliveryCount: 1 } }));
    let next = 0;
    const consumer = {
      consume: async () => {
        const message = messages[next++]!;
        return Object.assign(
          (async function* () {
            yield message;
          })(),
          { stop: vi.fn() },
        );
      },
    };
    const connection = {
      jetstream: () => ({ consumers: { get: async () => consumer } }),
      jetstreamManager: async () => ({ consumers: { add: async (_stream: string, config: unknown) => ({ config }) } }),
      drain: vi.fn(async () => undefined),
    };
    vi.resetModules();
    vi.doMock('nats', async () => ({ ...(await vi.importActual<typeof import('nats')>('nats')), connect: async () => connection }));
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { JetStreamEventBus } = await import('./jetstream-bus.js');
    const bus = await JetStreamEventBus.connect({ servers: 'nats://unused', producer: 'svc-identity' });
    try {
      const store = new MemorySeenStore();
      const failure = idempotent(
        async () => {
          started();
          await blocked;
          throw new Error('downstream failed');
        },
        store,
        'rank-recalc',
      );
      const handler = vi.fn(async () => undefined);
      const retry = idempotent(handler, store, 'rank-recalc');
      await bus.subscribe('xpEarned', failure, { durable: 'first' });
      await ready;
      await bus.subscribe('xpEarned', retry, { durable: 'concurrent' });
      await vi.waitFor(() => expect(messages[1]!.nak).toHaveBeenCalledOnce());
      expect(messages[1]!.ack).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      unblock();
      await vi.waitFor(() => expect(messages[0]!.nak).toHaveBeenCalledOnce());
      expect(messages[0]!.ack).not.toHaveBeenCalled();
      await bus.subscribe('xpEarned', retry, { durable: 'retry' });
      await vi.waitFor(() => expect(messages[2]!.ack).toHaveBeenCalledOnce());
      await bus.subscribe('xpEarned', retry, { durable: 'completed' });
      await vi.waitFor(() => expect(messages[3]!.ack).toHaveBeenCalledOnce());
      expect(handler).toHaveBeenCalledOnce();
      expect(messages[2]!.nak).not.toHaveBeenCalled();
      expect(messages[3]!.nak).not.toHaveBeenCalled();
    } finally {
      unblock();
      await bus.close();
      vi.doUnmock('nats');
      vi.resetModules();
    }
  });

  it('scopes dedupe per consumer, so two consumers each see the event', async () => {
    const bus = new MemoryEventBus('svc-identity');
    const store = new MemorySeenStore();
    const a = vi.fn();
    const b = vi.fn();
    await bus.subscribe('xpEarned', idempotent(a, store, 'rank-recalc'), { durable: 'rank-recalc' });
    await bus.subscribe('xpEarned', idempotent(b, store, 'xp-analytics'), { durable: 'xp-analytics' });

    await bus.publish(
      'xpEarned',
      { userId: crypto.randomUUID(), sourceModule: 'trade', action: 'order.filled', xpDelta: 5 },
      { idempotencyKey: 'fill-1' },
    );

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('bus defaults — single source of the numbers others pin against', () => {
  it('exports maxDeliver 5 and ack_wait 30s, with ns derived from ms', () => {
    // svc-notify hardcodes the same pair today (channel-store BUS_ACK_WAIT_MS,
    // stuck-grace pin). Exporting here is how a second copy stops being law.
    expect(DEFAULT_MAX_DELIVER).toBe(5);
    expect(ACK_WAIT_MS).toBe(30_000);
    expect(ACK_WAIT_NS).toBe(ACK_WAIT_MS * 1_000_000);
    expect(ACK_WAIT_NS).toBe(30_000_000_000);
  });
});

/**
 * CATALOG GROWTH — every event must accept a legal fixture and refuse a number
 * where money is a decimal string.
 *
 * Before this block, ~23 of 32 catalog entries had no `validatePayload` call
 * anywhere in this package's suite. A schema edit on an untested event could
 * ship green. The fixtures are the minimum legal shape, not product examples.
 */
function catalogFixtures(): { [K in EventName]: PayloadOf<K> } {
  const uid = () => crypto.randomUUID();
  const ts = () => new Date().toISOString();
  const addr = '0x' + 'a'.repeat(40);
  const bytes32 = '0x' + 'b'.repeat(64);
  const entry = (direction: 'debit' | 'credit') => ({
    accountId: uid(),
    assetId: 'USDT',
    direction,
    amount: '10.00',
  });

  return {
    xpEarned: { userId: uid(), sourceModule: 'trade', action: 'order.filled', xpDelta: 1 },
    rankUpdated: { userId: uid(), rank: 2, previousRank: 1, xp: '100' },
    userCreated: { userId: uid(), handle: 'sovereign' },
    kycApproved: { userId: uid(), tier: 'basic', jurisdiction: 'SG' },
    kycSubmitted: { userId: uid(), caseId: uid(), version: 1, previousCaseId: null, submittedAt: ts() },
    kycRejected: { userId: uid(), caseId: uid(), version: 2, reasonCode: 'doc_blurry', rejectedAt: ts() },
    kycInfoRequested: { userId: uid(), caseId: uid(), version: 2, reasonCode: 'need_address', requestedAt: ts() },
    securityFactorChanged: { userId: uid(), change: 'totp_replaced', changedAt: ts(), noticeKey: 'factor-changed:u:1' },
    deathNoticeCreated: { userId: uid(), noticeId: uid(), at: ts() },
    deathNoticeConfirmed: { userId: uid(), noticeId: uid(), at: ts() },
    ledgerTxPosted: {
      txId: uid(),
      module: 'trade',
      reason: 'trade.fill',
      hash: 'h1',
      previousHash: null,
      entries: [entry('debit'), entry('credit')],
      postedAt: ts(),
    },
    ledgerReconciliationFailed: {
      accountId: uid(),
      assetId: 'USDT',
      snapshotBalance: '1.00',
      replayBalance: '0.99',
      drift: '0.01',
      module: 'ledger',
    },
    ledgerReconciliationRunFailed: {
      errorCode: '57014',
      phase: 'proof',
      consecutiveIncomplete: 1,
      runId: null,
    },
    ledgerFreezeUpdated: {
      frozen: true,
      reason: 'reconciliation drift',
      actor: 'reconciliation',
      changedAt: ts(),
    },
    coreOpsAlertRuleUpdated: {
      ruleId: uid(),
      version: 1,
      change: 'created',
      actor: uid(),
      changedAt: ts(),
    },
    coreOpsAlertOpened: {
      ruleId: uid(),
      instance: 'a'.repeat(64),
      epoch: 0,
      state: 'firing',
      openedAt: ts(),
    },
    coreOpsAlertResolved: {
      ruleId: uid(),
      instance: 'a'.repeat(64),
      epoch: 0,
      resolvedAt: ts(),
    },
    coreOpsAlertPolicyUpdated: { version: 1, actor: uid(), changedAt: ts() },
    coreOpsAlertGroupOpened: { groupId: 'g1', chainId: null, labels: ['team:ops'], openedAt: ts() },
    coreOpsAlertGroupUpdated: { groupId: 'g1', action: 'acknowledged', sequence: 1, actor: uid(), changedAt: ts() },
    coreOpsAlertGroupResolved: { groupId: 'g1', sequence: 1, actor: 'auto', resolvedAt: ts() },
    coreOpsReconciliationAlertOpened: {
      alertId: uid(),
      sequence: 1,
      controlId: uid(),
      runId: uid(),
      assetId: 'ETH',
      periodStart: ts(),
      periodEnd: ts(),
      cause: 'fail',
      team: 'finance',
      openedAt: ts(),
    },
    coreOpsReconciliationAlertUpdated: {
      alertId: uid(),
      sequence: 2,
      transition: 'acknowledged',
      state: 'acknowledged',
      actor: uid(),
      changedAt: ts(),
    },
    coreOpsReconciliationAlertResolved: {
      alertId: uid(),
      sequence: 3,
      resolution: 'auto',
      correctiveTxIds: [],
      passingRunId: uid(),
      actor: 'auto',
      resolvedAt: ts(),
    },
    coreOpsReconciliationAlertAccepted: {
      alertId: uid(),
      sequence: 4,
      requestedBy: uid(),
      approvedBy: uid(),
      evidenceHash: 'b'.repeat(64),
      noteHash: 'c'.repeat(64),
      acceptedAt: ts(),
    },
    coreOpsComplianceCaseCreated: {
      caseId: 'case-1',
      inboxId: 'inbox-1',
      kind: 'manual',
      subjectId: 'subject-1',
      createdAt: ts(),
    },
    coreOpsComplianceInboxUpdated: {
      inboxId: 'inbox-1',
      version: 1,
      change: 'defined',
      actor: 'operator-1',
      changedAt: ts(),
    },
    coreOpsRestoreStarted: {
      restoreNo: 'restore-1',
      actor: 'operator-1',
      cutOff: ts(),
      startedAt: ts(),
    },
    coreOpsRestoreCompleted: {
      restoreNo: 'restore-1',
      actor: 'operator-1',
      approverId: 'operator-2',
      completedAt: ts(),
    },
    coreOpsRestoreFailed: {
      restoreNo: 'restore-1',
      actor: 'operator-1',
      step: 'validate',
      code: 'ops.restore_watermarks_disagree',
      failedAt: ts(),
    },
    payCustodyAuditCreated: {
      entryKey: 'pay:withdrawal:requested:TEST-1',
      category: 'withdrawal',
      action: 'withdrawal.requested',
      actor: { type: 'user', id: 'user-1' },
      subjectUserId: 'user-1',
      clientContext: { ip: null, userAgent: null, apiKeyId: null },
      requestId: 'req-1',
      occurredAt: ts(),
    },
    payDepositCreditPosted: {
      depositId: uid(),
      userId: uid(),
      assetId: 'USDT',
      networkId: 'ethereum',
      amount: '100',
      txHash: `0x${'ab'.repeat(32)}`,
      ledgerTxId: uid(),
      creditedAt: ts(),
    },
    payWithdrawalStatusUpdated: {
      withdrawalId: uid(),
      userId: uid(),
      seq: 3,
      attempt: 0,
      from: 'held',
      to: 'broadcast',
      failureCode: null,
      occurredAt: ts(),
    },
    stakeCreated: {
      stakeId: uid(),
      userId: uid(),
      amount: '100.00',
      tier: 'flex',
      unlocksAt: null,
    },
    buybackExecuted: {
      runId: uid(),
      tokensBought: '1',
      tokensBurned: '0.5',
      tokensToRewards: '0.5',
      revenueWindow: { from: ts(), to: ts() },
    },
    bankMarginCalled: {
      loanId: uid(),
      userId: uid(),
      sequence: 1,
      ltvBps: 8000,
      cureCollateralAmount: '0.1',
      collateralAssetId: 'BTC',
      calledAt: ts(),
      graceExpiresAt: ts(),
    },
    blueprintCreated: {
      blueprintId: uid(),
      userId: uid(),
      engineVersion: '1',
      visibility: 'private',
    },
    blueprintDeleted: { blueprintId: uid(), userId: uid(), erasedAt: ts() },
    crewMemberCreated: {
      crewId: uid(),
      userId: uid(),
      role: 'anchor',
      crewSize: 2,
      matchRunId: uid(),
    },
    orderAccepted: { orderId: uid(), marketId: 'btc-usdt', sequence: 1 },
    orderFilled: {
      marketId: 'btc-usdt',
      makerOrderId: uid(),
      takerOrderId: uid(),
      price: '64000',
      qty: '0.1',
      sequence: 1,
      ts: ts(),
    },
    orderCancelled: { orderId: uid(), marketId: 'btc-usdt', remainingQty: '0.1', sequence: 1 },
    orderTriggered: {
      orderId: uid(),
      marketId: 'btc-usdt',
      sequence: 2,
      triggerBy: 'last',
      stopPrice: '60000',
      referencePrice: '59990',
      ts: ts(),
    },
    spreadFilled: {
      spreadId: 'btc-cal-dec-mar',
      makerOrderId: uid(),
      takerOrderId: uid(),
      makerAccountId: uid(),
      takerAccountId: uid(),
      takerSide: 'buy',
      price: '-25.5',
      qty: '1',
      sequence: 1,
      ts: ts(),
      legs: [
        { symbol: 'BTC/USDT-251226', takerSide: 'buy', qty: '1', price: '64000' },
        { symbol: 'BTC/USDT-260327', takerSide: 'sell', qty: '1', price: '64025.5' },
      ],
    },
    orderUpdated: {
      orderId: uid(),
      userId: uid(),
      marketId: 'btc-usdt',
      status: 'open',
      side: 'buy',
      type: 'limit',
      qty: '1',
      filledQty: '0',
      price: '100',
      clientOrderId: null,
      ts: ts(),
    },
    fillSettled: {
      fillId: uid(),
      orderId: uid(),
      userId: uid(),
      marketId: 'btc-usdt',
      side: 'buy',
      liquidity: 'taker',
      price: '100',
      qty: '1',
      quoteAmount: '100',
      feeAsset: 'USDT',
      feeAmount: '0.1',
      feeBps: 10,
      sequence: 1,
      ts: ts(),
    },
    positionUpdated: {
      positionId: uid(),
      userId: uid(),
      marketId: 'btc-usdt-perp',
      symbol: 'BTC/USDT:USDT',
      status: 'open',
      side: 'long',
      contracts: '1',
      entryPrice: '64000',
      markPrice: '64100',
      notional: '64000',
      leverage: '5',
      collateral: '12800',
      unrealizedPnl: '100',
      realizedPnl: '0',
      liquidationPrice: '50000',
      marginMode: 'cross',
      fundingPaid: '0',
      ts: ts(),
    },
    protocolAccountCreated: {
      chainId: 1,
      account: addr,
      owner: addr,
      userSalt: bytes32,
      txHash: bytes32,
    },
    protocolSessionKeyCreated: {
      chainId: 1,
      account: addr,
      sessionKey: addr,
      specHash: bytes32,
      validAfter: 0,
      validUntil: 9_999_999_999,
      spendLimitWei: '1000000000000000000',
      targets: [addr],
      selectors: ['0x12345678'],
      txHash: bytes32,
    },
    protocolSessionKeyCancelled: {
      chainId: 1,
      account: addr,
      sessionKey: addr,
      revokedBy: addr,
      txHash: bytes32,
    },
    agentActionCompleted: {
      sessionId: uid(),
      userId: uid(),
      agentId: 'a1',
      sequence: 0,
      kind: 'completion',
      task: 'chat',
      tool: null,
      inputTokens: 1,
      outputTokens: 1,
    },
    agentActionRejected: {
      sessionId: uid(),
      userId: uid(),
      agentId: 'a1',
      sequence: 0,
      refusalCode: 'agents.tool_not_declared',
      tool: null,
      task: null,
    },
    agentUsageSettled: {
      sessionId: uid(),
      userId: uid(),
      windowId: 'w1',
      amount: '0.01',
      assetId: 'USDT',
      chargeKey: 'agents.usage:w1',
    },
    agentUsageAlertCrossed: {
      alertKey: 'agents.usage_alert:a1:2026-10',
      userId: uid(),
      agentId: uid(),
      month: '2026-10',
      alertAt: '0.01',
      spent: '0.0102',
      assetId: 'USDT',
      email: false,
    },
    personalRequestCreated: {
      requestId: uid(),
      payerUserId: uid(),
      payeeHandle: 'ada',
      amount: '12.5',
      assetId: 'USDT',
      note: 'lunch',
      expiresAt: '2026-10-18T00:00:00.000Z',
      sequence: 1,
    },
    personalRequestSettled: {
      requestId: uid(),
      payeeUserId: uid(),
      payerHandle: 'bob',
      amount: '12.5',
      assetId: 'USDT',
      ledgerTxId: uid(),
    },
    personalTransferPosted: {
      transferId: 'send:u1:1',
      senderUserId: uid(),
      recipientUserId: uid(),
      amount: '12.5',
      assetId: 'USDT',
      ledgerTxId: uid(),
      postedAt: ts(),
    },
    personalRefundPosted: {
      refundId: 'r1',
      origTransferId: 'send:u1:1',
      refunderUserId: uid(),
      refundeeUserId: uid(),
      amount: '12.5',
      assetId: 'USDT',
      ledgerTxId: uid(),
      postedAt: ts(),
    },
    personalDisputeUpdated: {
      disputeId: 'dispute:u1:a1',
      activityId: 'a1',
      userId: uid(),
      counterpartyUserId: null,
      status: 'opened',
      sequence: 1,
      changedAt: ts(),
    },
    bankScheduledReminder: {
      noticeId: uid(),
      userId: uid(),
      scheduleId: uid(),
      occurrence: 3,
      dueAt: ts(),
      amount: '25',
      assetId: 'USDT',
      leadHours: 24,
    },
    bankScheduledFailed: {
      noticeId: uid(),
      userId: uid(),
      scheduleId: uid(),
      occurrence: 0,
      amount: '25',
      assetId: 'USDT',
      reasonCode: 'ledger.insufficient_funds',
      failedAt: ts(),
    },
    p2pOfferCreated: {
      offerId: uid(),
      makerId: uid(),
      side: 'sell',
      asset: 'BTC',
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: '64000',
      minAmount: '0.01',
      maxAmount: '1',
    },
    p2pEscrowLocked: {
      tradeId: uid(),
      offerId: uid(),
      sellerId: uid(),
      buyerId: uid(),
      asset: 'BTC',
      amount: '0.1',
      fiatCurrency: 'USD',
      fiatAmount: '6400',
      paymentDeadline: ts(),
    },
    p2pEscrowReleased: {
      tradeId: uid(),
      sellerId: uid(),
      buyerId: uid(),
      asset: 'BTC',
      amount: '0.1',
      fee: '0.001',
      resolvedBy: 'seller',
      releaseSeconds: 60,
    },
    p2pEscrowRefunded: {
      tradeId: uid(),
      sellerId: uid(),
      buyerId: uid(),
      asset: 'BTC',
      amount: '0.1',
      resolvedBy: 'timeout',
      reason: 'payment deadline',
    },
    p2pTradeDisputed: {
      tradeId: uid(),
      disputeId: uid(),
      openedBy: uid(),
      reason: 'no payment',
      moderatorDeadline: ts(),
    },
    p2pDisputeResolved: {
      disputeId: uid(),
      tradeId: uid(),
      moderatorId: 'system:p2p-backstop',
      resolution: 'refund',
      automatic: true,
    },
    p2pTradeExpired: {
      tradeId: uid(),
      from: 'awaiting_payment',
      outcome: 'refunded',
    },
    p2pTradeFiatSent: { tradeId: uid(), buyerId: uid(), sellerId: uid(), markedAt: ts() },
    p2pTradeReminderSent: { tradeId: uid(), n: 1, buyerId: uid(), sellerId: uid(), remindedAt: ts() },
    p2pOfferPaused: { instrumentId: uid(), makerId: uid(), methodId: 'sepa', offerIds: [uid()], reason: 'method_removed', pausedAt: ts() },
    p2pRemarkCaseOpened: { caseId: uid(), tradeId: uid(), reportedId: uid(), reporterRole: 'seller', openedAt: ts() },
    p2pChatMessageSent: { tradeId: uid(), messageId: uid(), senderId: uid(), recipientId: uid(), sentAt: ts() },
    p2pDisputeEscalated: {
      disputeId: uid(),
      tradeId: uid(),
      buyerId: uid(),
      sellerId: uid(),
      escalatedBy: uid(),
      escalatedAt: ts(),
    },
    p2pQuoteExpired: { quoteId: uid(), userId: uid(), expiredAt: ts() },
    copySkipped: { followId: 'follow-1', followerId: uid(), leaderId: uid(), leaderFillId: uid(), reason: 'paused', skippedAt: ts() },
    copyFailed: { followId: 'follow-1', followerId: uid(), leaderId: uid(), leaderFillId: uid(), reason: 'order_rejected', failedAt: ts() },
    copyStopped: { followId: 'follow-1', followerId: uid(), leaderId: uid(), reason: 'follower', closeOnly: true, stoppedAt: ts() },
    supportTicketResolved: {
      ticketId: uid(),
      userId: uid(),
      resolvedAt: ts(),
    },
    projectionUpdated: {
      marketId: 'IFC-USD',
      sequence: 1,
      fromSequence: 0,
      bids: [['100', '5']],
      asks: [['101', '2']],
    },
  };
}

describe('catalog fixtures — every event is exercised, money stays a string', () => {
  const fixtures = catalogFixtures();

  it('covers every catalog key exactly once', () => {
    const keys = Object.keys(fixtures).sort();
    const catalogKeys = Object.keys(EVENT_CATALOG).sort();
    expect(keys).toEqual(catalogKeys);
  });

  it.each(Object.keys(EVENT_CATALOG) as EventName[])('%s accepts its fixture', (name) => {
    expect(() => validatePayload(name, fixtures[name])).not.toThrow();
  });

  it.each([
    ['ledgerTxPosted', (p: PayloadOf<'ledgerTxPosted'>) => ({ ...p, entries: [{ ...p.entries[0]!, amount: 10 }, p.entries[1]!] })],
    ['stakeCreated', (p: PayloadOf<'stakeCreated'>) => ({ ...p, amount: 100 })],
    ['orderFilled', (p: PayloadOf<'orderFilled'>) => ({ ...p, price: 64000 })],
    ['fillSettled', (p: PayloadOf<'fillSettled'>) => ({ ...p, feeAmount: 0.1 })],
    ['positionUpdated', (p: PayloadOf<'positionUpdated'>) => ({ ...p, contracts: 1.25 })],
    ['agentUsageSettled', (p: PayloadOf<'agentUsageSettled'>) => ({ ...p, amount: 0.01 })],
    ['agentUsageAlertCrossed', (p: PayloadOf<'agentUsageAlertCrossed'>) => ({ ...p, spent: 0.0102 })],
    ['p2pEscrowLocked', (p: PayloadOf<'p2pEscrowLocked'>) => ({ ...p, amount: 0.1 })],
    ['bankMarginCalled', (p: PayloadOf<'bankMarginCalled'>) => ({ ...p, cureCollateralAmount: 0.1 })],
  ] as const)('%s refuses a JS number on a money field', (name, poison) => {
    // @ts-expect-error — deliberate number on a decimal-string field
    expect(() => validatePayload(name, poison(fixtures[name]))).toThrow(EventValidationError);
  });
});
