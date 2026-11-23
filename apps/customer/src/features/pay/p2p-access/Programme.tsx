import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { useResource } from '../../../shared/resource';
import { payCopy, PayCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import { Field, PayDetails, PayNotice, PaySection, PayState, ReviewedAction } from '../volt/parts';

/** The person's own P2P trading programme: its standing, leaving or applying again, and P2P API eligibility. */
export function TradingProgramme({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [reason, setReason] = useState('');
  const standing = useResource((signal) => pay.standing(signal), `pay:p2p-standing:${userId}`);
  const access = useResource((signal) => pay.apiAccess(signal), `pay:p2p-api-access:${userId}`);
  function refresh() {
    standing.reload();
    access.reload();
  }
  return (
    <div className="lt-stack">
      <PayNotice title={payCopy.t('p2pTradingStanding')}>
        <PayCopy k="thisProgrammeIsYourPersonalP2pTrading" />
      </PayNotice>
      <PaySection
        title={payCopy.t('yourProgrammeStatus')}
        action={
          <Button tone="secondary" onClick={refresh}>
            <PayCopy k="refreshStanding" />
          </Button>
        }
      >
        <PayState resource={standing.resource} retry={standing.reload}>
          {(data) =>
            data ? (
              <div className="lt-stack">
                <PayDetails
                  values={[
                    [payCopy.t('standing'), data.status],
                    [payCopy.t('applicationSubmitted'), data.appliedAt],
                    [payCopy.t('decision'), data.decidedAt ?? payCopy.t('notRecorded')],
                    [payCopy.t('tradesAtApplication'), String(data.appliedTradesTotal)],
                  ]}
                />
                {['applied', 'approved', 'suspended'].includes(data.status) && (
                  <>
                    <Field label={payCopy.t('reasonForLeaving')} value={reason} onChange={(event) => setReason(event.target.value)} />
                    <ReviewedAction
                      title={payCopy.t('leaveP2pProgramme')}
                      description={payCopy.t('withdrawYourPersonalP2pProgrammeMembershipYour')}
                      review={<p>{reason}</p>}
                      perform={() => pay.withdrawProgramme(reason.trim())}
                      onConfirmed={refresh}
                      disabled={!reason.trim()}
                    />
                  </>
                )}
                {['rejected', 'withdrawn'].includes(data.status) && (
                  <ReviewedAction
                    title={payCopy.t('reapplyToP2pProgramme')}
                    description={payCopy.t('submitANewApplicationBasedOnCurrent')}
                    perform={() => pay.applyProgramme()}
                    onConfirmed={refresh}
                  />
                )}
              </div>
            ) : (
              <div className="lt-stack">
                <p className="lt-muted">
                  <PayCopy k="noP2pProgrammeApplicationExistsForThis" />
                </p>
                <ReviewedAction
                  title={payCopy.t('applyToP2pProgramme')}
                  description={payCopy.t('submitAnApplicationOnYourOwnBehalf')}
                  perform={() => pay.applyProgramme()}
                  onConfirmed={refresh}
                />
              </div>
            )
          }
        </PayState>
      </PaySection>
      <PaySection title={payCopy.t('p2pApiEligibility')}>
        <PayState resource={access.resource} retry={access.reload}>
          {(data) => (
            <PayDetails
              values={[
                [
                  payCopy.t('apiStanding'),
                  data.eligible ? payCopy.t('eligibleByCurrentProgrammeStanding') : payCopy.t('notEligibleByCurrentProgrammeStanding'),
                ],
                [payCopy.t('currentCredential'), data.credential],
                [payCopy.t('disputeDecisions'), payCopy.t('interactiveHumanOnly')],
              ]}
            />
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
