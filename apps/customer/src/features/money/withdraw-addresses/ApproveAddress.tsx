import { useEffect, useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { date } from '../components';
import { destinationSchema, type Destination } from '../contracts';
import { moneyRefusalWords } from '../money-refusal-copy';
import { shortenAddress } from '../withdraw-model';
import { withdrawalCopy } from '../withdrawal-copy';
import { StepUpSheet } from './StepUpSheet';

/** Refusals that mean this link can never work, so the page says so instead of offering Approve again. */
const DEAD = {
  'bank.address_approval_link_invalid': 'apInvalid',
  'bank.address_approval_link_expired': 'apExpired',
  'bank.address_approval_link_replaced': 'apReplaced',
  'bank.address_approval_not_pending': 'apNotPending',
  'bank.withdraw_destination_missing': 'apNotPending',
} as const;

/**
 * `/approveAddress?token=…` (W-withdraw-09, J-wallet-04 #5): the page the approval email links to. It needs the account
 * the link was sent to, signed in, and a fresh confirmation (`trade:withdraw`), so approving takes the mailbox and the
 * second factor. Opening the page spends nothing, so a mail scanner that fetches the link does not use it; the person
 * presses Approve. The token leaves the address bar once read and is never shown.
 */
export function ApproveAddress({ search }: { search: string }) {
  const { t } = withdrawalCopy.useCopy();
  const { api } = useSession();
  const token = useRef(new URLSearchParams(search).get('token')?.trim() ?? '').current;
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Destination | null>(null);
  const [dead, setDead] = useState<(typeof DEAD)[keyof typeof DEAD] | 'apNoToken' | null>(token ? null : 'apNoToken');
  const answered = useRef<Destination | null>(null);

  useEffect(() => {
    // The token stays out of the address bar and history once read.
    if (location.search) history.replaceState(history.state, '', location.pathname);
  }, []);

  const label = (row: Destination) => row.label ?? shortenAddress(row.ref);
  return (
    <FlowTemplate
      title={done ? t('apDoneTitle') : dead ? t('apDeadTitle') : t('apTitle')}
      state={{ kind: 'ready' }}
      step={
        <>
          <div data-testid="approve-address">
            {done ? (
              <p role="status">
                {done.coolingOffEndsAt
                  ? t('apDone', { label: label(done), time: date(done.coolingOffEndsAt) })
                  : t('apDoneNoTime', { label: label(done) })}
              </p>
            ) : dead ? (
              <p role="alert">{t(dead)}</p>
            ) : (
              <>
                <p>{t('apIntro')}</p>
                <p>
                  <Button tone="primary" onClick={() => setConfirming(true)}>
                    {t('apApprove')}
                  </Button>
                </p>
              </>
            )}
            <p>
              <a className="lt-link" href="/uc/withdraw/address">
                {t('apToBook')} ↗
              </a>
            </p>
          </div>
          {confirming && (
            <StepUpSheet
              why={t('aApproveWhy')}
              run={async (bearer) => {
                const answer = await api.mutate('bank', 'ramps.destinations.approval.confirmLink', { token }, destinationSchema, {
                  bearer,
                });
                if (answer.ok) {
                  answered.current = answer.data;
                  return answer;
                }
                const code = answer.code as keyof typeof DEAD | undefined;
                if (code && code in DEAD) {
                  // Nothing the person can fix in this dialog: it closes and the page says what to do next.
                  setDead(DEAD[code]);
                  setConfirming(false);
                }
                return { ...answer, message: moneyRefusalWords(answer.code) ?? t('apFailed') };
              }}
              onDone={() => {
                setConfirming(false);
                setDone(answered.current);
              }}
              onCancel={() => setConfirming(false)}
            />
          )}
        </>
      }
    />
  );
}
