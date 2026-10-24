'use client';

import { ControlDesk, type ControlAction } from '@/components/control-desk';
import { rowText } from '@/lib/ops-desk/actions-model';
import type { Row } from '@/lib/ops-desk/types';
import './desk.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Open one KYC document from a list row (J-ops-console-02 #5). Identity serves a document's contents only through its
 * two-founder door: you ask, a different founder approves that document on their console, and you run it. The document then
 * shows in the viewer below, on your page only.
 */
export function KycDocumentOpen({ row, userId, onChanged }: { row: Row; userId: string; onChanged: () => void }) {
  const documentId = rowText(row, 'id');
  if (documentId === null || !UUID.test(documentId))
    return (
      <p className="dk-muted" data-testid="kyc-document-no-open">
        This row has no document id the console can ask identity for, so it cannot be opened from here.
      </p>
    );
  const action: ControlAction = {
    heading: 'Open this document',
    submitLabel: 'Ask a second founder to approve opening it',
    needsReason: false,
    reasonLabel: '',
    build: () => ({ kind: 'identity.kyc_document.open', documentId }),
  };
  return (
    <div className="dk-stack" data-testid="kyc-document-open">
      <ControlDesk
        key={documentId}
        endpoint="/api/accounts/documents"
        userId={userId}
        blockedReason={null}
        action={action}
        consequence="Identity decrypts the document and shows it on your console, once per approval, and records that you read it. A different founder has to approve the read first. Nothing about the document or the account changes."
        blockedButtonLabel="Opening unavailable"
        onChanged={onChanged}
      />
    </div>
  );
}
