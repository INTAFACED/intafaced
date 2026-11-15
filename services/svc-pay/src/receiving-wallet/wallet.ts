import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ReceivingWallet, ReceivingWalletSaveInput } from '@intafaced/contracts';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso } from '../merchant-ops/money.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import { PayError } from '../payment-service/internal.js';
import { readExtendedPublicKey, receivingAddress } from './keys.js';

/**
 * The business's own receiving wallet and the addresses given out from it (J-merchant-04, launch money model, OWNER 226).
 *
 * One row per business in `pay.merchant_receiving_wallets`. Every team role reads it; the owner and admins
 * (`profile.manage`) set it, from an interactive session. A save names the version it was made from, so it never
 * overwrites a newer one, and a retried save (same request id, same details) is answered without a second write. Nothing
 * here moves money: the key is public, and every address derived from it is the business's alone.
 */

interface WalletRow {
  network_family: 'evm';
  extended_public_key: string;
  first_address: string;
  saved_at: Date;
  version: number;
  request_id: string;
  request_hash: string;
}

const UNSET: ReceivingWallet = { set: false, family: null, extendedPublicKey: null, firstAddress: null, savedAt: null, version: 0 };

function view(row: WalletRow | undefined): ReceivingWallet {
  if (!row) return UNSET;
  return {
    set: true,
    family: row.network_family,
    extendedPublicKey: row.extended_public_key,
    firstAddress: row.first_address,
    savedAt: iso(row.saved_at),
    version: row.version,
  };
}

async function walletOf(sql: Sql, merchantId: string): Promise<WalletRow | undefined> {
  const [row] = await sql<WalletRow[]>`
    SELECT network_family, extended_public_key, first_address, saved_at, version, request_id, request_hash
      FROM pay.merchant_receiving_wallets WHERE merchant_id = ${merchantId}`;
  return row;
}

export class ReceivingWallets {
  constructor(private readonly sql: Sql) {}

  async get(caller: MerchantCaller): Promise<ReceivingWallet> {
    return view(await walletOf(this.sql, caller.merchantId));
  }

  /**
   * Sets or changes the business's receiving wallet. A private key refuses `pay.receiving_wallet_private_key` and a key
   * that does not read refuses `pay.receiving_wallet_invalid`, before anything is stored. A save made from an older
   * version refuses `pay.receiving_wallet_stale`; the same request id with other details refuses `pay.request_id_reused`.
   * A changed key takes effect for the next payment; addresses already given out stay the payments' they were given to.
   */
  async save(caller: MerchantCaller, input: ReceivingWalletSaveInput): Promise<{ wallet: ReceivingWallet; replayed: boolean }> {
    assertPermission(caller, 'profile.manage');
    if (!caller.interactive) throw new MerchantOpsError('pay.receiving_wallet_interactive_only', 'forbidden');
    const key = readExtendedPublicKey(input.extendedPublicKey);
    const extendedPublicKey = key.publicExtendedKey;
    const firstAddress = receivingAddress(key, 0);
    const hash = createHash('sha256')
      .update(JSON.stringify({ expectedVersion: input.expectedVersion, family: input.family, extendedPublicKey }))
      .digest('hex');
    return this.sql.begin(async (tx) => {
      // One save at a time per business: the first save has no row to lock yet.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pay.merchant_receiving_wallets:${caller.merchantId}`}, 0))`;
      const current = await walletOf(tx as unknown as Sql, caller.merchantId);
      if (current && current.request_id === input.requestId) {
        if (current.request_hash !== hash) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
        return { wallet: view(current), replayed: true };
      }
      if ((current?.version ?? 0) !== input.expectedVersion) throw new MerchantOpsError('pay.receiving_wallet_stale', 'conflict');
      const [saved] = current
        ? await tx<WalletRow[]>`
            UPDATE pay.merchant_receiving_wallets
               SET network_family = ${input.family}, extended_public_key = ${extendedPublicKey}, first_address = ${firstAddress},
                   saved_by = ${caller.userId}, saved_at = now(), version = version + 1,
                   request_id = ${input.requestId}::uuid, request_hash = ${hash}
             WHERE merchant_id = ${caller.merchantId}
            RETURNING network_family, extended_public_key, first_address, saved_at, version, request_id, request_hash`
        : await tx<WalletRow[]>`
            INSERT INTO pay.merchant_receiving_wallets
              (merchant_id, network_family, extended_public_key, first_address, saved_by, request_id, request_hash)
            VALUES (${caller.merchantId}, ${input.family}, ${extendedPublicKey}, ${firstAddress}, ${caller.userId},
                    ${input.requestId}::uuid, ${hash})
            RETURNING network_family, extended_public_key, first_address, saved_at, version, request_id, request_hash`;
      return { wallet: view(saved), replayed: false };
    });
  }
}

/**
 * Gives one payment a fresh receiving address of its business's own wallet, in the caller's transaction (the hosted
 * checkout's, which holds the merchant lock, so two payments never race for one index). The next index is one past the
 * highest given out from this key; a payment that already has one gets the same one back. No wallet set refuses
 * `pay.receiving_wallet_unset` before anything is written, so a payer is never shown an address nothing will count.
 */
export async function allocateReceivingAddress(tx: Sql, merchantId: string, paymentId: string): Promise<string> {
  const [given] = await tx<Array<{ address: string }>>`
    SELECT address FROM pay.merchant_receive_addresses WHERE payment_id = ${paymentId}`;
  if (given) return given.address;
  const wallet = await walletOf(tx, merchantId);
  if (!wallet) {
    throw new PayError(
      'This business has not set its own receiving wallet, so it cannot take crypto yet. Nothing was started.',
      'pay.receiving_wallet_unset',
    );
  }
  const key = readExtendedPublicKey(wallet.extended_public_key);
  const [next] = await tx<Array<{ next: number }>>`
    SELECT COALESCE(MAX(child_index) + 1, 0)::int AS next
      FROM pay.merchant_receive_addresses WHERE extended_public_key = ${wallet.extended_public_key}`;
  const index = next!.next;
  const address = receivingAddress(key, index);
  await tx`
    INSERT INTO pay.merchant_receive_addresses (merchant_id, extended_public_key, child_index, address, payment_id)
    VALUES (${merchantId}, ${wallet.extended_public_key}, ${index}, ${address}, ${paymentId})`;
  return address;
}

/** The receiving address a payment was given, or null for a payment that was not paid to its business's own wallet. */
export async function receivingAddressOf(sql: Sql, paymentId: string): Promise<string | null> {
  const [row] = await sql<Array<{ address: string }>>`SELECT address FROM pay.merchant_receive_addresses WHERE payment_id = ${paymentId}`;
  return row?.address ?? null;
}
