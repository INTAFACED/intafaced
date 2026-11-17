'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ReadBlock } from '@/components/ops-desk';
import { RECORD_PERMISSION_DENIED } from '@/lib/customer-record/tabs';
import type { ReadOutcome, ReadSpec } from '@/lib/ops-desk/types';
import './desk.css';

/** The code the page carries when identity's answer holds no case with this id for this person. */
export const KYC_CASE_NOT_FOUND = 'ops.kyc_case_not_found';

export interface KycCaseDetailProps {
  readonly userId: string;
  readonly caseId: string;
  readonly founderId: string;
  readonly caseRead?: ReadSpec;
  readonly caseOutcome?: ReadOutcome | undefined;
  /** Identity answered and its answer holds this case. */
  readonly found?: boolean;
  /** The case's documents read, once the case is found. */
  readonly documents?: ReadSpec | null;
  readonly documentOutcome?: ReadOutcome | undefined;
  /** The signed-in person may not read identity documents: nothing was read. */
  readonly denied?: boolean;
}

/**
 * One KYC case: identity's answer for the case, then the documents attached to its verification. A document opens in the KYC
 * document viewer through the same two-founder request as on the customer record's documents tab, because it is the same read
 * and the same row action.
 */
export function KycCaseDetail(props: KycCaseDetailProps) {
  const { userId, caseId, founderId, caseRead, caseOutcome, found = false, documents = null, documentOutcome, denied = false } = props;
  const router = useRouter();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const ctx = { userId: founderId, onChanged: () => router.refresh() };
  const answered = caseOutcome?.part.kind === 'ok';
  return (
    <div className="dk-stack" data-testid="kyc-case-detail" data-case={caseId}>
      <header className="dk-stack">
        <p>
          <Link href={`/accounts/${encodeURIComponent(userId)}?tab=documents`}>← Customer record: documents</Link>
        </p>
        <h1>KYC case</h1>
        <p className="dk-muted">
          Case <code data-testid="kyc-case-id">{caseId}</code> of account <code>{userId}</code>, read as you from identity. Nothing is
          decided on this page; review decisions are on the Identity desk’s case queue.
        </p>
      </header>
      {denied ? (
        <article className="adm-callout" data-tone="danger" data-testid="customer-tab-denied" data-state="denied" role="alert">
          <strong>Permission denied</strong>
          <p>Your staff role may not read identity documents (the documents area), so nothing on this case was read.</p>
          <p className="dk-muted">Code: {RECORD_PERMISSION_DENIED}</p>
        </article>
      ) : null}
      {caseRead ? <ReadBlock spec={caseRead} outcome={caseOutcome} ctx={ctx} openKey={openKey} onOpen={setOpenKey} /> : null}
      {answered && !found ? (
        <article className="adm-callout" data-tone="warn" data-testid="kyc-case-not-found" role="alert">
          <strong>No such case</strong>
          <p>Identity holds no verification case with this id for this account, so no document is listed for it.</p>
          <p className="dk-muted">Code: {KYC_CASE_NOT_FOUND}</p>
        </article>
      ) : null}
      {documents ? (
        <section className="dk-stack" aria-labelledby="h-kyc-case-documents" data-testid="kyc-case-documents">
          <h2 id="h-kyc-case-documents">Documents attached to this case</h2>
          <ReadBlock spec={documents} outcome={documentOutcome} ctx={ctx} openKey={openKey} onOpen={setOpenKey} />
        </section>
      ) : null}
    </div>
  );
}
