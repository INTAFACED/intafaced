import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { Button, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { ResourceView, useBankRead } from './components';
import { bankWrites, type cardSchema, type CardThreeDSChallenge } from './contracts';
import { DepthPanel } from './DepthParts';
import { Refusal } from './CardJourney';
import { cardSafetyCopy } from './card-safety-copy';
import { withPlainRefusal } from './money-refusal-copy';

/**
 * A card's 3D Secure checks and its fraud report (J-bank-14 #5 #7; BK-cpay-01). A check is the card partner asking the
 * person to confirm an online purchase with the code it sent them: a wrong code counts, the owner's count locks it, and
 * the right code makes the purchase go through once (svc-bank `card-safety.ts`). The TEST partner's code is shown with
 * TEST, on the TEST stack only. A fraud report locks the card and opens one case for the payment; the safety messages
 * stay on the screen.
 */

type CardRecord = z.infer<typeof cardSchema>;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function CardThreeDSPanel({ card }: { card: CardRecord }) {
  const { t } = cardSafetyCopy.useCopy();
  const read = useBankRead('cards.threeDS.list', { cardId: card.id });
  return (
    <DepthPanel title={t('threeDSTitle')} lead={t('threeDSLead')}>
      <ResourceView resource={read.resource} reload={read.reload}>
        {({ challenges }) =>
          challenges.length ? (
            <ul aria-label={t('threeDSList')} className="form-stack">
              {challenges.map((challenge) => (
                <ThreeDSChallenge key={challenge.id} card={card} challenge={challenge} reload={read.reload} />
              ))}
            </ul>
          ) : (
            <p className="muted">{t('threeDSNone')}</p>
          )
        }
      </ResourceView>
    </DepthPanel>
  );
}

function ThreeDSChallenge({ card, challenge, reload }: { card: CardRecord; challenge: CardThreeDSChallenge; reload: () => void }) {
  const { api } = useSession();
  const { t } = cardSafetyCopy.useCopy();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [wrong, setWrong] = useState<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const at = t('threeDSAt', {
    amount: `${challenge.amount} ${card.assetId}`,
    merchant: challenge.merchant ?? t('threeDSAnyMerchant'),
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{4,8}$/.test(code)) return setInvalid(true);
    setInvalid(false);
    setBusy(true);
    setFailure(null);
    const done = await api.mutate(
      'bank',
      'cards.threeDS.answer',
      { cardId: card.id, challengeId: challenge.id, code },
      bankWrites['cards.threeDS.answer'],
    );
    setBusy(false);
    setCode('');
    if (!done.ok) return setFailure(withPlainRefusal(done));
    setWrong(done.data.state === 'open' ? done.data.triesLeft : null);
    reload();
  }

  return (
    <li data-challenge={challenge.challengeRef} data-state={challenge.state}>
      <p>{at}</p>
      {challenge.state === 'approved' && <p role="status">{t('threeDSApproved')}</p>}
      {challenge.state === 'locked' && <p role="status">{t('threeDSLocked')}</p>}
      {challenge.state === 'open' && (
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          {challenge.testCode && <p className="money-caption">{t('threeDSTestCode', { code: challenge.testCode })}</p>}
          <p className="money-caption" role="status">
            {wrong === null ? t('threeDSOpen', { count: challenge.triesLeft }) : t('threeDSTriesLeft', { count: wrong })}
          </p>
          <Field
            label={t('threeDSCode')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
            {...(invalid ? { error: t('threeDSDigits') } : {})}
          />
          <div className="actions">
            <Button type="submit" disabled={busy}>
              {t('threeDSSubmit')}
            </Button>
          </div>
        </form>
      )}
      {failure && <Refusal failure={failure} />}
    </li>
  );
}

export function CardFraudPanel({ card }: { card: CardRecord }) {
  const { api } = useSession();
  const { t } = cardSafetyCopy.useCopy();
  const payments = useBankRead('cards.authorizations', { cardId: card.id, limit: 20 });
  const reports = useBankRead('cards.fraud.list', { cardId: card.id });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [locked, setLocked] = useState(false);

  async function report(authorizationId: string) {
    setBusy(true);
    setFailure(null);
    const done = await api.mutate(
      'bank',
      'cards.fraud.report',
      { cardId: card.id, authorizationId, reportId: crypto.randomUUID() },
      bankWrites['cards.fraud.report'],
    );
    setBusy(false);
    if (!done.ok) return setFailure(withPlainRefusal(done));
    setLocked(true);
    reports.reload();
  }

  return (
    <>
      <DepthPanel title={t('fraudTitle')} lead={t('fraudLead')}>
        <ResourceView resource={reports.resource} reload={reports.reload}>
          {({ reports: open }) => {
            const reported = new Map(open.map((r) => [r.authorizationId, r]));
            return (
              <>
                {(locked || (open.length > 0 && card.status !== 'active')) && <p role="status">{t('fraudLocked')}</p>}
                {open.length > 0 && (
                  <ul aria-label={t('fraudCases')}>
                    {open.map((r) => (
                      <li key={r.id} data-report={r.id}>
                        {t('fraudCase', { id: r.id.slice(0, 8), time: timeOf(r.createdAt) })}
                      </li>
                    ))}
                  </ul>
                )}
                <ResourceView resource={payments.resource} reload={payments.reload}>
                  {(list) => {
                    const approved = list.filter((p) => p.decision === 'approved');
                    if (!approved.length) return <p className="muted">{t('fraudNone')}</p>;
                    return (
                      <ul aria-label={t('fraudList')}>
                        {approved.map((p) => (
                          <li key={p.id} data-authorization={p.authorizationRef}>
                            {reported.has(p.id) ? (
                              t('fraudReported', { id: reported.get(p.id)!.id.slice(0, 8) })
                            ) : (
                              <Button variant="secondary" disabled={busy} onClick={() => void report(p.id)}>
                                {t('fraudReport', { ref: p.authorizationRef })}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    );
                  }}
                </ResourceView>
              </>
            );
          }}
        </ResourceView>
        {failure && <Refusal failure={failure} />}
      </DepthPanel>
      <DepthPanel title={t('safetyTitle')}>
        <ul>
          <li>{t('safetyCode')}</li>
          <li>{t('safetyLink')}</li>
          <li>{t('safetyReplace')}</li>
        </ul>
      </DepthPanel>
    </>
  );
}
