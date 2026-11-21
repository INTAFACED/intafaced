import 'server-only';
import { BANK_OPS_FRAUD_PREVIEW, type FraudPreviewView } from '@intafaced/contracts/bank-credit-preview-procedures';
import { founderRecordCall, partFrom, type FounderCallContext, type Part } from '@/lib/desk';

/**
 * The card fraud risk preview (BK-cops-09, J-bank-12 #5): svc-bank `ops.fraudPreview`, read by its record; TEST rows only.
 * No fraud engine exists, so nothing here scores or decides a real authorisation.
 */
export type FraudPreview = FraudPreviewView;

export async function readFraudPreview(ctx: FounderCallContext): Promise<Part<FraudPreview>> {
  const result = await founderRecordCall(ctx, BANK_OPS_FRAUD_PREVIEW, undefined);
  return partFrom(result, (d) => d, {
    service: 'svc-bank',
    forbiddenMessage: 'svc-bank did not accept this founder session for the fraud preview. Reading needs admin:read.',
  });
}
