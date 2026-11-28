/**
 * GET /ready must not hide KYC vault / ledger payout unwired behind argon2.
 * Key/URL set is config. This door does not fetch.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { partial } from '@intafaced/service-kit/testing';
import { MemoryAccrualStore } from './affiliates/accrual-store.js';
import { AFFILIATE_PRODUCER_PAYOUT_PATH, registerAffiliateProducerPayout } from './affiliates/producer-payout.js';
import type { AuthService } from './auth/auth-service.js';
import { BOOT_TIMEOUT_MS, bootIdentity, contextWith } from './boot.testkit.js';
import type { RankService } from './rank/rank-service.js';
import { createIdentityRouter } from './router.js';
import {
  KYC_VAULT_UNPROBED,
  KYC_VAULT_UNWIRED,
  LEDGER_PAYOUT_UNPROBED,
  LEDGER_PAYOUT_UNWIRED,
  flagEnvPin,
  identityReadyHonesty,
  kycVaultHonesty,
  ledgerPayoutHonesty,
} from './ready-honesty.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PAYOUT_SECRET = 'p'.repeat(32);

/** KYC tests hold flags still so /ready never silently drops them. */
const flagsNamed = {
  registrationOpen: true,
  waitlistEnabled: undefined as string | undefined,
  referralQueue: undefined as string | undefined,
  launchDrop: '0' as const,
};

