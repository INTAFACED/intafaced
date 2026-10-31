import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { signInChallengeMet, signInChallengeText, type SignInChallenge, type SignInChallengeProof } from '@intafaced/contracts';
import { ATTEMPT_POLICY } from './attempt-lockout.js';

/**
 * SELF-HOSTED SIGN-IN CHALLENGE (I-signin-sessions-30, J-identity-02 #2).
 *
 * The per-account lockout (attempt-lockout.ts) stops guessing at one account. It does not slow one address spraying many
 * accounts. So failed password sign-ins are also counted per address (a keyed hash of it, never the address itself), and
 * once an address reaches the owner's number of failures inside the password window, its next sign-in must carry a
 * solved proof of work. The owner's settings, all without defaults:
 *  - `afterFailures` (IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES): blank means EVERY sign-in from every address needs a
 *    challenge, the strictest reading of a blank (X-8).
 *  - `bits` (IDENTITY_SIGNIN_CHALLENGE_BITS) and `ttlSeconds` (IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS), and the signing
 *    key (IDENTITY_SIGNIN_CHALLENGE_KEY): with any blank no challenge can be issued, so a sign-in that needs one
 *    refuses `identity.challenge_unconfigured` (fail closed, never a skipped check). Without the key no address can be
 *    counted either, so every sign-in needs a challenge.
 *
 * A token is HMAC-signed, names its difficulty and expiry, and is spent once (`signin_challenges_used`). A challenge says
 * nothing about the identifier: it is asked for and checked before the account is looked up, and every failure counts
 * the same whether or not the account exists. `auth.challenge` is limited per address by the edge like every `/api` call.
 */
export type SignInChallengePolicy = {
  readonly afterFailures: number | null;
  readonly bits: number | null;
  readonly ttlSeconds: number | null;
  readonly key: string | null;
};

export type SignInChallengeCode =
  | 'auth.challenge_required'
  | 'auth.challenge_invalid'
  | 'auth.challenge_expired'
  | 'auth.challenge_used'
  | 'identity.challenge_unconfigured';

/** A sign-in let through to the password check; `settle` is called once with whether the password was wrong. */
export type SignInAdmission = { readonly settle: (wrongPassword: boolean) => Promise<void> };
const NO_RESERVATION: SignInAdmission = { settle: async () => undefined };

export class SignInChallengeError extends Error {
  constructor(readonly code: SignInChallengeCode) {
    super(code);
    this.name = 'SignInChallengeError';
  }
}

const VERSION = 'v1';
const MIN_KEY_LENGTH = 32;

