import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { generateToken, hashToken } from '../auth/passwords.js';
import { assertLeavesAWayIn, lockedSigninMethods, SigninMethodError } from '../auth/signin-methods.js';

/**
 * Social and wallet-linked sign-in, account side (I-signin-sessions-21).
 *
 * The outside call is a port. With no provider registered every start answers the allowlisted
 * `idp.social`; a provider with part of its settings answers a config refusal, never a half-working
 * sign-in. A provider's email never links, creates or signs in an account: the only way in is an
 * identity already linked from a signed-in session. No provider token is stored. A flow state is
 * single-use and bound to the provider and the purpose it was started for.
 */

export const IDP_SOCIAL = 'idp.social' as const;

export type SocialErrorCode =
  | typeof IDP_SOCIAL
  | 'identity.social_provider_config_incomplete'
  | 'identity.social_flow_ttl_unset'
  | 'identity.social_flow_invalid'
  | 'identity.social_exchange_failed'
  | 'identity.social_not_linked'
  | 'identity.provider_taken'
  | 'identity.last_signin_method'
  | 'auth.not_found';

export class SocialError extends Error {
  constructor(
    message: string,
    readonly code: SocialErrorCode,
  ) {
    super(message);
    this.name = 'SocialError';
  }
}

export type SocialProfile = {
  /** The provider's stable id for the person. */
  readonly subject: string;
  readonly email?: string | undefined;
  readonly emailVerified?: boolean | undefined;
  /** A hide-my-email relay address, stored as given. */
  readonly relayEmail?: string | undefined;
};

export interface SocialProviderPort {
  authorizationUrl(input: { state: string }): string;
  exchange(input: { code: string }): Promise<SocialProfile>;
}

export type SocialProviderEntry =
  { readonly status: 'ready'; readonly port: SocialProviderPort } | { readonly status: 'incomplete'; readonly missing: readonly string[] };

export interface SocialSigninDeps {
  readonly providers: ReadonlyMap<string, SocialProviderEntry>;
  /** Owner-published lifetime of a flow. Unset refuses a start. */
  readonly flowTtlSeconds: number | undefined;
  readonly now?: () => Date;
}

export class SocialSignin {
  constructor(
    private readonly sql: Sql,
    private readonly deps: SocialSigninDeps,
  ) {}

  private entry(provider: string): SocialProviderEntry & { status: 'ready' } {
    const found = this.deps.providers.get(provider);
    if (!found)
      throw new SocialError(
        'Sign-in with another account provider needs an outside provider. It is switched off in this build.',
        IDP_SOCIAL,
      );
    if (found.status === 'incomplete') {
      throw new SocialError(`Provider settings are incomplete: ${found.missing.join(', ')}`, 'identity.social_provider_config_incomplete');
    }
    return found;
  }

  async start(input: { provider: string; purpose: 'signin' | 'link'; userId?: string }) {
    const { port } = this.entry(input.provider);
    const ttl = this.deps.flowTtlSeconds;
    if (ttl === undefined) throw new SocialError('The sign-in flow lifetime is not set', 'identity.social_flow_ttl_unset');
    const state = generateToken(32);
    const expiresAt = new Date((this.deps.now?.() ?? new Date()).getTime() + ttl * 1000);
    await this.sql`
      INSERT INTO social_flows (state_hash, provider, purpose, user_id, expires_at)
      VALUES (${hashToken(state)}, ${input.provider}, ${input.purpose}, ${input.purpose === 'link' ? (input.userId ?? null) : null}, ${expiresAt})
    `;
    return { provider: input.provider, authorizationUrl: port.authorizationUrl({ state }), expiresAt };
  }

  /**
   * Spend the state, then ask the provider who this is. A spent, expired, unknown,
   * other-provider or other-purpose state is the same refusal. The state is spent even if the exchange fails.
   */
  async complete(input: { provider: string; purpose: 'signin' | 'link'; state: string; code: string; now?: Date }) {
    const { port } = this.entry(input.provider);
    const now = input.now ?? this.deps.now?.() ?? new Date();
    const [flow] = await this.sql<Array<{ user_id: string | null }>>`
      UPDATE social_flows SET used_at = ${now}
      WHERE state_hash = ${hashToken(input.state)} AND provider = ${input.provider} AND purpose = ${input.purpose} AND used_at IS NULL AND expires_at > ${now}
      RETURNING user_id
    `;
    if (!flow) throw new SocialError('That sign-in link is not valid', 'identity.social_flow_invalid');
    let profile: SocialProfile;
    try {
      profile = await port.exchange({ code: input.code });
    } catch {
      throw new SocialError('The provider did not confirm the sign-in', 'identity.social_exchange_failed');
    }
    if (!profile.subject || profile.subject.length > 255) {
      throw new SocialError('The provider did not confirm the sign-in', 'identity.social_exchange_failed');
    }
    return { userId: flow.user_id, profile };
  }

  /** The account already linked to this provider identity, or null. Never matches by email. */
  async findLinked(provider: string, subject: string): Promise<string | null> {
    const [row] = await this.sql<Array<{ user_id: string }>>`
      SELECT user_id FROM social_identities WHERE provider = ${provider} AND subject = ${subject}
    `;
    return row?.user_id ?? null;
  }

  /** Link from a signed-in session. The step-up and the route belong to account-lifecycle slice 07. */
  async link(userId: string, provider: string, profile: SocialProfile): Promise<void> {
    const inserted = await this.sql`
      INSERT INTO social_identities (provider, subject, user_id, relay_email)
      VALUES (${provider}, ${profile.subject}, ${userId}, ${profile.relayEmail ?? null})
      ON CONFLICT DO NOTHING
      RETURNING provider
    `;
    if (inserted.length === 0) {
      const [mine] = await this.sql`
        SELECT 1 FROM social_identities WHERE provider = ${provider} AND subject = ${profile.subject} AND user_id = ${userId}
      `;
      if (!mine) throw new SocialError('That provider account is already linked', 'identity.provider_taken');
      // Replay of the same link by the same account: nothing changes.
    }
  }

  /** Refused unless another way in remains: a password, a mailed code, a passkey, a wallet or another provider. */
  async unlink(userId: string, provider: string): Promise<void> {
    await transaction(this.sql, async (tx) => {
      const [user] = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      if (!user) throw new SocialError('Not found', 'auth.not_found');
      const methods = await lockedSigninMethods(tx, userId);
      if (!methods.providers.includes(provider)) throw new SocialError('Not found', 'auth.not_found');
      try {
        assertLeavesAWayIn(methods);
      } catch (err) {
        if (err instanceof SigninMethodError) throw new SocialError('Add another way to sign in first', 'identity.last_signin_method');
        throw err;
      }
      await tx`DELETE FROM social_identities WHERE user_id = ${userId} AND provider = ${provider}`;
    });
  }
}
