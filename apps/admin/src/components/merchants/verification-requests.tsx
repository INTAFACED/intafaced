import type { KybRequestsView } from '@intafaced/contracts/kyb-information-requests';
import { Chip, type ChipTone } from '@/components/chip';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { KYB_REQUEST_STATE_WORDS } from '@/lib/merchants/kyb-review-model';
import { formatUtc } from '@/lib/merchants/time';
import { Card, FailureState, StateBlock } from './ui';
import { OpenRequestFile } from './verification-forms';
import { CloseInformationRequest, NewInformationRequest } from './verification-request-forms';

const TONE: Record<string, ChipTone> = { open: 'warn', answered: 'live', closed: 'neutral' };

/**
 * What compliance asked the merchant for (J-merchant-02 step 4): each request's words and due date, the merchant's
 * answer and file, and who closed it. A file answer is scanned before svc-pay keeps it; an infected one never arrives.
 */
export function VerificationRequests({
  merchantId,
  result,
  here,
}: {
  merchantId: string;
  result: PayCallResult<KybRequestsView> | undefined;
  here: string;
}) {
  if (!result) return null;
  if (result.kind !== 'ok') return <FailureState failure={result} what="Information requests" retryHref={here} />;
  const { requests, scanner } = result.data;
  return (
    <Card
      id="information-requests"
      title="Information requests"
      sub="Ask the merchant for something more, with a due date. The merchant answers once, with a note, a file or both."
    >
      {scanner.status === 'not_connected' ? (
        <StateBlock kind="info" title="No malware scanner connected">
          Files cannot be sent in answer until a malware scanner is connected, so the merchant can answer with a note only.
        </StateBlock>
      ) : null}
      {requests.length === 0 ? (
        <StateBlock kind="empty" title="No information requests">
          Nothing has been asked of this merchant. This is a successful read, not an error.
        </StateBlock>
      ) : (
        <ul className="mp-requests" aria-label="Information requests">
          {requests.map((request, n) => {
            const label = `request ${requests.length - n}`;
            return (
              <li key={request.id} data-testid="kyb-request" className="mp-requests__item">
                <p>
                  <Chip tone={request.pastDue ? 'danger' : (TONE[request.state] ?? 'neutral')}>
                    {request.pastDue ? 'Past due' : (KYB_REQUEST_STATE_WORDS[request.state] ?? request.state)}
                  </Chip>{' '}
                  {request.text}
                </p>
                <p className="mp-hint">
                  Due {formatUtc(request.dueAt)}. Asked by <code title={request.createdBy}>{request.createdBy.slice(0, 8)}</code>,{' '}
                  {formatUtc(request.createdAt)}.
                </p>
                {request.answer ? (
                  <div>
                    <p className="mp-hint">Answered {formatUtc(request.answer.answeredAt)}.</p>
                    {request.answer.note ? <p>Merchant’s note: {request.answer.note}</p> : null}
                    {request.answer.file ? (
                      <p className="mp-hint">
                        {request.answer.file.contentType}, {request.answer.file.byteLength} bytes, passed the malware scan.{' '}
                        <OpenRequestFile
                          requestId={request.id}
                          contentType={request.answer.file.contentType}
                          label={`Open the file sent for ${label}`}
                        />
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="mp-muted">No answer yet.</p>
                )}
                {request.state === 'closed' && request.closedBy && request.closedAt ? (
                  <p className="mp-hint">
                    Closed by <code title={request.closedBy}>{request.closedBy.slice(0, 8)}</code>, {formatUtc(request.closedAt)}:{' '}
                    {request.closeNote}
                  </p>
                ) : (
                  <CloseInformationRequest requestId={request.id} label={`Close ${label}`} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="mp-requests__title">New request</h3>
      <NewInformationRequest merchantId={merchantId} />
    </Card>
  );
}
