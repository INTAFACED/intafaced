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

/** The services allowed to check a signature against an account's wallets. */
export const WALLET_SIGNATURE_READERS: ReadonlySet<string> = new Set(['svc-token']);

/** The account's linked wallets, lower-case. */
export async function linkedWalletAddresses(sql: Sql, userId: string): Promise<string[]> {
  const rows = await sql<Array<{ address: string }>>`SELECT address FROM wallet_identities WHERE user_id = ${userId}`;
  return rows.map((row) => row.address.toLowerCase());
}

/** Recovers the EIP-191 signer and answers against the account's wallets. */
export async function verifyWalletSignature(
  wallets: (userId: string) => Promise<string[]>,
  input: WalletSignatureVerifyRequest,
): Promise<WalletSignatureVerify> {
  const linked = await wallets(input.userId);
  if (linked.length === 0) return { state: 'no_wallet' };
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message: input.message, signature: input.signature as Hex })).toLowerCase();
  } catch {
    return { state: 'invalid' };
  }
  return linked.includes(signer) ? { state: 'linked', address: signer } : { state: 'not_linked' };
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
