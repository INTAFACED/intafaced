/**
 * The wallet-signature check for other services (`POST /internal/wallet-signatures/verify`,
 * `walletSignatureVerifySchema`). Identity holds which wallets an account linked; a service that needs the person's wallet
 * to sign its own message (svc-token, a signed governance vote; J-more-catalogue-09 #7) asks here at the moment it acts.
 * Only the services listed may ask. Nothing is written.
 */
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { recoverMessageAddress, type Hex } from 'viem';
import {
  WALLET_SIGNATURE_VERIFY_PATH,
  walletSignatureVerifyRequestSchema,
  type ServiceBodyBindMode,
  type WalletSignatureVerify,
  type WalletSignatureVerifyRequest,
} from '@intafaced/contracts';
import { serviceOfRequest, type IdentityS2s } from '../s2s-door.js';
import { securityLockHolds } from './security-lock.js';

/** The services allowed to check a signature against an account's wallets. */
export const WALLET_SIGNATURE_READERS: ReadonlySet<string> = new Set(['svc-token']);

/** What the check needs to know of an account: whether it may act, and its linked wallets (lower-case). */
export interface SigningAccount {
  usable: boolean;
  wallets: string[];
}

/** An account that is missing, not active or under a security lock is not usable, as for a wallet link. */
export async function signingAccount(sql: Sql, userId: string): Promise<SigningAccount> {
  const [user] = await sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${userId}`;
  const usable = user?.status === 'active' && !(await securityLockHolds(sql, userId));
  const rows = await sql<Array<{ address: string }>>`SELECT address FROM wallet_identities WHERE user_id = ${userId}`;
  return { usable, wallets: rows.map((row) => row.address.toLowerCase()) };
}

/** secp256k1 group order over two: a signature with a larger s is the malleable twin of a canonical one (EIP-2). */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** One canonical form per signed message: v is 27 or 28 and s is low. */
function canonical(signature: string): boolean {
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130, 132).toLowerCase();
  return (v === '1b' || v === '1c') && s > 0n && s <= HALF_ORDER;
}

/** Recovers the EIP-191 signer and answers against the account's wallets. */
export async function verifyWalletSignature(
  account: (userId: string) => Promise<SigningAccount>,
  input: WalletSignatureVerifyRequest,
): Promise<WalletSignatureVerify> {
  const { usable, wallets } = await account(input.userId);
  if (!usable) return { state: 'account_inactive' };
  if (wallets.length === 0) return { state: 'no_wallet' };
  if (!canonical(input.signature)) return { state: 'invalid' };
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message: input.message, signature: input.signature as Hex })).toLowerCase();
  } catch {
    return { state: 'invalid' };
  }
  return wallets.includes(signer) ? { state: 'linked', address: signer } : { state: 'not_linked' };
}

export function registerWalletSignatureVerifyRoute(
  app: FastifyInstance,
  opts: {
    verify: (input: WalletSignatureVerifyRequest) => Promise<WalletSignatureVerify>;
    internalSecret: string | undefined;
    bodyBind?: ServiceBodyBindMode;
    s2s?: IdentityS2s;
  },
): void {
  app.post(WALLET_SIGNATURE_VERIFY_PATH, async (req, reply) => {
    const { service } = serviceOfRequest(req, opts.internalSecret, opts.bodyBind, opts.s2s);
    if (service === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'identity.unauthenticated' });
    }
    if (!WALLET_SIGNATURE_READERS.has(service)) {
      return reply
        .code(403)
        .send({ error: 'this service may not check wallet signatures', code: 'identity.wallet_signature_reader_refused' });
    }
    const parsed = walletSignatureVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid signature check', code: 'identity.wallet_signature_request_invalid' });
    }
    return opts.verify(parsed.data);
  });
}
