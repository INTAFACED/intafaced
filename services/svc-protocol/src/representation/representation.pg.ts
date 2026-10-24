import type { Sql } from 'postgres';
import { getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import type { RepresentationRecord, RepresentationStore } from './representation.js';

/** Postgres `RepresentationStore` over `protocol.signing_representations` (20261024070458). */
type Row = { chain_id: number; address: string; version: string; message: string; signature: string; accepted_at: Date | string };

function toRecord(r: Row): RepresentationRecord {
  return {
    chainId: r.chain_id,
    address: toChecksum(r.address),
    version: r.version,
    message: r.message,
    signature: r.signature as Hex,
    // The service's client is shared with drizzle, which reads timestamps back as text.
    acceptedAt: new Date(r.accepted_at),
  };
}

export class PostgresRepresentationStore implements RepresentationStore {
  constructor(private readonly sql: Sql) {}

  async find(chainId: number, address: Address, version: string): Promise<RepresentationRecord | null> {
    const rows = await this.sql<Row[]>`
      SELECT chain_id, address, version, message, signature, accepted_at FROM protocol.signing_representations
      WHERE chain_id = ${chainId} AND address = ${toChecksum(address)} AND version = ${version}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async put(record: Omit<RepresentationRecord, 'acceptedAt'>): Promise<RepresentationRecord> {
    // A repeat accept (a retry, a second tab) keeps the first row and its time.
    await this.sql`
      INSERT INTO protocol.signing_representations (chain_id, address, version, message, signature)
      VALUES (${record.chainId}, ${toChecksum(record.address)}, ${record.version}, ${record.message}, ${record.signature})
      ON CONFLICT (chain_id, address, version) DO NOTHING`;
    const stored = await this.find(record.chainId, record.address, record.version);
    if (!stored) throw new Error('protocol.signing_representations insert returned no row');
    return stored;
  }
}
