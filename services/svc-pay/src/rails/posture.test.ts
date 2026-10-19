import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { CardSandboxAdapter } from './card-sandbox.js';
import { CryptoNativeAdapter } from './crypto-native.js';
import { ChainNotConfiguredError, MemoryChain, UnconfiguredChain } from './chain-port.js';
import { RailRegistry } from './registry.js';
import { isLive, isSandbox, isUsable } from './rail-adapter.js';
import {
  PublicCheckoutUnavailable,
  RAIL_POSTURE_ENFORCED_ENVS,
  SandboxRailError,
  SandboxRailRefusal,
  assertRailMayAcceptPublicPayment,
  assertRailMayMoveValue,
  assertRailPosture,
  defaultChainFor,
  railPostureStatus,
  selectPublicCheckoutRail,
  selectPublicCheckoutRailDetailed,
  shouldRegisterCardSandbox,
  tryLiveChainFromEnv,
} from './posture.js';
import { TestnetSigner } from './evm-signer.js';
import { EvmLiveChain } from './evm-chain.js';
import { MemoryBroadcastStore } from './broadcast-store.js';

/**
 * RAILS THAT ARE HONEST ABOUT NOT BEING REAL.
 *
 * WHAT WAS WRONG. `index.ts` wired `new MemoryChain()` unconditionally and
 * registered `card-sandbox` beside it. Both declare `payout`. Nothing anywhere
 * distinguished a rail with a counterparty from a rail with a `Map`, so on any
 * deployment a user could call `withdrawal.create` with `railId: 'crypto-native'`
 * and be told `sent` against a transaction hash this process made up.
 *
 * WHAT EACH TEST HERE IS FOR. Every one of them fails if the platform regains
 * the ability to tell somebody their money moved when it did not. That is the
 * only bug in this service with no recovery path: it is not detectable from
 * inside the books, because a fabricated settlement satisfies double entry
 * exactly as well as a real one, and the user has been believing it the whole
 * time.
 */

const SECRET = 'posture-test-secret-at-least-32-chars-long';

const cardSandbox = () => new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
const cryptoOn = (chain: MemoryChain | UnconfiguredChain) =>
  new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });

/** A minimal live rail. There is no live adapter in the repo yet, so the test states one. */
const liveRail = () => {
  const adapter = cardSandbox();
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'mode') return 'live';
      if (prop === 'id') return 'live-acquirer-double';
      return Reflect.get(target, prop, receiver);
    },
  }) as CardSandboxAdapter;
};

const payout = {
  settlementId: 's-1:0',
  merchantId: '55555555-5555-4555-8555-555555555555',
  amount: amt('100'),
  assetId: 'USDT',
  window: 'w',
  destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000004' },
};

// ══ THE DECLARATION ═════════════════════════════════════════════════════════

describe('every rail says whether it is real', () => {
  it('card-sandbox is a sandbox, and there is no option that changes it', () => {
    expect(cardSandbox().mode).toBe('sandbox');
    // The counterparty is a Map in the same file. A flag would be a lie, so
    // there is no flag: a live card rail is a different adapter.
    expect(Object.keys(new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }))).not.toContain('live');
  });

  it('crypto-native is a SANDBOX when MemoryChain is behind it, whatever §13 says about day one', () => {
    // §13 reads "`crypto-native` is real from day one". True of the adapter,
    // false of this deployment — and the deployment is what a user's money
    // depends on. The adapter derives its answer from the port rather than
    // being told.
    expect(cryptoOn(new MemoryChain()).mode).toBe('sandbox');
  });

  /**
   * THE ONE PRE-EXISTING ASSERTION THIS CHANGE REWRITES, and it is rewritten
   * because it ENCODED THE DEFECT rather than a property.
   *
   * It read `expect(cryptoOn(new UnconfiguredChain()).mode).toBe('sandbox')`.
   * That was a true description of `RailMode` while `RailMode` had two members
   * and `crypto-native` collapsed the third into `sandbox` — which the ADR of
   * 2026-08-04 names a defect, running in the unsafe direction: absence read as
   * a working sandbox. Its done bar requires the distinction.
   *
   * The old test's TITLE was already the right law — "an absent chain is not a
   * live one" — and that half is asserted below, unchanged in force. What has
   * changed is that "not live" now has two answers instead of one, and an
   * absent chain gives the accurate one.
   */
  it('crypto-native is ABSENT with no chain — distinct from sandbox, and still not live', () => {
    const absent = cryptoOn(new UnconfiguredChain());
    expect(absent.mode).toBe('absent');

    // The property the rewrite must not weaken, asserted directly rather than
    // inferred from the string: absent is not live, and neither is sandbox.
    expect(isLive(absent)).toBe(false);
    expect(isLive(cryptoOn(new MemoryChain()))).toBe(false);
    expect(isSandbox(absent)).toBe(false);
  });

  it('reports an absent chain as UNHEALTHY, so routing and the console never offer it', () => {
    const absent = cryptoOn(new UnconfiguredChain());
    expect(absent.health().healthy).toBe(false);
    expect(isUsable(absent, new Date())).toBe(false);

    // A sandbox chain stays healthy on purpose: it genuinely works, which is
    // what CI needs. `mode` is what stops it moving real money, not health.
    expect(cryptoOn(new MemoryChain()).health().healthy).toBe(true);
  });
});