function whole(raw: string | undefined, name: string, min: number, max: number): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Reads the owner's settings at start. A malformed value stops the service; a blank one stays blank. */
export function parseSignInChallengePolicy(env: {
  readonly IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES?: string | undefined;
  readonly IDENTITY_SIGNIN_CHALLENGE_BITS?: string | undefined;
  readonly IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS?: string | undefined;
  readonly IDENTITY_SIGNIN_CHALLENGE_KEY?: string | undefined;
}): SignInChallengePolicy {
  const key = env.IDENTITY_SIGNIN_CHALLENGE_KEY?.trim() || null;
  if (key !== null && key.length < MIN_KEY_LENGTH) {
    throw new Error(`IDENTITY_SIGNIN_CHALLENGE_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  }
  return {
    afterFailures: whole(env.IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES, 'IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES', 1, 1_000_000),
    bits: whole(env.IDENTITY_SIGNIN_CHALLENGE_BITS, 'IDENTITY_SIGNIN_CHALLENGE_BITS', 1, 24),
    ttlSeconds: whole(env.IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS, 'IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS', 10, 3600),
    key,
  };
}

export class SignInChallengeService {
  constructor(
    private readonly sql: Sql,
    readonly policy: SignInChallengePolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The settings still blank, for the ready report: the challenge works only when this is empty. */
  unset(): string[] {
    return [
      ...(this.policy.afterFailures === null ? ['IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES'] : []),
      ...(this.policy.bits === null ? ['IDENTITY_SIGNIN_CHALLENGE_BITS'] : []),
      ...(this.policy.ttlSeconds === null ? ['IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS'] : []),
      ...(this.policy.key === null ? ['IDENTITY_SIGNIN_CHALLENGE_KEY'] : []),
    ];
  }

  /** A fresh signed challenge. Refuses `identity.challenge_unconfigured` while the difficulty, lifetime or key is blank. */
  issue(): SignInChallenge {
    const { bits, ttlSeconds, key } = this.policy;
    if (bits === null || ttlSeconds === null || key === null) throw new SignInChallengeError('identity.challenge_unconfigured');
    const expiresAt = this.now().getTime() + ttlSeconds * 1000;
    const body = `${VERSION}.${expiresAt}.${bits}.${randomBytes(16).toString('base64url')}`;
    return { token: `${body}.${this.sign(key, body)}`, bits, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Called before the password is checked, and before the account is looked up. With a failure count set, it first
   * reserves this attempt on the address's count in one atomic upsert (reserve, then verify, as attempt-lockout.ts does),
   * so parallel guesses cannot all read a count under the threshold. An attempt past the owner's count, or every attempt
   * when the count is blank, must carry a good, unexpired, unspent challenge solved to the current difficulty, which this
   * spends. The answer's `settle` gives the reservation back unless the password was wrong: call it once with whether
   * the sign-in failed on the password.
   */
  async admit(address: string | undefined, proof: SignInChallengeProof | undefined): Promise<SignInAdmission> {
    const n = this.policy.afterFailures;
    const hash = this.addressHash(address);
    if (n === null || hash === null) {
      await this.spend(proof);
      return NO_RESERVATION;
    }
    const now = this.now();
    const windowStart = new Date(now.getTime() - ATTEMPT_POLICY.password.windowSeconds * 1000);
    const [row] = await this.sql<Array<{ failures: number }>>`
      INSERT INTO signin_address_failures (address_hash, window_started_at, failures)
      VALUES (${hash}, ${now}, 1)
      ON CONFLICT (address_hash) DO UPDATE SET
        failures = CASE WHEN signin_address_failures.window_started_at < ${windowStart} THEN 1
                        ELSE signin_address_failures.failures + 1 END,
        window_started_at = CASE WHEN signin_address_failures.window_started_at < ${windowStart} THEN ${now}
                                 ELSE signin_address_failures.window_started_at END
      RETURNING failures
    `;
    const admission: SignInAdmission = {
      settle: async (wrongPassword: boolean) => {
        if (!wrongPassword) await this.refund(hash);
      },
    };
    // `failures` counts this attempt too: the ones before it reached the owner's count, so this one needs a challenge.
    if ((row?.failures ?? 1) > n) {
      try {
        await this.spend(proof);
      } catch (err) {
        await admission.settle(false);
        throw err;
      }
    }
    return admission;
  }

  /** Verifies and spends one solved challenge, or refuses by its code. */
  private async spend(proof: SignInChallengeProof | undefined): Promise<void> {
    const { bits, ttlSeconds, key } = this.policy;
    if (bits === null || ttlSeconds === null || key === null) throw new SignInChallengeError('identity.challenge_unconfigured');
    if (!proof) throw new SignInChallengeError('auth.challenge_required');
    const parts = proof.token.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new SignInChallengeError('auth.challenge_invalid');
    const [, expiresRaw, bitsRaw, , mac] = parts as [string, string, string, string, string];
    const body = parts.slice(0, 4).join('.');
    const expected = Buffer.from(this.sign(key, body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new SignInChallengeError('auth.challenge_invalid');
    // A token minted before the owner raised the difficulty is not enough any more.
    if (Number(bitsRaw) < bits) throw new SignInChallengeError('auth.challenge_invalid');
    const expiresAt = Number(expiresRaw);
    if (!(expiresAt > this.now().getTime())) throw new SignInChallengeError('auth.challenge_expired');
    const digest = createHash('sha256').update(signInChallengeText(proof.token, proof.nonce)).digest();
    if (!signInChallengeMet(digest, Number(bitsRaw))) throw new SignInChallengeError('auth.challenge_invalid');
    const tokenHash = createHash('sha256').update(proof.token).digest('hex');
    const spent = await this.sql<Array<{ token_hash: string }>>`
      INSERT INTO signin_challenges_used (token_hash, used_at, expires_at)
      VALUES (${tokenHash}, ${this.now()}, ${new Date(expiresAt)})
      ON CONFLICT (token_hash) DO NOTHING
      RETURNING token_hash
    `;
    if (spent.length === 0) throw new SignInChallengeError('auth.challenge_used');
    // A bounded sweep of spent tokens past their lifetime; a used token past its expiry is refused as expired anyway.
    await this.sql`
      DELETE FROM signin_challenges_used
       WHERE token_hash IN (SELECT token_hash FROM signin_challenges_used WHERE expires_at < ${this.now()} LIMIT 100)
    `;
  }

  /** Gives one reserved attempt back: the sign-in did not fail on its password. */
  private async refund(hash: string): Promise<void> {
    const lowered = await this.sql`
      UPDATE signin_address_failures SET failures = failures - 1 WHERE address_hash = ${hash} AND failures > 1
    `;
    if (lowered.count === 0) await this.sql`DELETE FROM signin_address_failures WHERE address_hash = ${hash} AND failures <= 1`;
  }

  private addressHash(address: string | undefined): string | null {
    const key = this.policy.key;
    if (key === null) return null;
    return createHmac('sha256', key)
      .update(`address:${address ?? 'unknown'}`)
      .digest('hex');
  }

  private sign(key: string, body: string): string {
    return createHmac('sha256', key).update(`signin-challenge:${body}`).digest('base64url');
  }
}
