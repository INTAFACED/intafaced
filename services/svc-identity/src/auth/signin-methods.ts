/**
 * Link and unlink sign-in methods (I-account-lifecycle-07).
 *
 * The ways an account signs in: its password, a code mailed to its address, its passkeys, its wallets and its linked
 * provider accounts. A change needs a signed-in session, a proof of the method (a signature, a proved address, a
 * password that meets the policy) and the security step-up; the proof is checked before the step-up, so a wrong
 * signature never spends a confirmation. Removing one is refused when it would leave no way in
 * (`identity.last_signin_method`), checked again under the users row lock that every writer of these methods holds.
 *
 * A wallet is proved by an EIP-4361 message this service wrote, signed by the wallet: a chain-agnostic check of an
 * externally owned account's signature, with no chain call. A signature that is not a plain 65-byte one (a contract
 * wallet's) is refused `identity.wallet_kind_unsupported`. Each challenge is an `auth_flows` row, single use and bound to
 * its purpose, its wallet and (for a link) its account. Texted codes need the outside `vendor.sms`, which is not
 * connected, so a phone number is refused with that code and nothing is stored.
 */
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { getAddress, recoverMessageAddress, type Hex } from 'viem';
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import {
  assertPasswordNotBreached,
  assertPasswordNotIdentity,
  assertPasswordShape,
  generateToken,
  hashPassword,
  hashToken,
  WeakPasswordError,
} from './passwords.js';
import { assertNotSecurityLocked } from './security-lock.js';
import { queuePasswordChangedNotice } from './password-changed-notice.js';

/** How long a wallet challenge waits for its signature: the same engineering bound as a WebAuthn challenge. */
export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const VENDOR_SMS = 'vendor.sms' as const;

export type SigninMethodCode =
  | 'identity.last_signin_method'
  | 'identity.method_taken'
  | 'identity.method_unverified'
  | 'identity.method_not_linked'
  | 'identity.method_already_linked'
  | 'identity.method_invalid'
  | 'identity.wallet_kind_unsupported'
  | 'identity.wallet_signature_invalid'
  | 'identity.wallet_challenge_invalid'
  | 'auth.password_policy'
  | 'auth.password_breached'
  | 'auth.account_frozen'
  | 'auth.not_found'
  | typeof VENDOR_SMS;

export class SigninMethodError extends Error {
  constructor(
    readonly code: SigninMethodCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'SigninMethodError';
  }
}

/**
 * A method named on the wire: `password`, `email_code`, `sms_code`, `wallet_siwe:<lower-case address>` or
 * `social:<provider>` (a linked provider account).
 */
export type SigninMethod = 'password' | 'email_code' | 'sms_code' | `wallet_siwe:0x${string}` | `social:${string}`;
const METHOD = /^(password|email_code|sms_code|wallet_siwe:0x[0-9a-f]{40}|social:[a-z0-9-]{1,32})$/;

export function parseSigninMethod(raw: string): SigninMethod {
  if (!METHOD.test(raw)) throw new SigninMethodError('identity.method_invalid');
  return raw as SigninMethod;
}

/** The lower-case form a wallet is stored and named by; refuses anything that is not a 20-byte address. */
export function walletAddress(raw: string): `0x${string}` {
  const address = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new SigninMethodError('identity.method_invalid');
  return address as `0x${string}`;
}

export type SigninMethods = {
  password: boolean;
  emailCode: { on: boolean; address: string | null; proved: boolean };
  passkeys: number;
  wallets: Array<{ address: string; linkedAt: string }>;
  providers: string[];
};

type UserRow = {
  status: string;
  password_set: boolean;
  email: string | null;
  email_verified_at: Date | null;
  email_code_signin: boolean;
  handle: string;
  passkeys: number;
};