// ══ THE CHAIN THAT REFUSES ══════════════════════════════════════════════════

describe('UnconfiguredChain — refuses, never fabricates', () => {
  const chain = new UnconfiguredChain();

  it('NEVER RETURNS A TRANSACTION HASH', async () => {
    // The single most important assertion in this file. `MemoryChain.send`
    // answers `0xout00000001` and that string reaches the user as evidence
    // their withdrawal was sent.
    await expect(chain.send()).rejects.toBeInstanceOf(ChainNotConfiguredError);
  });

  it('refuses to derive an acceptance address rather than inviting a payer to send funds nowhere', async () => {
    await expect(chain.acceptanceAddress()).rejects.toBeInstanceOf(ChainNotConfiguredError);
  });

  it('THROWS rather than returning null for an inbound transfer', async () => {
    // Null means "the payer has not sent anything yet" — a fact about the payer.
    // This is a fact about us, and collapsing them leaves `authorize` reporting
    // `pending` forever on a rail that will never answer.
    await expect(chain.inboundTransfer()).rejects.toBeInstanceOf(ChainNotConfiguredError);
  });

  it('names what the owner must obtain, in the error a human will actually read', async () => {
    const err = await chain.send().catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/RPC provider/i);
    expect(err.message).toMatch(/signing keys/i);
    expect(err.message).toMatch(/PAY_MIN_CONFIRMATIONS/);
    expect(err.message).toMatch(/chain watcher/i);
  });

  it('turns into a rail FAILURE at the adapter, not an escaped exception', async () => {
    // What makes the refusal safe: `UserMoneyService` reverses the hold on a
    // failed result in the same call, so the user gets their money back. An
    // exception escaping the adapter would leave the hold in place.
    const result = await cryptoOn(chain).payout(payout);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    // NOT `chain.broadcast_failed`. That reads as transient and sends an
    // operator to look at a node that does not exist; nothing configured will
    // never fix itself.
    expect(result.failureCode).toBe('chain.not_configured');
    // And no reference was invented on the way out.
    expect(result.railRef).toBe('');
  });
});

// ══ THE BOOT GATE ═══════════════════════════════════════════════════════════

