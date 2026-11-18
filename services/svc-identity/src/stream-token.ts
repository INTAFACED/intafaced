import { issueAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { streamTokenAudience, streamTokenSchema, type StreamTokenReply } from '@intafaced/contracts/stream-token';

/**
 * A short-lived stream token for an API key (J-developer-09 #2, `POST /api/v1/stream/token`).
 *
 * A developer's program opens the private stream (svc-ws `/private/stream?access_token=`) with this token instead of
 * putting the key itself on a WebSocket URL. The token is an ordinary access token cut from the key's own exchanged
 * principal, so it grants no more than the key: the same account, key id (`kid`), session id, scopes, sub-account,
 * tier and key environment, and it ends at the sooner of the owner's stream-token lifetime and the principal's own end.
 * It is minted for the stream audience (`streamTokenAudience`), so svc-edge never takes it as a bearer and only the
 * private stream opens with it. A key that signs every request reached this mint only through a signed request (the
 * edge refuses an unsigned one), which is why the stream accepts the token for such a key.
 * The private stream still asks identity's current authority for that key on every lease (revoked, expired, frozen,
 * IP and origin rules), so a revoked key's stream token stops working too.
 *
 * The lifetime is the owner's value (`IDENTITY_STREAM_TOKEN_TTL_SECONDS`). Blank refuses every mint with
 * `identity.stream_token_ttl_unset`; it is never guessed.
 */

export const STREAM_TOKEN_TTL_MAX_SECONDS = 3600;

export type StreamTokenCode =
  | 'identity.stream_token_ttl_unset'
  | 'identity.stream_token_key_only'
  | 'identity.stream_token_unauthenticated'
  | 'identity.stream_token_principal_expired';

export class StreamTokenError extends Error {
  constructor(
    readonly code: StreamTokenCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'StreamTokenError';
  }
}

/** Whole seconds from 1 to 3600, or null when blank. Anything else stops the boot. */
export function parseStreamTokenTtl(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const seconds = /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > STREAM_TOKEN_TTL_MAX_SECONDS) {
    throw new Error(`IDENTITY_STREAM_TOKEN_TTL_SECONDS must be whole seconds from 1 to ${STREAM_TOKEN_TTL_MAX_SECONDS}`);
  }
  return seconds;
}

export type StreamToken = StreamTokenReply;

export async function mintStreamToken(input: {
  principal: Principal | null;
  ttlSeconds: number | null;
  /** Read at call time, so a rotated signing key is used as it stands. */
  tokens: TokenConfig;
  now?: () => number;
}): Promise<StreamToken> {
  const { principal, ttlSeconds, tokens } = input;
  if (ttlSeconds === null) {
    throw new StreamTokenError('identity.stream_token_ttl_unset', 'Stream tokens are refused for now: their lifetime is not set.', 503);
  }
  if (!principal) {
    throw new StreamTokenError('identity.stream_token_unauthenticated', 'Send your API key to get a stream token.', 401);
  }
  if (!principal.kid) {
    throw new StreamTokenError('identity.stream_token_key_only', 'A stream token is cut from an API key. Send the key.', 403);
  }
  const nowMs = (input.now ?? Date.now)();
  // Never outlive the principal it was cut from: a token's end only moves nearer.
  const principalLeft = Math.floor((principal.expiresAt.getTime() - nowMs) / 1000);
  const seconds = Math.min(ttlSeconds, principalLeft);
  if (seconds < 1) {
    throw new StreamTokenError('identity.stream_token_principal_expired', 'The key exchange ended. Send the key again.', 401);
  }
  const { token, expiresAt } = await issueAccessToken(
    {
      userId: principal.userId,
      sessionId: principal.sid,
      scopes: principal.scopes,
      tier: principal.tier,
      tradingCleared: principal.trd === true,
      mfa: principal.mfa,
      apiKeyId: principal.kid,
      ...(principal.key_env ? { keyEnv: principal.key_env } : {}),
      ...(principal.sub_account ? { subAccountId: principal.sub_account } : {}),
    },
    {
      secret: tokens.secret,
      issuer: tokens.issuer,
      audience: streamTokenAudience(tokens.audience),
      accessTtlSeconds: seconds,
      ...(tokens.keyId ? { keyId: tokens.keyId } : {}),
    },
  );
  return streamTokenSchema.parse({ token, expiresAt: expiresAt.toISOString(), lifetimeSeconds: seconds });
}
