import { PAY_CUSTODY_DEPOSIT_PENDING_STATUSES, type PayCustodyDepositPort } from '@intafaced/contracts';
import type { CustodyDepositCatalogue, CustodyDepositPort, DepositAsset } from './custody-port.js';

/**
 * The real `CustodyDepositPort` (W-deposit-01): every answer comes from svc-pay over the signed seam in
 * `@intafaced/contracts`. svc-bank derives no key and reads none of svc-pay's tables.
 *
 * `null` means custody is not answering, and the deposit service turns it into `bank.deposit_custody_unset`: a pay that is
 * unreachable, a refused pair and a reply that did not parse all look the same to the customer, and none of them invents an
 * asset, a minimum, a confirmation count or an address. `pending` and `records` read svc-pay's deposit record (W-deposit-05); an
 * unreachable pay is `null`, never an empty list that would say "connected, nothing incoming".
 */
export function createPayCustodyDepositPort(pay: PayCustodyDepositPort): CustodyDepositPort {
  async function catalogue(): Promise<CustodyDepositCatalogue | null> {
    const answer = await pay.catalogue();
    if (answer.state !== 'ok') return null;
    const byAsset = new Map<string, DepositAsset>();
    for (const entry of answer.catalogue.entries) {
      const asset = byAsset.get(entry.assetId) ?? { assetId: entry.assetId, networks: [] };
      asset.networks = [
        ...asset.networks,
        {
          id: entry.networkId,
          label: entry.label,
          minimumDeposit: entry.minimumDeposit,
          confirmationsRequired: entry.confirmationsRequired,
          estimatedArrivalMinutes: entry.estimatedArrivalMinutes,
          ...(entry.unsupported ? { unsupported: entry.unsupported } : {}),
        },
      ];
      byAsset.set(entry.assetId, asset);
    }
    const halted = (answer.catalogue.halted ?? []).map(({ assetId, networkId, label, haltNote }) => ({
      assetId,
      networkId,
      label,
      haltNote,
    }));
    return { assets: [...byAsset.values()], halted };
  }

  return {
    catalogue,

    async listAssets() {
      return (await catalogue())?.assets ?? null;
    },

    async address(input) {
      const answer = await pay.address(input);
      if (answer.state !== 'issued') return null;
      // An extra address must come back as the one asked for, with its stored expiry; anything else is not repeated.
      if ((answer.address.addressIndex ?? 0) !== (input.addressIndex ?? 0)) return null;
      if ((input.addressIndex ?? 0) > 0 && !answer.address.expiresAt) return null;
      return {
        address: answer.address.address,
        memo: answer.address.memo,
        qrPayload: answer.address.qrPayload,
        expiresAt: answer.address.expiresAt ?? null,
      };
    },

    async pending(userId) {
      // One more than the door publishes, so a full page is seen as too many and never silently cut.
      const answer = await pay.records({ userId, statuses: [...PAY_CUSTODY_DEPOSIT_PENDING_STATUSES], offset: 0, limit: 101 });
      if (answer.state !== 'ok') return null;
      return answer.records.items.map((record) => ({
        id: record.id,
        assetId: record.assetId,
        networkId: record.networkId,
        amount: record.amount,
        confirmations: record.confirmations,
        confirmationsRequired: record.confirmationsRequired,
      }));
    },

    async records(query) {
      const answer = await pay.records({ ...query, statuses: query.statuses ? [...query.statuses] : undefined });
      return answer.state === 'ok' ? answer.records : null;
    },
  };
}