describe('assertRailPosture — the process refuses to start rather than mislead', () => {
  const sandboxRegistry = () => new RailRegistry([cardSandbox(), cryptoOn(new MemoryChain())]);

  it.each(RAIL_POSTURE_ENFORCED_ENVS)('REFUSES TO BOOT in APP_ENV=%s with a sandbox rail registered', (appEnv) => {
    expect(() => assertRailPosture(sandboxRegistry(), { APP_ENV: appEnv })).toThrow(SandboxRailError);
  });

  it('names every sandbox rail in the refusal, so the operator knows what to replace', () => {
    const err = (() => {
      try {
        assertRailPosture(sandboxRegistry(), { APP_ENV: 'prod' });
        return null;
      } catch (e) {
        return e as SandboxRailError;
      }
    })();

    expect(err).toBeInstanceOf(SandboxRailError);
    expect(err!.sandboxRails).toEqual(['card-sandbox', 'crypto-native']);
    // And what to obtain for each kind, because "get a live rail" is not
    // actionable and "get a sponsor bank" is.
    expect(err!.message).toMatch(/sponsor bank/i);
    expect(err!.message).toMatch(/conformance kit/i);
  });

  it('boots in dev and test — the sandbox rails ARE the fixture there', () => {
    for (const appEnv of ['dev', 'test']) {
      const posture = assertRailPosture(sandboxRegistry(), { APP_ENV: appEnv });
      expect(posture.policy).toBe('allow-sandbox');
      expect(posture.sandboxOverride).toBe(false);
    }
  });

  it('defaults to dev when APP_ENV is unset, rather than failing every local run', () => {
    expect(() => assertRailPosture(sandboxRegistry(), {})).not.toThrow();
  });

  it('boots in prod with only LIVE rails, and enforces live-only from then on', () => {
    const posture = assertRailPosture(new RailRegistry([liveRail()]), { APP_ENV: 'prod' });
    expect(posture.policy).toBe('live-only');
  });

  it('lets an operator override BY NAME, and records that they did', () => {
    // A pilot or a demo is legitimate. Doing it silently is not.
    const posture = assertRailPosture(sandboxRegistry(), { APP_ENV: 'prod', PAY_ALLOW_SANDBOX_RAILS: 'true' });
    expect(posture.policy).toBe('allow-sandbox');
    expect(posture.sandboxOverride).toBe(true);
  });

  it('does not accept anything other than the exact string "true" as an override', () => {
    for (const value of ['1', 'yes', 'TRUE', 'true ', '']) {
      expect(() => assertRailPosture(sandboxRegistry(), { APP_ENV: 'prod', PAY_ALLOW_SANDBOX_RAILS: value })).toThrow(SandboxRailError);
    }
  });
});

// ══ THE RUNTIME GATE ════════════════════════════════════════════════════════

describe('assertRailMayMoveValue — the second gate, because boot config drifts', () => {
  it('REFUSES A SANDBOX PAYOUT under live-only', () => {
    expect(() => assertRailMayMoveValue(cardSandbox(), 'payout', 'live-only')).toThrow(SandboxRailRefusal);
  });

  it('refuses a sandbox refund under live-only — a refund is value leaving too', () => {
    expect(() => assertRailMayMoveValue(cardSandbox(), 'refund', 'live-only')).toThrow(SandboxRailRefusal);
  });

  it('allows a live rail to do either', () => {
    expect(() => assertRailMayMoveValue(liveRail(), 'payout', 'live-only')).not.toThrow();
    expect(() => assertRailMayMoveValue(liveRail(), 'refund', 'live-only')).not.toThrow();
  });

  it('ALLOWS a sandbox authorize and capture even under live-only', () => {
    // Deliberate, and the asymmetry is the argument: authorize/capture bring
    // value IN. If a sandbox capture credits a merchant who was never paid, the
    // platform is short — caught by reconciling the rail boundary against real
    // custody, which is the figure that exists for it. Nobody has been told
    // their own money left.
    expect(() => assertRailMayMoveValue(cardSandbox(), 'authorize', 'live-only')).not.toThrow();
    expect(() => assertRailMayMoveValue(cardSandbox(), 'capture', 'live-only')).not.toThrow();
  });

  it('allows everything under allow-sandbox — dev and the whole test suite depend on it', () => {
    for (const capability of ['authorize', 'capture', 'refund', 'payout', 'webhook'] as const) {
      expect(() => assertRailMayMoveValue(cardSandbox(), capability, 'allow-sandbox')).not.toThrow();
    }
  });

  it('carries a machine-readable code, so the router can map it rather than parse prose', () => {
    const err = (() => {
      try {
        assertRailMayMoveValue(cardSandbox(), 'payout', 'live-only');
        return null;
      } catch (e) {
        return e as SandboxRailRefusal;
      }
    })();
    expect(err!.code).toBe('pay.rail_not_live');
    expect(err!.railId).toBe('card-sandbox');
    // States plainly that nothing was touched — the caller needs to know there
    // is nothing to unwind.
    expect(err!.message).toMatch(/no hold has been placed/i);
  });
});

// ══ WHAT AN OPERATOR IS TOLD ════════════════════════════════════════════════

