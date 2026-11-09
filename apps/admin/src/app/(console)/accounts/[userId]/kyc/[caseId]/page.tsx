import { notFound } from 'next/navigation';
import { KycCaseDetail } from '@/components/kyc-case-detail';
import { customerId, identityDocumentsRead, kycCasesRead } from '@/lib/customer-record/record';
import { mayReadTab } from '@/lib/customer-record/tabs';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { loadReads } from '@/lib/ops-desk/server';

/**
 * One KYC case of one person (`/accounts/:userId/kyc/:caseId`, OPS-cases-07): the case as identity holds it, and the documents
 * attached to its verification, each opened in the same KYC document viewer as the customer record's documents tab, with the
 * same second-founder approval. Read as the signed-in person when the page opens; nothing is cached.
 */
export default async function KycCasePage({ params }: { params: Promise<{ userId: string; caseId: string }> }) {
  requireModulePage('accounts');
  const founder = await requireFounderPage();
  const raw = await params;
  const userId = customerId(raw.userId);
  const caseId = customerId(raw.caseId);
  if (userId === null || caseId === null) notFound();
  // The case and its documents are the documents tab's: a person who may not read that area is refused and nothing is read.
  if (!mayReadTab(founder.operator, 'documents'))
    return <KycCaseDetail userId={userId} caseId={caseId} founderId={founder.session.userId} denied />;
  const caseRead = kycCasesRead(userId, caseId);
  const caseOutcome = (await loadReads(founder, [caseRead]))[caseRead.id];
  // The verification this case decides, from identity's own answer. Its documents are read only once the case is found.
  const found = caseOutcome?.part.kind === 'ok' && caseOutcome.part.data.shape === 'list' ? caseOutcome.part.data.rows[0] : undefined;
  const recordId = found?.cells.find((cell) => cell.key === 'recordId')?.value;
  const documents = typeof recordId === 'string' ? identityDocumentsRead(userId, recordId) : null;
  const documentOutcomes = documents ? await loadReads(founder, [documents]) : {};
  return (
    <KycCaseDetail
      userId={userId}
      caseId={caseId}
      founderId={founder.session.userId}
      caseRead={caseRead}
      caseOutcome={caseOutcome}
      found={found !== undefined}
      documents={documents}
      documentOutcome={documents ? documentOutcomes[documents.id] : undefined}
    />
  );
}
