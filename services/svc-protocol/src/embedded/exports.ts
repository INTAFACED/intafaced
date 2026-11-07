import { EMBEDDED_EXPORT_NOT_OWNER, embeddedExportMessage, type ProtocolEmbeddedStatus } from '@intafaced/contracts/protocol-embedded';
import { getAddress, verifyMessage, type Address, type Hex } from 'viem';

/**
 * The embedded login's export fact (RC-dex-protocol-05). The key lives only on the person's device; this plane keeps one
 * fact per account, that its key was shown once and when, written by a request the key itself signed. A repeat keeps the
 * first time (idempotent on embedded.export:<chainId>:<account>). Nothing here can hold, read or recover a key.
 */
export class EmbeddedExportRefusedError extends Error {
  constructor(
    readonly code: typeof EMBEDDED_EXPORT_NOT_OWNER,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddedExportRefusedError';
  }
}

export interface EmbeddedExportStore {
  find(chainId: number, account: Address): Promise<{ exportedAt: Date } | null>;
  /** Writes the fact once; a second write keeps the first row and its time. */
  put(chainId: number, account: Address, signature: Hex): Promise<{ exportedAt: Date }>;
}

export async function embeddedStatus(store: EmbeddedExportStore, chainId: number, account: string): Promise<ProtocolEmbeddedStatus> {
  const address = getAddress(account);
  const row = await store.find(chainId, address);
  return { account: address, chainId, exported: row !== null, exportedAt: row?.exportedAt.toISOString() ?? null };
}

export async function markExported(
  store: EmbeddedExportStore,
  input: { chainId: number; account: string; signature: Hex },
): Promise<ProtocolEmbeddedStatus> {
  const account = getAddress(input.account);
  const signed = await verifyMessage({
    address: account,
    message: embeddedExportMessage(account, input.chainId),
    signature: input.signature,
  }).catch(() => false);
  if (!signed)
    throw new EmbeddedExportRefusedError(EMBEDDED_EXPORT_NOT_OWNER, 'Only the embedded key of this account can record its export.');
  const row = await store.put(input.chainId, account, input.signature);
  return { account, chainId: input.chainId, exported: true, exportedAt: row.exportedAt.toISOString() };
}

export class MemoryEmbeddedExportStore implements EmbeddedExportStore {
  readonly rows = new Map<string, { exportedAt: Date; signature: Hex }>();
  async find(chainId: number, account: Address) {
    return this.rows.get(`embedded.export:${chainId}:${account.toLowerCase()}`) ?? null;
  }
  async put(chainId: number, account: Address, signature: Hex) {
    const key = `embedded.export:${chainId}:${account.toLowerCase()}`;
    const row = this.rows.get(key) ?? { exportedAt: new Date(), signature };
    this.rows.set(key, row);
    return row;
  }
}