async function readUser(sql: Sql, userId: string, lock: boolean): Promise<UserRow> {
  const rows = lock
    ? await sql<UserRow[]>`
        SELECT status, password_set, email, email_verified_at, email_code_signin, handle,
               jsonb_array_length(webauthn_creds)::int AS passkeys
        FROM users WHERE id = ${userId} FOR UPDATE`
    : await sql<UserRow[]>`
        SELECT status, password_set, email, email_verified_at, email_code_signin, handle,
               jsonb_array_length(webauthn_creds)::int AS passkeys
        FROM users WHERE id = ${userId}`;
  const user = rows[0];
  if (!user) throw new SigninMethodError('auth.not_found');
  return user;
}

async function methodsOf(sql: Sql, userId: string, user: UserRow): Promise<SigninMethods> {
  const wallets = await sql<Array<{ address: string; created_at: Date }>>`
    SELECT address, created_at FROM wallet_identities WHERE user_id = ${userId} ORDER BY created_at, address`;
  const providers = await sql<Array<{ provider: string }>>`
    SELECT provider FROM social_identities WHERE user_id = ${userId} ORDER BY provider`;
  return {
    password: user.password_set,
    emailCode: { on: user.email_code_signin && user.email !== null, address: user.email, proved: user.email_verified_at !== null },
    passkeys: user.passkeys,
    wallets: wallets.map((w) => ({ address: w.address, linkedAt: w.created_at.toISOString() })),
    providers: providers.map((p) => p.provider),
  };
}

/** How many ways in the account has. A mailed code counts only to an address the owner proved. */
export function signinMethodCount(methods: SigninMethods): number {
  const emailCode = methods.emailCode.on && methods.emailCode.proved;
  return (methods.password ? 1 : 0) + (emailCode ? 1 : 0) + methods.passkeys + methods.wallets.length + methods.providers.length;
}

/** The caller's own ways to sign in. */
export async function listSigninMethods(sql: Sql, userId: string): Promise<SigninMethods> {
  return methodsOf(sql, userId, await readUser(sql, userId, false));
}

/**
 * Refuses a removal that would leave no way in, given the methods the account holds now. Used by every remover: the
 * methods here, a passkey, a provider account. Call it under the users row lock for the answer to stand.
 */
export function assertLeavesAWayIn(methods: SigninMethods, removing: number = 1): void {
  if (signinMethodCount(methods) - removing < 1) {
    throw new SigninMethodError('identity.last_signin_method', 'Add another way to sign in first');
  }
}

/** Read under the given transaction's users row lock, for removers elsewhere (passkeys, provider accounts). */
export async function lockedSigninMethods(tx: Sql, userId: string): Promise<SigninMethods> {
  return methodsOf(tx, userId, await readUser(tx, userId, true));
}

function holds(methods: SigninMethods, method: SigninMethod): boolean {
  if (method === 'password') return methods.password;
  if (method === 'email_code') return methods.emailCode.on;
  if (method === 'sms_code') return false;
  if (method.startsWith('social:')) return methods.providers.includes(method.slice('social:'.length));
  const address = method.slice('wallet_siwe:'.length);
  return methods.wallets.some((w) => w.address === address);
}

/** How many ways in removing `method` takes away: a mailed code to an address never proved was not counted. */
function counted(methods: SigninMethods, method: SigninMethod): number {
  return method === 'email_code' && !methods.emailCode.proved ? 0 : 1;
}

/** The refusals a removal would meet, without writing: run before the step-up so a refused change spends no confirmation. */
export async function checkUnlink(sql: Sql, userId: string, method: SigninMethod): Promise<void> {
  const user = await readUser(sql, userId, false);
  if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
  await assertNotSecurityLocked(sql, userId);
  const methods = await methodsOf(sql, userId, user);
  if (!holds(methods, method)) throw new SigninMethodError('identity.method_not_linked');
  assertLeavesAWayIn(methods, counted(methods, method));
}

/**
 * Remove one way in. A password stops working at once: its hash is replaced by one of a secret nobody holds, so every
 * check that reads it refuses, and a password reset by mail or "set a password" gives one back. Turning the mailed code
 * off also ends any code already sent.
 */
