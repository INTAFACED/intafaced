import { useState } from 'react';
import { StatusTag } from '@intafaced/ui';
import { kycHistoryOutputSchema, type KycCase, type KycCaseState } from '@intafaced/contracts/identity-kyc-cases';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { verificationCasesCopy as copy } from './verification-cases-copy';

type Tier = KycCase['tier'];
const PAGE = 10;
const tagOf: Record<KycCaseState, 'pending' | 'filled' | 'cancelled' | 'working'> = {
  submitted: 'pending',
  approved: 'filled',
  rejected: 'cancelled',
  // A lapsed approval no longer counts, so it reads as ended, never as work in progress.
  expired: 'cancelled',
};

/**
 * I-kyc-compliance-01 (J-identity-08 #6): the person's verification cases on /verification, newest first. Each case
 * shows its state and each step it went through; a reject shows the owner's reason and what to do about it, and the
 * reviewer's note only when the reviewer marked it for the customer. "Send a new request" on the newest rejected case
 * fills the request form with that level; it grants nothing. `recordsKey` is the page's own status read, so a new or
 * decided request reads the cases again.
 */
export function VerificationCases({
  recordsKey,
  offered,
  resubmitDisabled,
  onResubmit,
}: {
  recordsKey: string;
  offered: readonly Tier[];
  resubmitDisabled: boolean;
  onResubmit: (tier: Tier) => void;
}) {
  const { api, userId } = useSession();
  const { t, Copy, requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  const [limit, setLimit] = useState(PAGE);
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'kyc.history', { limit }, kycHistoryOutputSchema, { signal }),
    `verification-cases:${userId}:${limit}:${recordsKey}`,
  );
  const time = (iso: string) => (
    <time dateTime={iso} lang={requestedLocale}>
      {stamp(iso, timeZone)}
    </time>
  );
  const body = () => {
    if (resource.status === 'loading') return <Loading />;
    if (resource.status === 'failed')
      return (
        <>
          <h3>
            <Copy k="failedTitle" />
          </h3>
          <Failure result={resource.failure} retry={reload} />
        </>
      );
    const { cases } = resource.data;
    if (cases.length === 0)
      return (
        <EmptyState title={t('empty')}>
          <Copy k="intro" />
        </EmptyState>
      );
    // Only the newest case can be followed by a new request; an older rejected case already was, or a newer one is open.
    const newest = cases[0]!;
    return (
      <>
        <ol className="verification__case-list">
          {cases.map((c) => (
            <li key={c.id} className="verification__case" data-case={c.id} data-state={c.state}>
              <div className="verification__case-head">
                <h3>
                  <Copy k={c.tier} /> · <span lang="zxx">{c.jurisdiction}</span>
                </h3>
                <StatusTag status={tagOf[c.state]} label={t(c.state)} />
              </div>
              <p className="muted">
                <Copy k="submittedAt" /> {time(c.submittedAt)}
                {c.decidedAt && (
                  <>
                    {' · '}
                    <Copy k="decidedAt" /> {time(c.decidedAt)}
                  </>
                )}
              </p>
              {c.followsCaseId && (
                <p className="muted verification__case-follows">
                  <Copy k="follows" />
                </p>
              )}
              {c.state === 'rejected' && (
                <div className="verification__case-reason" data-reason={c.reason?.code ?? ''}>
                  {c.reason === null ? (
                    <p>
                      <Copy k="reasonMissing" />
                    </p>
                  ) : c.reason.text === null ? (
                    <>
                      <p>
                        <Copy k="reasonCode" params={{ code: c.reason.code }} />
                      </p>
                      <p className="muted">
                        <Copy k="reasonCodeUnlisted" />
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="verification__case-reason-text">
                        <Copy k="reason" params={{ text: c.reason.text }} />
                      </p>
                      {c.reason.guidance && (
                        <p className="verification__case-guidance">
                          <Copy k="whatToDo" params={{ text: c.reason.guidance }} />
                        </p>
                      )}
                    </>
                  )}
                  {c.note && (
                    <p className="verification__case-note">
                      <Copy k="note" params={{ text: c.note }} />
                    </p>
                  )}
                  {c.id === newest.id && offered.includes(c.tier) && (
                    <>
                      <Button variant="secondary" disabled={resubmitDisabled} onClick={() => onResubmit(c.tier)}>
                        <Copy k="resubmit" />
                      </Button>
                      <p className="muted">
                        <Copy k="resubmitHelp" />
                      </p>
                    </>
                  )}
                </div>
              )}
              <h4>
                <Copy k="stepsTitle" />
              </h4>
              <ol className="verification__case-steps">
                {c.history.map((step) => (
                  <li key={step.version} data-state={step.state}>
                    <Copy k={`step_${step.state}`} /> · {time(step.at)}
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
        {cases.length === limit && limit < 200 && (
          <Button variant="secondary" onClick={() => setLimit((value) => Math.min(200, value + PAGE))}>
            <Copy k="more" />
          </Button>
        )}
      </>
    );
  };
  return (
    <section className="verification__cases" aria-labelledby="verification-cases-title">
      <h2 id="verification-cases-title">
        <Copy k="title" />
      </h2>
      {body()}
    </section>
  );
}
