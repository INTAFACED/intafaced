import 'server-only';
import { BANK_OPS_FRAUD_PREVIEW, type FraudPreviewView } from '@intafaced/contracts/bank-credit-preview-procedures';
import { edgeCall, parseWith, partFrom, type Part } from '@/lib/desk';
import { treasuryTransport } from '@/lib/ledger';

/**
 * The card fraud risk preview (BK-cops-09, J-bank-12 #5): svc-bank `ops.fraudPreview`, TEST rows only. It asks for
 * `admin:treasury`, which a founder session never carries, so it goes on the console's treasury transport, like the other
 * treasury hops (lib/recon-alerts/treasury.ts). The path, method and reply schema come from its record. No fraud engine
 * exists, so nothing here scores or decides a real authorisation.
 */
export type FraudPreview = FraudPreviewView;

export async function readFraudPreview(): Promise<Part<FraudPreview>> {
  const transport = treasuryTransport();
  const result =
    'reason' in transport
      ? ({ kind: 'unavailable', uncertain: false, requestId: null } as const)
      : await edgeCall(
          transport,
          BANK_OPS_FRAUD_PREVIEW.module,
          BANK_OPS_FRAUD_PREVIEW.path,
          'GET',
          undefined,
          parseWith(BANK_OPS_FRAUD_PREVIEW.output),
        );
  return partFrom(result, (d) => d, {
    service: 'svc-bank',
    forbiddenMessage: 'svc-bank did not accept the console treasury credential for the fraud preview. Reading needs admin:treasury.',
  });
}
