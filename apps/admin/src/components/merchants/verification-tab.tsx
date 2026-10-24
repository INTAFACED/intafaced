import type { KybDocumentReviewView } from '@intafaced/contracts/kyb-documents';
import { Chip, type ChipTone } from '@/components/chip';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { documentWords, KYB_DOCUMENT_STATE_WORDS } from '@/lib/merchants/kyb-review-model';
import { formatUtc } from '@/lib/merchants/time';
import { Card, FailureState, shortId, StateBlock } from './ui';
import { DocumentVerdict, OpenDocument } from './verification-forms';

const TONE: Record<string, ChipTone> = { missing: 'neutral', provided: 'warn', accepted: 'live', rejected: 'danger' };

/**
 * The merchant's business application as compliance reviews it (J-merchant-02 step 3): each document its type asks
 * for, the file to open, and one verdict per file. Verified and Invalid are what the merchant reads; a rejection's
 * reason is shown to them word for word. Deciding the verification itself stays in the two-founder KYB door.
 */
export function VerificationTab({ result, here }: { result: PayCallResult<KybDocumentReviewView> | undefined; here: string }) {
  if (!result) return null;
  if (result.kind !== 'ok') return <FailureState failure={result} what="The business application" retryHref={here} />;
  const { application, rows, vendorCheck } = result.data;
  if (!application) {
    return (
      <Card id="verification" title="Business application" sub="What the merchant sent to get verified.">
        <StateBlock kind="empty" title="No business application">
          This merchant has not started one. A business verified with a verification reference has none. This is a successful read, not an
          error.
        </StateBlock>
      </Card>
    );
  }
  return (
    <Card
      id="verification"
      title="Business application"
      sub="Open each file, then mark it Verified or Invalid. The merchant sees the verdict and, for Invalid, your reason."
    >
      <div className="mp-facts" aria-label="Application">
        <div>
          <span className="mp-facts__k">Application</span>
          <span className="mp-facts__v">
            <code title={application.applicationId}>{shortId(application.applicationId)}</code>
          </span>
        </div>
        <div>
          <span className="mp-facts__k">Legal entity type</span>
          <span className="mp-facts__v">{documentWords(application.entityType)}</span>
        </div>
        <div>
          <span className="mp-facts__k">Country</span>
          <span className="mp-facts__v">{application.country}</span>
        </div>
        <div>
          <span className="mp-facts__k">State</span>
          <span className="mp-facts__v">
            {application.state === 'submitted' && application.submittedAt
              ? `Sent for review ${formatUtc(application.submittedAt)}`
              : 'Draft: the merchant is still filling it in'}
          </span>
        </div>
      </div>
      {vendorCheck.status === 'not_connected' ? (
        <StateBlock kind="info" title="No automatic document check">
          The automatic document check is not connected, so no file has been checked by machine. Each verdict here is a person’s.
        </StateBlock>
      ) : null}
      {rows.length === 0 ? (
        <StateBlock kind="empty" title="No documents asked for">
          This entity type asks for no documents, or its requirements are no longer published.
        </StateBlock>
      ) : (
        <div className="mp-scroll" tabIndex={0} role="region" aria-label="Documents, scrolls sideways on small screens">
          <table className="mp-table mp-table--rows">
            <caption className="mp-visually-hidden">Documents of the business application</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Status</th>
                <th scope="col">File</th>
                <th scope="col">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} data-testid="kyb-document">
                  <th scope="row">{documentWords(row.key)}</th>
                  <td>
                    <Chip tone={TONE[row.state] ?? 'neutral'}>{KYB_DOCUMENT_STATE_WORDS[row.state] ?? row.state}</Chip>
                    {row.rejectionReason ? <p className="mp-hint">Reason given: {row.rejectionReason}</p> : null}
                    {row.reviewedBy && row.reviewedAt ? (
                      <p className="mp-hint">
                        By founder <code title={row.reviewedBy}>{row.reviewedBy.slice(0, 8)}</code>, {formatUtc(row.reviewedAt)}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    {row.document ? (
                      <>
                        <span className="mp-hint">
                          {row.document.contentType}, {row.document.byteLength} bytes, sent {formatUtc(row.document.uploadedAt)}
                        </span>
                        <OpenDocument
                          applicationId={application.applicationId}
                          documentId={row.document.id}
                          name={documentWords(row.key)}
                        />
                      </>
                    ) : (
                      <span className="mp-muted">Not sent</span>
                    )}
                  </td>
                  <td>
                    {row.document && row.state === 'provided' ? (
                      <DocumentVerdict
                        applicationId={application.applicationId}
                        documentId={row.document.id}
                        name={documentWords(row.key)}
                      />
                    ) : (
                      <span className="mp-muted">{row.document ? 'Given' : 'Nothing to review'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
