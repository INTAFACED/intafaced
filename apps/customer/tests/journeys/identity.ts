import { createHash, createHmac, randomBytes } from 'node:crypto';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { stack } from './env';

/**
 * The identity doors a journey walks through, the way the edge and the operator desk do: public doors are called bare, a
 * signed-in door carries the principal header the edge builds from the session's access token. Everything the service
 * answers is real; the only thing added here is that header.
 */
export type Claims = { sub: string; sid: string; scopes: string[]; tier: string; mfa: boolean; exp: number };
export type Issued = { userId: string; accessToken: string };

export const claimsOf = (accessToken: string): Claims =>
  JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as Claims;

function principalHeaders(claims: Claims): Record<string, string> {
  const raw = encodePrincipal({
    sub: claims.sub,
    userId: claims.sub,
    sid: claims.sid,
    scopes: claims.scopes,
    tier: claims.tier,
    mfa: claims.mfa,
    expiresAt: new Date(claims.exp * 1000),
  } as never);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, stack.edgeSecret(), stack.region()),
    'x-intafaced-region': stack.region(),
  };
}

export async function identityCall<T = unknown>(procedure: string, input: unknown, claims: Claims | null): Promise<T> {
  const response = await fetch(`${stack.identity()}/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(claims ? principalHeaders(claims) : {}) },
    body: JSON.stringify(input ?? {}),
  });
  const text = await response.text();
  if (!response.ok) throw new IdentityRefusal(procedure, response.status, text);
  return JSON.parse(text).result.data as T;
}

export class IdentityRefusal extends Error {
  constructor(
    readonly procedure: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`identity ${procedure} ${status}: ${body.slice(0, 300)}`);
  }
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 (SHA-1, 30 s, 6 digits): what any authenticator app computes. */
export function totpCode(secretBase32: string, atMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

export type Founder = { handle: string; email: string; password: string; userId: string; totpSecret: string };

/** The two throwaway founders the CX-8 boot enrolled (it passes them in CX8_FOUNDERS_JSON). */
export function founders(): [Founder, Founder] {
  const raw = process.env.CX8_FOUNDERS_JSON?.trim();
  if (!raw) throw new Error('journey stack: CX8_FOUNDERS_JSON is not set. Run through "pnpm journeys:trade".');
  const list = JSON.parse(raw) as Founder[];
  if (list.length !== 2) throw new Error('journey stack: expected two enrolled founders');
  return [list[0]!, list[1]!];
}

/**
 * A real password + TOTP sign-in for a founder: the session carries the MFA flag and the operator scope identity grants.
 * A TOTP step is single-use and identity refuses a step it has already seen; the enrolment and the smoke's own sign-in spent
 * the earlier ones. So this signs in with the step AFTER the current one (inside identity's one-step drift window) and, if
 * that step was already spent, waits for the next step boundary and tries once more. Called once per founder per run, by
 * the global setup.
 */
export async function founderSession(founder: Founder): Promise<Claims> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const issued = await identityCall<Issued>(
        'auth.login',
        { identifier: founder.email, password: founder.password, totpCode: totpCode(founder.totpSecret, Date.now() + 30_000) },
        null,
      );
      const claims = claimsOf(issued.accessToken);
      if (!claims.mfa) throw new Error(`founder ${founder.handle} login did not yield an MFA session`);
      return claims;
    } catch (err) {
      if (attempt >= 2 || !(err instanceof IdentityRefusal) || !err.body.includes('auth.mfa_invalid')) throw err;
      await new Promise((done) => setTimeout(done, 30_000 - (Date.now() % 30_000) + 1_000));
    }
  }
}

export const hashOf = (targetId: string, fields: Record<string, string>) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify({ targetId, ...fields }))
    .digest('hex')}`;

export const randomHandle = (prefix: string) => `${prefix}_${randomBytes(5).toString('hex')}`;