export async function unlinkSigninMethod(sql: Sql, userId: string, method: SigninMethod): Promise<SigninMethods> {
  const unusable = method === 'password' ? await hashPassword(generateToken(32)) : null;
  return transaction(sql, async (tx) => {
    const user = await readUser(tx, userId, true);
    if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
    await assertNotSecurityLocked(tx, userId);
    const methods = await methodsOf(tx, userId, user);
    if (!holds(methods, method)) throw new SigninMethodError('identity.method_not_linked');
    assertLeavesAWayIn(methods, counted(methods, method));
    if (method === 'password') {
      await tx`UPDATE users SET password_hash = ${unusable!}, password_set = false, updated_at = now() WHERE id = ${userId}`;
      // The password stops working: the owner is told by mail and in the inbox, as for a change (J-identity-03 #6).
      await queuePasswordChangedNotice(tx, { userId, now: new Date() });
    } else if (method === 'email_code') {
      await tx`UPDATE users SET email_code_signin = false, updated_at = now() WHERE id = ${userId}`;
      await tx`
        UPDATE auth_flows SET status = 'consumed', consumed_at = now()
        WHERE user_id = ${userId} AND kind = 'login_code' AND consumed_at IS NULL`;
    } else if (method.startsWith('social:')) {
      await tx`DELETE FROM social_identities WHERE user_id = ${userId} AND provider = ${method.slice('social:'.length)}`;
    } else {
      await tx`DELETE FROM wallet_identities WHERE user_id = ${userId} AND address = ${method.slice('wallet_siwe:'.length)}`;
    }
    return methodsOf(tx, userId, await readUser(tx, userId, false));
  });
}

/** The refusals a new password would meet: the same policy as a change. Run before the step-up. */
export async function checkLinkPassword(sql: Sql, userId: string, password: string): Promise<void> {
  const user = await readUser(sql, userId, false);
  if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
  await assertNotSecurityLocked(sql, userId);
  if (user.password_set) throw new SigninMethodError('identity.method_already_linked');
  try {
    assertPasswordShape(password);
    assertPasswordNotIdentity(password, user);
    assertPasswordNotBreached(password);
  } catch (err) {
    if (err instanceof WeakPasswordError) throw new SigninMethodError(err.code, err.message);
    throw err;
  }
}

/** Set a password on an account that has none (changing one is `auth.changePassword`, which needs the current one). */
export async function linkPassword(sql: Sql, userId: string, password: string): Promise<SigninMethods> {
  await checkLinkPassword(sql, userId, password);
  const hash = await hashPassword(password);
  return transaction(sql, async (tx) => {
    const user = await readUser(tx, userId, true);
    if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
    await assertNotSecurityLocked(tx, userId);
    if (user.password_set) throw new SigninMethodError('identity.method_already_linked');
    await tx`UPDATE users SET password_hash = ${hash}, password_set = true, updated_at = now() WHERE id = ${userId}`;
    // A new way in: the owner is told by mail and in the inbox, as for a change (J-identity-03 #6).
    await queuePasswordChangedNotice(tx, { userId, now: new Date() });
    return methodsOf(tx, userId, await readUser(tx, userId, false));
  });
}

/** Mailed codes go only to an address the owner proved. */
export async function checkLinkEmailCode(sql: Sql, userId: string): Promise<void> {
  const user = await readUser(sql, userId, false);
  if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
  await assertNotSecurityLocked(sql, userId);
  if (user.email === null || user.email_verified_at === null) throw new SigninMethodError('identity.method_unverified');
  if (user.email_code_signin) throw new SigninMethodError('identity.method_already_linked');
}

export async function linkEmailCode(sql: Sql, userId: string): Promise<SigninMethods> {
  return transaction(sql, async (tx) => {
    const user = await readUser(tx, userId, true);
    if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
    await assertNotSecurityLocked(tx, userId);
    if (user.email === null || user.email_verified_at === null) throw new SigninMethodError('identity.method_unverified');
    await tx`UPDATE users SET email_code_signin = true, updated_at = now() WHERE id = ${userId}`;
    return methodsOf(tx, userId, await readUser(tx, userId, false));
  });
}