describe('identity /ready honesty — key-set is not a live vault or ledger', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('names kyc_doc.unwired when IDENTITY_KYC_DOC_KEY is blank', () => {
    expect(kycVaultHonesty('')).toEqual({ status: 'absent', code: KYC_VAULT_UNWIRED });
    expect(kycVaultHonesty('   ')).toEqual({ status: 'absent', code: KYC_VAULT_UNWIRED });
    expect(kycVaultHonesty(undefined)).toEqual({ status: 'absent', code: KYC_VAULT_UNWIRED });
    expect(kycVaultHonesty(null)).toEqual({ status: 'absent', code: KYC_VAULT_UNWIRED });
  });

  it('nonempty KYC key is configured + unprobed, never a live vault', () => {
    expect(kycVaultHonesty('not-probed-key-material')).toEqual({
      status: 'configured',
      code: KYC_VAULT_UNPROBED,
    });
  });

  it('names affiliate.payout.ledger_unwired when LEDGER_URL is blank', () => {
    expect(ledgerPayoutHonesty('')).toEqual({ status: 'absent', code: LEDGER_PAYOUT_UNWIRED });
    expect(ledgerPayoutHonesty('   ')).toEqual({ status: 'absent', code: LEDGER_PAYOUT_UNWIRED });
    expect(ledgerPayoutHonesty(undefined)).toEqual({ status: 'absent', code: LEDGER_PAYOUT_UNWIRED });
    expect(ledgerPayoutHonesty(null)).toEqual({ status: 'absent', code: LEDGER_PAYOUT_UNWIRED });
  });

  it('nonempty LEDGER_URL is configured + unprobed, never a live payout', () => {
    expect(ledgerPayoutHonesty('http://svc-ledger:4001')).toEqual({
      status: 'configured',
      code: LEDGER_PAYOUT_UNPROBED,
    });
  });

  it('/ready.ready is process liveness, not key-set or URL-set', () => {
    const blank = identityReadyHonesty({ kycDocKey: '', ledgerUrl: undefined, ...flagsNamed });
    const set = identityReadyHonesty({
      kycDocKey: 'not-probed-key-material',
      ledgerUrl: 'http://svc-ledger:4001',
      ...flagsNamed,
    });
    expect(blank.ready).toBe(true);
    expect(set.ready).toBe(true);
    expect(blank.ready).toBe(set.ready);
    expect(blank.kycVault.status).not.toBe(set.kycVault.status);
    expect(blank.ledgerPayout.status).not.toBe(set.ledgerPayout.status);
    expect(blank.kycVault).toEqual({ status: 'absent', code: KYC_VAULT_UNWIRED });
    expect(blank.ledgerPayout).toEqual({ status: 'absent', code: LEDGER_PAYOUT_UNWIRED });
    expect(set.kycVault).toEqual({ status: 'configured', code: KYC_VAULT_UNPROBED });
    expect(set.ledgerPayout).toEqual({ status: 'configured', code: LEDGER_PAYOUT_UNPROBED });
  });

  it('GET /ready names unwired planes when key and URL are blank', async () => {
    const app = Fastify({ logger: false });
    app.get('/ready', async () => ({
      ...identityReadyHonesty({ kycDocKey: '', ledgerUrl: undefined, ...flagsNamed }),
      argon2: true,
    }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ready).toBe(true);
    expect(body.argon2).toBe(true);
    expect(body.kycVault).toEqual({ status: 'absent', code: KYC_VAULT_UNWIRED });
    expect(body.ledgerPayout).toEqual({ status: 'absent', code: LEDGER_PAYOUT_UNWIRED });
    expect(JSON.stringify(body)).not.toMatch(/"wired"\s*:\s*true/);
  });

  it('GET /ready names configured + unprobed when key and URL are set — not live', async () => {
    const app = Fastify({ logger: false });
    app.get('/ready', async () => ({
      ...identityReadyHonesty({
        kycDocKey: 'not-probed-key-material',
        ledgerUrl: 'http://svc-ledger:4001',
        ...flagsNamed,
      }),
      argon2: false,
    }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ready).toBe(true);
    expect(body.argon2).toBe(false);
    expect(body.kycVault).toEqual({ status: 'configured', code: KYC_VAULT_UNPROBED });
    expect(body.ledgerPayout).toEqual({ status: 'configured', code: LEDGER_PAYOUT_UNPROBED });
  });

  it('unwired codes match the refuse strings already on the procedures', async () => {
    expect(KYC_VAULT_UNWIRED).toBe('kyc_doc.unwired');
    expect(LEDGER_PAYOUT_UNWIRED).toBe('affiliate.payout.ledger_unwired');
    // A router with no vault refuses the vault doors with the code /ready names.
    const router = createIdentityRouter(partial<AuthService>({}), partial<RankService>({}), {});
    const op = router.createCaller(await contextWith(['admin:compliance'], { mfa: true }));
    const listed = await op.kyc.listDocuments({ userId: USER, limit: 10 }).catch((e: unknown) => e);
    expect(listed).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(String((listed as Error).message)).toContain(KYC_VAULT_UNWIRED);
    // The payout door with no ledger answers the code /ready names.
    const app = Fastify({ logger: false });
    registerAffiliateProducerPayout(app, {
      internalSecret: PAYOUT_SECRET,
      freeze: { frozenIds: async () => new Set<string>() },
      accounts: { accountState: async () => null } as never,
      accruals: new MemoryAccrualStore(),
      accrualTierLaw: { published: true, tiers: [{ hop: 0, rate: '0.130' }] },
      programmeDepth: 5,
      ledger: undefined,
    });
    await app.ready();
    apps.push(app);
    const body = JSON.stringify({ feeEventId: 'fee-evt-ready-honesty' });
    const res = await app.inject({
      method: 'POST',
      url: AFFILIATE_PRODUCER_PAYOUT_PATH,
      headers: { ...serviceAuthHeadersForBody('svc-trade', PAYOUT_SECRET, body), 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.json()).toMatchObject({ code: LEDGER_PAYOUT_UNWIRED });
  });

  it(
    'the booted GET /ready serves the honesty helpers from env, not argon2-only ready',
    async () => {
      const ready = async (env: Record<string, string | undefined>) => {
        const { app } = await bootIdentity(env);
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(200);
        return res.json() as Record<string, unknown>;
      };
      const blank = await ready({ IDENTITY_KYC_DOC_KEY: undefined, LEDGER_URL: undefined });
      expect(blank).toMatchObject({
        ready: true,
        kycVault: { status: 'absent', code: KYC_VAULT_UNWIRED },
        ledgerPayout: { status: 'absent', code: LEDGER_PAYOUT_UNWIRED },
      });
      expect(typeof blank.argon2).toBe('boolean');
      // Set is configured and unprobed: /ready does not call the ledger (nothing listens at this address) or open the vault.
      const set = await ready({ IDENTITY_KYC_DOC_KEY: Buffer.alloc(32, 7).toString('base64'), LEDGER_URL: 'http://127.0.0.1:1' });
      expect(set).toMatchObject({
        ready: true,
        kycVault: { status: 'configured', code: KYC_VAULT_UNPROBED },
        ledgerPayout: { status: 'configured', code: LEDGER_PAYOUT_UNPROBED },
      });
    },
    BOOT_TIMEOUT_MS,
  );
});

describe('identity /ready honesty — registration / waitlist env pins', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('flagEnvPin is the env pin, not drop-clock isEnabled', () => {
    expect(flagEnvPin(undefined)).toBeNull();
    expect(flagEnvPin(null)).toBeNull();
    expect(flagEnvPin('on')).toBe(true);
    expect(flagEnvPin('true')).toBe(true);
    expect(flagEnvPin('1')).toBe(true);
    expect(flagEnvPin('yes')).toBe(true);
    expect(flagEnvPin('ON')).toBe(true);
    expect(flagEnvPin('off')).toBe(false);
    expect(flagEnvPin('')).toBeNull();
    expect(flagEnvPin('   ')).toBeNull();
    expect(flagEnvPin('0')).toBe(false);
    expect(flagEnvPin('false')).toBe(false);
    expect(flagEnvPin('no')).toBe(false);
    expect(flagEnvPin('maybe')).toBe(false);
  });

  it('a blank compose pin is not reported as waitlist off', () => {
    const body = identityReadyHonesty({
      kycDocKey: '',
      ledgerUrl: undefined,
      registrationOpen: true,
      waitlistEnabled: '',
      referralQueue: '   ',
      launchDrop: '0',
    });
    expect(body.waitlistEnabled).toBeNull();
    expect(body.referralQueue).toBeNull();
    expect(body.launchDrop).toBe('0');
  });

  it('registrationOpen closed is named while ready stays true', () => {
    const body = identityReadyHonesty({
      kycDocKey: '',
      ledgerUrl: undefined,
      registrationOpen: false,
      waitlistEnabled: 'off',
      referralQueue: 'off',
      launchDrop: '0',
    });
    expect(body.ready).toBe(true);
    expect(body.registrationOpen).toBe(false);
    expect(body.waitlistEnabled).toBe(false);
    expect(body.referralQueue).toBe(false);
    expect(body.launchDrop).toBe('0');
  });

  it('unset registrationOpen is null — not invented open', () => {
    const body = identityReadyHonesty({
      kycDocKey: '',
      ledgerUrl: undefined,
      registrationOpen: undefined,
      waitlistEnabled: undefined,
      referralQueue: undefined,
      launchDrop: '0',
    });
    expect(body.ready).toBe(true);
    expect(body.registrationOpen).toBeNull();
  });

  it('unset waitlist/referral pins are null — not invented on', () => {
    const body = identityReadyHonesty({
      kycDocKey: '',
      ledgerUrl: undefined,
      registrationOpen: true,
      waitlistEnabled: undefined,
      referralQueue: undefined,
      launchDrop: 'III',
    });
    expect(body.registrationOpen).toBe(true);
    expect(body.waitlistEnabled).toBeNull();
    expect(body.referralQueue).toBeNull();
    expect(body.launchDrop).toBe('III');
  });

  it('GET /ready names registration closed + waitlist pins + drop', async () => {
    const app = Fastify({ logger: false });
    app.get('/ready', async () => ({
      ...identityReadyHonesty({
        kycDocKey: '',
        ledgerUrl: undefined,
        registrationOpen: false,
        waitlistEnabled: 'on',
        referralQueue: 'off',
        launchDrop: 'I',
      }),
      argon2: true,
    }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ready).toBe(true);
    expect(body.argon2).toBe(true);
    expect(body.registrationOpen).toBe(false);
    expect(body.waitlistEnabled).toBe(true);
    expect(body.referralQueue).toBe(false);
    expect(body.launchDrop).toBe('I');
  });

  it(
    'the booted GET /ready pins the actual env, not JWT/TOTP/max-subs',
    async () => {
      const { app } = await bootIdentity({
        REGISTRATION_OPEN: 'false',
        INTAFACED_FLAG_WAITLIST_ENABLED: 'on',
        INTAFACED_FLAG_REFERRAL_QUEUE: 'off',
        LAUNCH_DROP: 'I',
        JWT_ACCESS_TTL_SECONDS: '600',
        IDENTITY_MAX_SUB_ACCOUNTS: '7',
      });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ready: true, registrationOpen: false, waitlistEnabled: true, referralQueue: false, launchDrop: 'I' });
      // The pins are the env as set, not the drop clock: unset, they are null.
      const unset = (
        await (
          await bootIdentity({
            REGISTRATION_OPEN: undefined,
            INTAFACED_FLAG_WAITLIST_ENABLED: undefined,
            INTAFACED_FLAG_REFERRAL_QUEUE: undefined,
          })
        ).app.inject({ method: 'GET', url: '/ready' })
      ).json() as Record<string, unknown>;
      expect(unset).toMatchObject({ registrationOpen: null, waitlistEnabled: null, referralQueue: null });
      // Token lifetimes, TOTP, WebAuthn and the sub-account cap are not readiness.
      expect(JSON.stringify(body)).not.toMatch(/jwt|totp|webauthn|maxSub|max_sub/i);
    },
    BOOT_TIMEOUT_MS,
  );
});
