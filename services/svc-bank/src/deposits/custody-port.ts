/**
 * Custody port for customer deposit addresses.
 *
 * `null` from any method means custody is not connected. The service then
 * refuses `bank.deposit_custody_unset` and does not invent an asset, a
 * minimum, a confirmation count, or an address. svc-bank does not derive keys.
 */

import type { PayCustodyDepositRecord, PayCustodyDepositStatus } from '@intafaced/contracts';

export interface DepositNetwork {
  id: string;
  label: string;
  minimumDeposit: string;
  confirmationsRequired: number;
  estimatedArrivalMinutes: number;
}

export interface DepositAsset {
  assetId: string;
  networks: readonly DepositNetwork[];
}

/** A pair the owner switched off: it takes no new address. `haltNote` is the owner's line, or null for the standard line only. */
export interface HaltedDepositPair {
  assetId: string;
  networkId: string;
  label: string;
  haltNote: string | null;
}

/** The whole catalogue in one read: what can take a deposit now, and what the owner switched off. */
export interface CustodyDepositCatalogue {
  assets: readonly DepositAsset[];
  halted: readonly HaltedDepositPair[];
}

export interface CustodyDepositAddress {
  address: string;
  memo?: string | null;
  qrPayload?: string | null;
}

export interface CustodyPendingDeposit {
  id: string;
  assetId: string;
  networkId: string;
  amount: string;
  confirmations: number;
  /** `null` when the network's confirmation count is blank: the row shows no target rather than an invented one. */
  confirmationsRequired: number | null;
}

/** One deposit record as custody keeps it (the pay record, W-deposit-05). */
export type CustodyDepositRecord = PayCustodyDepositRecord;

export interface CustodyDepositRecordsQuery {
  userId: string;
  assetId?: string;
  networkId?: string;
  statuses?: readonly PayCustodyDepositStatus[];
  txHash?: string;
  address?: string;
  offset: number;
  limit: number;
}

export interface CustodyDepositPort {
  /** `null` = catalogue not published. An empty array is a published empty list. */
  listAssets(): Promise<readonly DepositAsset[] | null>;
  /**
   * The same catalogue with the switched-off pairs, in one read. `null` = not published. Absent on a port that knows nothing of
   * switched-off pairs; the service then reads `listAssets` and names none as switched off.
   */
  catalogue?(): Promise<CustodyDepositCatalogue | null>;
  /** `null` = custody will not issue an address. */
  address(input: { userId: string; assetId: string; networkId: string }): Promise<CustodyDepositAddress | null>;
  /** `null` = custody is not reporting incoming deposits. An empty array means none are incoming. */
  pending(userId: string): Promise<readonly CustodyPendingDeposit[] | null>;
  /** `null` = custody does not report deposit records. Absent on a port built before the record existed. */
  records?(query: CustodyDepositRecordsQuery): Promise<{ items: readonly CustodyDepositRecord[]; total: number } | null>;
}

export const unsetCustodyDepositPort: CustodyDepositPort = {
  listAssets: async () => null,
  address: async () => null,
  pending: async () => null,
};
