import type { Sql } from 'postgres';
import { getAddress, type Address, type Hex } from 'viem';
import { bridgeTransferStateSchema, type BridgeTransferState } from '@intafaced/contracts/protocol-bridge';
import { z } from 'zod';
import type { BridgeTransferRecord, BridgeTransferStore, NewBridgeTransfer } from './transfers.js';

/**
 * Postgres `BridgeTransferStore` over `protocol.bridge_transfers` (20261121120000). Every statement names the wallet;
 * an insert under a wallet and key already stored answers the stored row, and a row moves on only from the state it
 * was read in, so two reads at once cannot move it twice.
 */
const hex = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^0x[0-9a-f]{${length}}$`))
    .transform((v): Hex => `0x${v.slice(2)}`);
const Row = z.object({
  id: z.string(),
  wallet: z.string(),
  client_key: z.string(),
  intent_id: hex(64),
  from_chain_id: z.number().int(),
  to_chain_id: z.number().int(),
  token: z.string(),
  amount_units: z.string().regex(/^\d+$/),
  state: bridgeTransferStateSchema,
  burn_tx: hex(64).nullable(),
  attestation: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .transform((v): Hex => `0x${v.slice(2)}`)
    .nullable(),
  // The service's client is shared with drizzle, which reads timestamps back as text.
  created_at: z.union([z.date(), z.string()]),
});
type Row = z.infer<typeof Row>;
const Count = z.object({ n: z.number().int() });

const COLUMNS =
  'id, wallet, client_key, intent_id, from_chain_id, to_chain_id, token, amount_units::text AS amount_units, state, burn_tx, attestation, created_at';

function toRecord(r: Row): BridgeTransferRecord {
  return {
    id: r.id,
    wallet: getAddress(r.wallet),
    key: r.client_key,
    intentId: r.intent_id,
    fromChainId: r.from_chain_id,
    toChainId: r.to_chain_id,
    token: r.token,
    amountUnits: BigInt(r.amount_units),
    state: r.state,
    burnTx: r.burn_tx,
    attestation: r.attestation,
    createdAt: new Date(r.created_at),
  };
}
const rows = (found: unknown) => Row.array().parse(found).map(toRecord);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (wallet: Address) => wallet.toLowerCase();

export class PostgresBridgeTransferStore implements BridgeTransferStore {
  constructor(private readonly sql: Sql) {}

  async insert(row: NewBridgeTransfer): Promise<BridgeTransferRecord> {
    const inserted = await this.sql`
      INSERT INTO protocol.bridge_transfers (wallet, client_key, intent_id, from_chain_id, to_chain_id, token, amount_units)
      VALUES (${lower(row.wallet)}, ${row.key}, ${row.intentId.toLowerCase()}, ${row.fromChainId}, ${row.toChainId}, ${row.token},
              ${row.amountUnits.toString()})
      -- Every unique key (wallet and key, and the intent id made from them) names the same transfer.
      ON CONFLICT DO NOTHING
      RETURNING ${this.sql.unsafe(COLUMNS)}`;
    const [stored] = rows(inserted);
    if (stored) return stored;
    const prior = await this.findByKey(row.wallet, row.key);
    if (!prior) throw new Error('bridge transfer insert conflicted but no row was found');
    return prior;
  }

  async findByKey(wallet: Address, key: string): Promise<BridgeTransferRecord | null> {
    const [row] = rows(
      await this.sql`
        SELECT ${this.sql.unsafe(COLUMNS)} FROM protocol.bridge_transfers WHERE wallet = ${lower(wallet)} AND client_key = ${key}`,
    );
    return row ?? null;
  }

  async get(wallet: Address, id: string): Promise<BridgeTransferRecord | null> {
    if (!UUID.test(id)) return null;
    const [row] = rows(
      await this.sql`
        SELECT ${this.sql.unsafe(COLUMNS)} FROM protocol.bridge_transfers WHERE wallet = ${lower(wallet)} AND id = ${id}`,
    );
    return row ?? null;
  }

  async list(wallet: Address): Promise<BridgeTransferRecord[]> {
    return rows(
      await this.sql`
        SELECT ${this.sql.unsafe(COLUMNS)} FROM protocol.bridge_transfers WHERE wallet = ${lower(wallet)}
        ORDER BY created_at DESC, id LIMIT 50`,
    );
  }

  async countWaiting(wallet: Address): Promise<number> {
    const [row] = Count.array().parse(
      await this.sql`
        SELECT count(*)::int AS n FROM protocol.bridge_transfers WHERE wallet = ${lower(wallet)} AND state = 'awaiting_burn'`,
    );
    return row?.n ?? 0;
  }

  async advance(
    id: string,
    from: BridgeTransferState,
    next: { state: BridgeTransferState; burnTx: Hex | null; attestation: Hex | null },
  ): Promise<boolean> {
    const moved = await this.sql`
      UPDATE protocol.bridge_transfers
      SET state = ${next.state}, burn_tx = ${next.burnTx?.toLowerCase() ?? null}, attestation = ${next.attestation}, updated_at = now()
      WHERE id = ${id} AND state = ${from}`;
    return moved.count === 1;
  }
}
