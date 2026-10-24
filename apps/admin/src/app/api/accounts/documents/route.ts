import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { kycDocumentOpenExecute } from '@/lib/kyc-documents/open';

/**
 * Opening one KYC document from identity's encrypted vault (J-ops-console-02 #5), from the customer record's documents tab.
 *
 * POST runs one step of a two-founder request: the first founder asks to open a document, a different founder approves that
 * document, and the run reads it from identity (`kyc.getDocument`), which spends the approval once.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['identity.kyc_document.open'],
    check: () => null,
    execute: kycDocumentOpenExecute(session),
  });
}