describe('railPostureStatus — "how many rails can actually send money"', () => {
  it('separates live from sandbox, where the id list alone could not', () => {
    const status = railPostureStatus(new RailRegistry([cardSandbox(), liveRail()]), 'allow-sandbox');
    expect(status.live).toEqual(['live-acquirer-double']);
    expect(status.sandbox).toEqual(['card-sandbox']);
  });

  it('says out loud that a permitted sandbox fabricates its references', () => {
    const status = railPostureStatus(new RailRegistry([cardSandbox()]), 'allow-sandbox');
    expect(status.summary).toMatch(/SANDBOX RAILS MAY MOVE VALUE/);
    expect(status.summary).toMatch(/nothing leaves/i);
  });

  it('reports the refusal when the policy is live-only', () => {
    const status = railPostureStatus(new RailRegistry([cardSandbox()]), 'live-only');
    expect(status.summary).toMatch(/refused for payout and refund/);
  });

  it('is quiet when every rail is real — a clean posture needs no warning', () => {
    const status = railPostureStatus(new RailRegistry([liveRail()]), 'live-only');
    expect(status.sandbox).toEqual([]);
    expect(status.summary).toBe('rails: 1 live [live-acquirer-double], 0 sandbox');
  });
});

// ══ THE PRODUCTION WIRING ═══════════════════════════════════════════════════

describe('defaultChainFor — what index.ts actually gets', () => {
  it.each(RAIL_POSTURE_ENFORCED_ENVS)('gives APP_ENV=%s a chain that REFUSES, not one that simulates', (appEnv) => {
    const chain = defaultChainFor({ APP_ENV: appEnv });
    expect(chain.posture).toBe('absent');
    expect(chain).toBeInstanceOf(UnconfiguredChain);
  });

  it('gives dev and test the in-memory reference chain the suite is built on', () => {
    for (const appEnv of ['dev', 'test', undefined]) {
      const chain = defaultChainFor(appEnv === undefined ? {} : { APP_ENV: appEnv });
      expect(chain.posture).toBe('sandbox');
      expect(chain).toBeInstanceOf(MemoryChain);
    }
  });

  it('describes itself in one line an operator can read in a boot log', () => {
    expect(defaultChainFor({ APP_ENV: 'prod' }).description).toMatch(/NO CHAIN CONFIGURED/);
    expect(defaultChainFor({ APP_ENV: 'dev' }).description).toMatch(/no transaction reaches any chain/);
  });

  it('builds a LIVE EvmLiveChain when the full crypto config is present — even in prod', () => {
    const env = {
      APP_ENV: 'prod',
      PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
      PAY_CRYPTO_CHAIN_ID: '31337',
      PAY_CRYPTO_DEPOSIT_MNEMONIC: 'test test test test test test test test test test test junk',
      PAY_CRYPTO_SIGNER: 'testnet',
      PAY_CRYPTO_ASSETS: 'ETH:native',
      PAY_MIN_CONFIRMATIONS: '6',
    };
    const chain = defaultChainFor(env, new MemoryBroadcastStore(), TestnetSigner.ephemeral());
    expect(chain).toBeInstanceOf(EvmLiveChain);
    expect(chain.posture).toBe('live');
    expect(new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 1, toleranceSeconds: 300 }).mode).toBe('live');
  });

  it('REFUSES a live chain in staging/prod without a durable BroadcastStore', () => {
    const env = {
      APP_ENV: 'prod',
      PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
      PAY_CRYPTO_CHAIN_ID: '31337',
      PAY_CRYPTO_DEPOSIT_MNEMONIC: 'test test test test test test test test test test test junk',
      PAY_CRYPTO_SIGNER: 'testnet',
      PAY_CRYPTO_ASSETS: 'ETH:native',
      PAY_MIN_CONFIRMATIONS: '6',
    };
    expect(() => defaultChainFor(env)).toThrow(/durable BroadcastStore/);
    expect(() => tryLiveChainFromEnv(env)).toThrow(/durable BroadcastStore/);
    expect(() => defaultChainFor({ ...env, APP_ENV: 'staging' })).toThrow(/durable BroadcastStore/);
  });

  it('still builds a live chain in dev without an injected store (Memory fallback)', () => {
    const chain = defaultChainFor({
      APP_ENV: 'dev',
      PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
      PAY_CRYPTO_CHAIN_ID: '31337',
      PAY_CRYPTO_DEPOSIT_MNEMONIC: 'test test test test test test test test test test test junk',
      PAY_CRYPTO_SIGNER: 'testnet',
      PAY_CRYPTO_ASSETS: 'ETH:native',
      PAY_MIN_CONFIRMATIONS: '6',
    });
    expect(chain).toBeInstanceOf(EvmLiveChain);
    expect(chain.posture).toBe('live');
  });

  it('REFUSES a partial live config rather than quietly falling back to MemoryChain', () => {
    expect(() =>
      tryLiveChainFromEnv({
        PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
        // deliberately omit keys
      }),
    ).toThrow(/incomplete/i);
  });

  it('REFUSES a live chain when PAY_MIN_CONFIRMATIONS is blank — never settles as 6', () => {
    const env = {
      APP_ENV: 'dev',
      PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
      PAY_CRYPTO_CHAIN_ID: '31337',
      PAY_CRYPTO_DEPOSIT_MNEMONIC: 'test test test test test test test test test test test junk',
      PAY_CRYPTO_SIGNER: 'testnet',
      PAY_CRYPTO_ASSETS: 'ETH:native',
    };
    expect(() => tryLiveChainFromEnv(env)).toThrow(/PAY_MIN_CONFIRMATIONS is unset/);
    expect(() => tryLiveChainFromEnv({ ...env, PAY_MIN_CONFIRMATIONS: '' })).toThrow(/PAY_MIN_CONFIRMATIONS is unset/);
    expect(() => tryLiveChainFromEnv({ ...env, PAY_MIN_CONFIRMATIONS: '0' })).toThrow(/integer >= 1/);
  });

  it('accepts an owner-explicit PAY_MIN_CONFIRMATIONS=6', () => {
    const chain = tryLiveChainFromEnv({
      APP_ENV: 'dev',
      PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
      PAY_CRYPTO_CHAIN_ID: '31337',
      PAY_CRYPTO_DEPOSIT_MNEMONIC: 'test test test test test test test test test test test junk',
      PAY_CRYPTO_SIGNER: 'testnet',
      PAY_CRYPTO_ASSETS: 'ETH:native',
      PAY_MIN_CONFIRMATIONS: '6',
    });
    expect(chain).toBeInstanceOf(EvmLiveChain);
    expect(chain!.posture).toBe('live');
  });
});

