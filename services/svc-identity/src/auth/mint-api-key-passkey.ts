/**
 * Mint an API key only after a verified passkey.
 * Empty creds → auth.passkey_missing. Creds without lastVerifiedAt →
 * auth.passkey_verify_unavailable. No invented challenge. AuthService mints the secret.
 */
import type { Sql } from 'postgres';
import type { AuthService } from './auth-service.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';

export class MintApiKeyPasskeyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.passkey_missing' | 'auth.passkey_verify_unavailable' | 'auth.not_found',
  ) {
    super(message);
    this.name = 'MintApiKeyPasskeyError';
  }
}

function asCreds(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Identity body only. Never invent a clock. Reads lastVerifiedAt on any enrolled cred. */
export function lastVerifiedAtOnCreds(raw: unknown): string | undefined {
  const creds = asCreds(raw);
  for (const cred of creds) {
    if (!cred || typeof cred !== 'object') continue;
    const row = cred as Record<string, unknown>;
    const at = nonEmptyString(row.lastVerifiedAt ?? row.last_verified_at);
    if (at) return at;
  }
  return undefined;
}

/**
 * Enrolled + identity-verified passkey may mint. Never invent enrolled/verified.
 * Never start a WebAuthn ceremony. Never invent a challenge.
 */
export function requireVerifiedPasskey(raw: unknown): void {
  const creds = asCreds(raw);
  if (creds.length === 0) {
    throw new MintApiKeyPasskeyError('No enrolled passkey', 'auth.passkey_missing');
  }
  if (!lastVerifiedAtOnCreds(creds)) {
    throw new MintApiKeyPasskeyError('passkey verify is unavailable', 'auth.passkey_verify_unavailable');
  }
}

export async function mintApiKeyAfterPasskey(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox' }> {
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`
    SELECT webauthn_creds FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new MintApiKeyPasskeyError('User not found', 'auth.not_found');
  requireVerifiedPasskey(user.webauthn_creds);
  return minter.createApiKey(input);
}

/** Mint refuses without enrolled+verified passkey without rewriting auth-service.ts. */
export function installPasskeyMintRefuse(auth: AuthService, sql: Sql): void {
  const orig = auth.createApiKey.bind(auth);
  auth.createApiKey = async (input) => {
    const rows = await sql<Array<{ webauthn_creds: unknown }>>`
      SELECT webauthn_creds FROM users WHERE id = ${input.userId} LIMIT 1
    `;
    const user = rows[0];
    if (!user) throw new MintApiKeyPasskeyError('User not found', 'auth.not_found');
    requireVerifiedPasskey(user.webauthn_creds);
    return orig(input);
  };
}
