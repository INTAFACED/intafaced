import { useState } from 'react';
import { StatusChip } from '@intafaced/ui/lit/templates';
import { type KycCase, type KycCaseState } from '@intafaced/contracts/identity-kyc-cases';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui/lit';
import { Empty, Failure, Loading } from './kit-parts';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { verificationCasesCopy as copy } from './verification-cases-copy';
import { IDENTITY_KYC_HISTORY } from '@intafaced/contracts/identity-kyc-procedures';

type Tier = KycCase['tier'];
const PAGE = 10;
const tagOf: Record<KycCaseState, 'pending' | 'done' | 'failed'> = {
  submitted: 'pending',
  approved: 'done',
  rejected: 'failed',
  // A lapsed approval no longer counts, so it reads as ended, never as work in progress.
  expired: 'failed',
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
    (signal) => api.call(IDENTITY_KYC_HISTORY, { limit }, { signal }),
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
        <Empty title={t('empty')}>
          <Copy k="intro" />
        </Empty>
      );
    // Only the newest case can be followed by a new request; an older rejected case already was, or a newer one is open.
    const newest = cases[0]!;
    return (
      <>
        <ol className="lt-sections">
          {cases.map((c) => (
            <li key={c.id} className="lt-stack" data-testid="verification__case" data-case={c.id} data-state={c.state}>
              <div className="lt-title-row">
                <h3>
                  <Copy k={c.tier} /> · <span lang="zxx">{c.jurisdiction}</span>
                </h3>
                <StatusChip status={tagOf[c.state]} label={t(c.state)} />
              </div>
              <p className="lt-muted">
                <Copy k="submittedAt" /> {time(c.submittedAt)}
                {c.decidedAt && (
                  <>
                    {' · '}
                    <Copy k="decidedAt" /> {time(c.decidedAt)}
                  </>
                )}
              </p>
              {c.followsCaseId && (
                <p className="lt-muted" data-testid="verification__case-follows">
                  <Copy k="follows" />
                </p>
              )}
              {c.state === 'rejected' && (
                <div className="lt-stack" data-testid="verification__case-reason" data-reason={c.reason?.code ?? ''}>
                  {c.reason === null ? (
                    <p>
                      <Copy k="reasonMissing" />
                    </p>
                  ) : c.reason.text === null ? (
                    <>
                      <p>
                        <Copy k="reasonCode" params={{ code: c.reason.code }} />
                      </p>
                      <p className="lt-muted">
                        <Copy k="reasonCodeUnlisted" />
                      </p>
                    </>
                  ) : (
                    <>
                      <p data-testid="verification__case-reason-text">
                        <Copy k="reason" params={{ text: c.reason.text }} />
                      </p>
                      {c.reason.guidance && (
                        <p data-testid="verification__case-guidance">
                          <Copy k="whatToDo" params={{ text: c.reason.guidance }} />
                        </p>
                      )}
                    </>
                  )}
                  {c.note && (
                    <p>
                      <Copy k="note" params={{ text: c.note }} />
                    </p>
                  )}
                  {c.id === newest.id && offered.includes(c.tier) && (
                    <>
                      <Button tone="secondary" disabled={resubmitDisabled} onClick={() => onResubmit(c.tier)}>
                        <Copy k="resubmit" />
                      </Button>
                      <p className="lt-muted">
                        <Copy k="resubmitHelp" />
                      </p>
                    </>
                  )}
                </div>
              )}
              <h4>
                <Copy k="stepsTitle" />
              </h4>
              <ol className="lt-list" data-testid="verification__case-steps">
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
          <Button tone="secondary" onClick={() => setLimit((value) => Math.min(200, value + PAGE))}>
            <Copy k="more" />
          </Button>
        )}
      </>
    );
  };
  return (
    <section className="lt-stack" aria-labelledby="verification-cases-title">
      <h2 id="verification-cases-title">
        <Copy k="title" />
      </h2>
      {body()}
    </section>
  );
}