describe('shouldRegisterCardSandbox', () => {
  it('defaults on in dev/test and off in staging/prod', () => {
    expect(shouldRegisterCardSandbox({ APP_ENV: 'dev' })).toBe(true);
    expect(shouldRegisterCardSandbox({ APP_ENV: 'test' })).toBe(true);
    expect(shouldRegisterCardSandbox({ APP_ENV: 'staging' })).toBe(false);
    expect(shouldRegisterCardSandbox({ APP_ENV: 'prod' })).toBe(false);
  });

  it('honours an explicit override', () => {
    expect(shouldRegisterCardSandbox({ APP_ENV: 'prod', PAY_REGISTER_CARD_SANDBOX: 'true' })).toBe(true);
    expect(shouldRegisterCardSandbox({ APP_ENV: 'dev', PAY_REGISTER_CARD_SANDBOX: 'false' })).toBe(false);
  });

  it('lets a prod deployment with ONLY a live crypto rail pass the boot posture gate', () => {
    const env = {
      APP_ENV: 'prod',
      PAY_CRYPTO_RPC_URL: 'http://127.0.0.1:8545',
      PAY_CRYPTO_CHAIN_ID: '31337',
      PAY_CRYPTO_DEPOSIT_MNEMONIC: 'test test test test test test test test test test test junk',
      PAY_CRYPTO_SIGNER: 'testnet',
      PAY_CRYPTO_ASSETS: 'ETH:native',
      PAY_MIN_CONFIRMATIONS: '6',
    };
    const chain = defaultChainFor(env, new MemoryBroadcastStore(), TestnetSigner.ephemeral());
    const rails = new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 1, toleranceSeconds: 300 })]);
    expect(rails.list()[0]!.mode).toBe('live');
    expect(() => assertRailPosture(rails, { APP_ENV: 'prod' })).not.toThrow();
    const status = railPostureStatus(rails, 'live-only');
    expect(status.live).toEqual(['crypto-native']);
    expect(status.sandbox).toEqual([]);
  });
});

// ══ THE PUBLIC INBOUND GATE ═════════════════════════════════════════════════
//
// `assertRailMayMoveValue` deliberately lets a SANDBOX authorize and capture
// through, and `rail-adapter.ts` argues for that: a sandbox capture leaves the
// PLATFORM short, reconciliation against the rail boundary is the figure that
// exists to catch it, and nobody has been told their own money left.
//
// THAT ARGUMENT ASSUMES THE PAYER IS THE MERCHANT'S OWN INTEGRATION. On a hosted
// checkout the payer is an anonymous third party shown "paid" by a page carrying
// our name, and the merchant is credited clearing they can settle and then
// withdraw — so a fabricated inbound becomes a real outbound one hop later.
// Every test below fails if the public surface loses the stricter gate.