// ── Wallets ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type WalletPurpose = 'link' | 'signin';
export type WalletConfig = {
  /** The origins this service writes messages for (WEBAUTHN_ORIGIN): the first unless the caller names another. */
  readonly origins: readonly string[];
  readonly now?: () => Date;
};

const flowKind = (purpose: WalletPurpose) => (purpose === 'link' ? 'wallet_link' : 'wallet_signin');

function originFor(config: WalletConfig, asked: string | undefined): URL {
  const listed = config.origins.map((o) => new URL(o));
  if (listed.length === 0) throw new SigninMethodError('identity.method_invalid', 'No origin is configured for wallet messages');
  return listed.find((o) => o.origin === asked) ?? listed[0]!;
}

/**
 * Write the message a wallet signs: EIP-4361, for this service's own origin, with a single-use nonce. For sign-in the
 * account is not looked up here, so the answer is the same for a wallet that is linked and one that is not.
 */
export async function startWalletChallenge(
  sql: Sql,
  config: WalletConfig,
  input: { purpose: WalletPurpose; address: string; chainId: number; userId?: string; origin?: string },
): Promise<{ flowId: string; message: string; expiresAt: string }> {
  const address = walletAddress(input.address);
  const origin = originFor(config, input.origin);
  const now = config.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + WALLET_CHALLENGE_TTL_MS);
  const nonce = generateSiweNonce();
  const message = createSiweMessage({
    domain: origin.host,
    address: getAddress(address),
    statement:
      input.purpose === 'link'
        ? 'Link this wallet to your account so you can sign in with it.'
        : 'Sign in to your account with this wallet.',
    uri: origin.origin,
    version: '1',
    chainId: input.chainId,
    nonce,
    issuedAt: now,
    expirationTime: expiresAt,
  });
  const [flow] = await sql<Array<{ id: string }>>`
    INSERT INTO auth_flows (kind, subject_hash, user_id, code_hash, status, expires_at)
    VALUES (${flowKind(input.purpose)}, ${hashToken(address)}, ${input.userId ?? null}, ${hashToken(nonce)}, 'code_sent', ${expiresAt})
    RETURNING id`;
  return { flowId: flow!.id, message, expiresAt: expiresAt.toISOString() };
}

type WalletAnswer = { flowId: string; message: string; signature: string };

async function spend(sql: Sql, flowId: string, now: Date): Promise<void> {
  await sql`UPDATE auth_flows SET status = 'consumed', consumed_at = ${now} WHERE id = ${flowId} AND consumed_at IS NULL`;
}

type Answered = { ok: true; address: `0x${string}` } | { ok: false; error: SigninMethodError };

/**
 * Check a wallet's answer to its challenge. A refused answer spends the challenge, so each signature is tried once; with
 * `spendOnPass` a good one is spent too. It answers rather than throws, so the caller's transaction commits the spend
 * before the refusal is thrown. Locks the challenge row.
 */