describe('the public checkout gate', () => {
  it('lets a sandbox rail take a public payment in dev, where the sandbox IS the fixture', () => {
    expect(() => assertRailMayAcceptPublicPayment(cardSandbox(), 'allow-sandbox')).not.toThrow();
  });

  it('REFUSES a sandbox rail on the public surface under live-only', () => {
    expect(() => assertRailMayAcceptPublicPayment(cardSandbox(), 'live-only')).toThrow(PublicCheckoutUnavailable);
    expect(() => assertRailMayAcceptPublicPayment(cryptoOn(new MemoryChain()), 'live-only')).toThrow(PublicCheckoutUnavailable);
  });

  it('is STRICTER than the value-leaving gate, which is the entire point', () => {
    const sandbox = cardSandbox();
    // The merchant integration path: a sandbox authorize/capture is allowed,
    // because a sandbox capture only ever leaves the platform short.
    expect(() => assertRailMayMoveValue(sandbox, 'capture', 'live-only')).not.toThrow();
    expect(() => assertRailMayMoveValue(sandbox, 'authorize', 'live-only')).not.toThrow();
    // The same rail, the same policy, an anonymous payer: refused.
    expect(() => assertRailMayAcceptPublicPayment(sandbox, 'live-only')).toThrow(PublicCheckoutUnavailable);
  });

  it('lets a live rail through', () => {
    expect(() => assertRailMayAcceptPublicPayment(liveRail(), 'live-only')).not.toThrow();
  });

  it('carries a code a caller can branch on, and says nothing was created', () => {
    try {
      assertRailMayAcceptPublicPayment(cardSandbox(), 'live-only');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PublicCheckoutUnavailable);
      expect((err as PublicCheckoutUnavailable).code).toBe('pay.checkout_rail_not_live');
      expect((err as Error).message).toMatch(/no payment row exists/i);
    }
  });
});

describe('PAY_ALLOW_SANDBOX_RAILS does not reach the public checkout', () => {
  /**
   * The override's documented meaning is "no USER OF THIS DEPLOYMENT is being
   * told anything true about their money" — a statement an operator can make
   * about a pilot, a demo or a load test, because everyone it covers is inside
   * the exercise.
   *
   * A hosted checkout is reachable by STRANGERS who followed a link and agreed
   * to nothing. Their consent is not an operator's to give with an environment
   * variable, so the public path follows the ENVIRONMENT and not the flag.
   */
  it.each(RAIL_POSTURE_ENFORCED_ENVS)('keeps APP_ENV=%s public-live-only even with the override set', (appEnv) => {
    const posture = assertRailPosture(new RailRegistry([cardSandbox()]), {
      APP_ENV: appEnv,
      PAY_ALLOW_SANDBOX_RAILS: 'true',
    });

    // The override did what it says for payouts: the process booted, and a
    // sandbox may move value.
    expect(posture.sandboxOverride).toBe(true);
    expect(posture.policy).toBe('allow-sandbox');

    // And it did NOT reach the public surface.
    expect(posture.publicCheckoutPolicy).toBe('live-only');
    expect(() => assertRailMayAcceptPublicPayment(cardSandbox(), posture.publicCheckoutPolicy)).toThrow(PublicCheckoutUnavailable);
  });

  it('leaves dev and test alone, where the sandbox IS the fixture', () => {
    for (const appEnv of ['dev', 'test']) {
      const posture = assertRailPosture(new RailRegistry([cardSandbox()]), { APP_ENV: appEnv });
      expect(posture.publicCheckoutPolicy).toBe('allow-sandbox');
    }
  });
});

describe('selectPublicCheckoutRail', () => {
  it('walks the configured preference list, not the registry', () => {
    const live = liveRail();
    const rails = new RailRegistry([cryptoOn(new MemoryChain()), live]);
    // crypto-native is registered FIRST and is perfectly healthy. It is not
    // chosen, because the operator did not put it in the list — which is the
    // whole property that stops a caller ever selecting a rail.
    expect(selectPublicCheckoutRail(rails, [live.id], 'allow-sandbox').id).toBe(live.id);
  });

  it('skips a rail that cannot run the whole inbound lifecycle', () => {
    // `webhook` is the load-bearing capability: a rail that cannot deliver a
    // verified event has no way to tell us anything true, so a session on it
    // could only ever be completed by trusting the payer's own browser.
    const noWebhook = new Proxy(cardSandbox(), {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return ['authorize', 'capture'];
        if (prop === 'id') return 'no-webhook-rail';
        return Reflect.get(target, prop, receiver);
      },
    }) as CardSandboxAdapter;

    expect(() => selectPublicCheckoutRail(new RailRegistry([noWebhook]), ['no-webhook-rail'], 'allow-sandbox')).toThrow(
      PublicCheckoutUnavailable,
    );
  });

  it('skips a rail that is not answering rather than sending a payer to it', () => {
    const down = cardSandbox();
    down.setHealthy(false);
    try {
      selectPublicCheckoutRail(new RailRegistry([down]), ['card-sandbox'], 'allow-sandbox');
      throw new Error('should have refused');
    } catch (err) {
      expect((err as PublicCheckoutUnavailable).reason).toBe('unhealthy');
    }
  });

  it('refuses rather than falling back to a sandbox when live-only and only sandboxes exist', () => {
    const rails = new RailRegistry([cardSandbox(), cryptoOn(new MemoryChain())]);
    try {
      selectPublicCheckoutRail(rails, ['crypto-native', 'card-sandbox'], 'live-only');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PublicCheckoutUnavailable);
      expect((err as PublicCheckoutUnavailable).reason).toBe('sandbox');
      // No rail is named in the refusal that reaches a payer.
      expect((err as PublicCheckoutUnavailable).railId).toBeNull();
    }
  });

  it('refuses when the preference list names nothing that is registered', () => {
    try {
      selectPublicCheckoutRail(new RailRegistry([cardSandbox()]), ['some-future-acquirer'], 'allow-sandbox');
      throw new Error('should have refused');
    } catch (err) {
      expect((err as PublicCheckoutUnavailable).reason).toBe('none-configured');
      expect((err as PublicCheckoutUnavailable).code).toBe('pay.checkout_rails_unset');
    }
  });

  it('refuses an empty preference list as rails-unset, never as a live-rail outage', () => {
    try {
      selectPublicCheckoutRail(new RailRegistry([cardSandbox()]), [], 'allow-sandbox');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PublicCheckoutUnavailable);
      expect((err as PublicCheckoutUnavailable).reason).toBe('none-configured');
      expect((err as PublicCheckoutUnavailable).code).toBe('pay.checkout_rails_unset');
    }
  });

  it('names PSP-unset when the only public candidate is an absent acquirer', () => {
    const absent = new Proxy(cardSandbox(), {
      get(target, prop, receiver) {
        if (prop === 'id') return 'card-acquirer';
        if (prop === 'mode') return 'absent';
        return Reflect.get(target, prop, receiver);
      },
    }) as CardSandboxAdapter;
    try {
      selectPublicCheckoutRail(new RailRegistry([absent]), ['card-acquirer'], 'allow-sandbox');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PublicCheckoutUnavailable);
      expect((err as PublicCheckoutUnavailable).reason).toBe('psp-unset');
      expect((err as PublicCheckoutUnavailable).code).toBe('pay.psp_unset');
    }
  });

  /**
   * SPEC §5: log reason per decision. No cost/approval-rate invent — only the
   * existing skip taxonomy. Detailed walk records every preference entry.
   */
  it('records the full preference walk (chosen + skip reasons, no invented scores)', () => {
    const live = liveRail();
    const rails = new RailRegistry([cryptoOn(new MemoryChain()), live]);
    const decision = selectPublicCheckoutRailDetailed(rails, ['missing-rail', 'crypto-native', live.id], 'live-only');
    expect(decision.adapter.id).toBe(live.id);
    expect(decision.considered).toEqual([
      { railId: 'missing-rail', outcome: 'skipped', reason: 'not-registered' },
      { railId: 'crypto-native', outcome: 'skipped', reason: 'sandbox' },
      { railId: live.id, outcome: 'chosen' },
    ]);
    // No cost / approval / geo fields on the decision — inventing those is DIRECTION §8.
    for (const entry of decision.considered) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.outcome === 'chosen' ? ['outcome', 'railId'].sort() : ['outcome', 'railId', 'reason'].sort(),
      );
    }
  });
});