async function answerWallet(
  sql: Sql,
  config: WalletConfig,
  purpose: WalletPurpose,
  answer: WalletAnswer,
  options: { userId?: string; spendOnPass: boolean },
): Promise<Answered> {
  const now = config.now?.() ?? new Date();
  const invalid = new SigninMethodError('identity.wallet_challenge_invalid');
  if (!/^[0-9a-f-]{36}$/.test(answer.flowId)) return { ok: false, error: invalid };
  const [flow] = await sql<Array<{ id: string; subject_hash: string; user_id: string | null; code_hash: string; expires_at: Date }>>`
    SELECT id, subject_hash, user_id, code_hash, expires_at FROM auth_flows
    WHERE id = ${answer.flowId} AND kind = ${flowKind(purpose)} AND status = 'code_sent' AND consumed_at IS NULL
    FOR UPDATE`;
  if (!flow || flow.expires_at <= now || (purpose === 'link' && flow.user_id !== options.userId)) return { ok: false, error: invalid };
  const refuse = async (error: SigninMethodError): Promise<Answered> => {
    await spend(sql, flow.id, now);
    return { ok: false, error };
  };
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(answer.message);
  } catch {
    return refuse(invalid);
  }
  const ours = config.origins.some((o) => parsed.domain === new URL(o).host && parsed.uri === new URL(o).origin);
  const address = parsed.address?.toLowerCase();
  if (!ours || !parsed.nonce || hashToken(parsed.nonce) !== flow.code_hash || !address || hashToken(address) !== flow.subject_hash) {
    return refuse(invalid);
  }
  // A plain signature is 65 bytes. Anything else (an ERC-1271 or ERC-6492 wrapped one) needs a chain call to check.
  if (!/^0x[0-9a-fA-F]{130}$/.test(answer.signature)) return refuse(new SigninMethodError('identity.wallet_kind_unsupported'));
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message: answer.message, signature: answer.signature as Hex })).toLowerCase();
  } catch {
    return refuse(new SigninMethodError('identity.wallet_signature_invalid'));
  }
  if (signer !== address) return refuse(new SigninMethodError('identity.wallet_signature_invalid'));
  if (options.spendOnPass) await spend(sql, flow.id, now);
  return { ok: true, address: address as `0x${string}` };
}

function answered(result: Answered): `0x${string}` {
  if (!result.ok) throw result.error;
  return result.address;
}

/** The refusals a wallet link would meet, without spending a good answer: run before the step-up. */
export async function checkLinkWallet(sql: Sql, config: WalletConfig, userId: string, answer: WalletAnswer): Promise<`0x${string}`> {
  const user = await readUser(sql, userId, false);
  if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
  await assertNotSecurityLocked(sql, userId);
  const address = answered(await transaction(sql, (tx) => answerWallet(tx, config, 'link', answer, { userId, spendOnPass: false })));
  const [owner] = await sql<Array<{ user_id: string }>>`SELECT user_id FROM wallet_identities WHERE address = ${address}`;
  if (owner && owner.user_id !== userId) throw new SigninMethodError('identity.method_taken');
  return address;
}

/** Link the wallet that answered. The same wallet linked again by the same account changes nothing. */
export async function linkWallet(sql: Sql, config: WalletConfig, userId: string, answer: WalletAnswer): Promise<SigninMethods> {
  return transaction(sql, async (tx) => {
    const user = await readUser(tx, userId, true);
    if (user.status !== 'active') throw new SigninMethodError('auth.account_frozen', `Account is ${user.status}`);
    await assertNotSecurityLocked(tx, userId);
    // Checked before the step-up already; a refusal here rolls back with the link and leaves the challenge as it was.
    const address = answered(await answerWallet(tx, config, 'link', answer, { userId, spendOnPass: true }));
    const inserted = await tx`
      INSERT INTO wallet_identities (address, user_id) VALUES (${address}, ${userId})
      ON CONFLICT (address) DO NOTHING RETURNING address`;
    if (inserted.length === 0) {
      const [owner] = await tx<Array<{ user_id: string }>>`SELECT user_id FROM wallet_identities WHERE address = ${address}`;
      if (owner?.user_id !== userId) throw new SigninMethodError('identity.method_taken');
    }
    return methodsOf(tx, userId, await readUser(tx, userId, false));
  });
}

/**
 * The account a wallet signs in, once its answer checks out; the challenge is spent either way. A wallet linked to no
 * account answers `null`, which the caller refuses the same way as a wrong password.
 */
export async function walletSigninAccount(sql: Sql, config: WalletConfig, answer: WalletAnswer): Promise<string | null> {
  const address = answered(await transaction(sql, (tx) => answerWallet(tx, config, 'signin', answer, { spendOnPass: true })));
  const [owner] = await sql<Array<{ user_id: string }>>`SELECT user_id FROM wallet_identities WHERE address = ${address}`;
  return owner?.user_id ?? null;
}
