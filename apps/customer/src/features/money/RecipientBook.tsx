import { useId, useMemo, useState } from 'react';
import { z } from 'zod';
import { usePreferences } from '../../shared/preferences';
import { Button, Failure, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { RailForm, filled, type Key } from './rail-form';
import { date } from './components';
import { railPayeeCheckSchema, railPayeeRemovedSchema, railPayeeSchema, type RailPayee, type RailRequirements } from './contracts';
import { DepthPanel } from './DepthParts';
import { railSendCopy } from './rail-send-copy';
import { WithdrawStepUp } from './WithdrawStepUp';

/**
 * The recipient book for bank rails (J-bank-04 #2): save an account by its country (which picks the forms it takes), see
 * each recipient's name check (cannot check: rail.bank) and its cooling-off as the bank answers it, remove one, and an
 * invite that the bank refuses by name while no email delivery is connected. Saving checks the form first, then needs a
 * fresh confirmation (`trade:withdraw`). Every state shown is the service's own answer.
 */

/** The cooling-off of one recipient, in words, with the code where the bank names one. */
export function CoolingWords({ payee }: { payee: RailPayee }) {
  const { t } = railSendCopy.useCopy();
  if (payee.cooling.state === 'active') return <>{t('coolingActive', { time: date(payee.cooling.endsAt) })}</>;
  if (payee.cooling.state === 'open') return <>{t('coolingOpen')}</>;
  return (
    <>
      {t('coolingUnset')} <small className="muted">{t('reference', { code: 'bank.payee_cooling_unset' })}</small>
    </>
  );
}

/** How many recipients the book reads at once: the service's page size. */
export const PAYEE_PAGE = 50;

function regionNames(language: string) {
  try {
    return new Intl.DisplayNames([language, 'en'], { type: 'region', fallback: 'code' });
  } catch {
    return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });
  }
}

function Invite() {
  const { t } = railSendCopy.useCopy();
  const { api } = useSession();
  const [email, setEmail] = useState('');
  const [answer, setAnswer] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function invite() {
    setBusy(true);
    setAnswer(null);
    const result = await api.mutate('bank', 'railSends.invitePayee', { email: email.trim() }, z.never());
    setBusy(false);
    if (!result.ok) setAnswer({ code: result.code, message: result.message });
  }
  return (
    <div className="bd-stack" data-testid="payee-invite">
      <h3>{t('inviteTitle')}</h3>
      <p className="money-caption">{t('inviteLead')}</p>
      <Field
        label={t('inviteEmail')}
        type="email"
        autoComplete="off"
        value={email}
        onChange={(event) => {
          setAnswer(null);
          setEmail(event.target.value);
        }}
      />
      <div className="actions">
        <Button disabled={busy || !email.trim()} onClick={() => void invite()}>
          {t('invite')}
        </Button>
      </div>
      {answer && (
        <p className="failure" role="alert" data-testid="payee-invite-answer">
          {answer.code === 'bank.payee_invite_unwired' ? t('inviteUnwired') : answer.message}{' '}
          {answer.code && <small className="muted">{t('reference', { code: answer.code })}</small>}
        </p>
      )}
    </div>
  );
}

export function RecipientBook({
  requirements,
  payees,
  reload,
  retry,
  failure,
}: {
  /** Null while the forms are not read; the book still shows, with the failure where there is one. */
  requirements: RailRequirements | null;
  payees: readonly RailPayee[] | null;
  reload: () => void;
  retry: () => void;
  failure: Parameters<typeof Failure>[0]['result'] | null;
}) {
  const { t } = railSendCopy.useCopy();
  const { api } = useSession();
  const { language } = usePreferences();
  const names = useMemo(() => regionNames(language), [language]);
  const [country, setCountry] = useState('');
  const [railId, setRailId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [nickname, setNickname] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeProblem, setRemoveProblem] = useState<string | null>(null);
  const countryField = useId();
  const railField = useId();

  const published = requirements ?? { rails: [], countries: [] };
  const countries = [...published.countries].sort((a, b) =>
    (names.of(a.country) ?? a.country).localeCompare(names.of(b.country) ?? b.country),
  );
  const offered = published.countries.find((row) => row.country === country)?.rails ?? [];
  const rail = offered.includes(railId as never) ? (published.rails.find((row) => row.rail === railId) ?? null) : null;
  const recipient = filled(rail, values);
  const ask = rail ? { nickname: nickname.trim(), country, rail: rail.rail, recipient } : null;

  function edit(fn: () => void) {
    setProblem(null);
    fn();
  }

  /** The bank checks the form first, so a typo is answered here before a code is spent. */
  async function save() {
    if (!ask || checking) return;
    setChecking(true);
    const checked = await api.query('bank', 'railSends.checkPayee', ask, railPayeeCheckSchema);
    setChecking(false);
    if (!checked.ok) {
      setProblem(checked.message || t('missing'));
      return;
    }
    setConfirming(true);
  }

  async function remove(payeeId: string) {
    setRemoving(payeeId);
    setRemoveProblem(null);
    const result = await api.mutate('bank', 'railSends.removePayee', { payeeId }, railPayeeRemovedSchema);
    setRemoving(null);
    if (result.ok) reload();
    else setRemoveProblem(result.message);
  }

  return (
    <DepthPanel title={t('bookTitle')} lead={t('bookLead')}>
      <div className="bd-stack" data-testid="payee-book">
        <div data-testid="payee-list">
          {failure ? (
            <Failure result={failure} retry={retry} />
          ) : payees === null ? null : payees.length === 0 ? (
            <p className="money-caption">{t('noPayees')}</p>
          ) : (
            payees.map((payee) => (
              <div className="money-space-row" key={payee.payeeId} data-testid="payee-row" data-cooling={payee.cooling.state}>
                <div>
                  <strong>{payee.nickname}</strong>
                  <small>
                    {names.of(payee.country) ?? payee.country} · {t(`rail_${payee.rail}` as Key)}
                  </small>
                </div>
                <span lang="und">{payee.recipient}</span>
                <span>
                  <span data-testid="payee-cooling">
                    <CoolingWords payee={payee} />
                  </span>
                  <br />
                  <small className="muted" data-testid="payee-name-check">
                    {t('nameCheck')} {t('reference', { code: payee.verificationRail })}
                  </small>
                </span>
                <Button disabled={removing === payee.payeeId} onClick={() => void remove(payee.payeeId)}>
                  {t('remove')}
                </Button>
              </div>
            ))
          )}
          {payees !== null && payees.length >= PAYEE_PAGE && <p className="money-caption">{t('bookMore', { count: PAYEE_PAGE })}</p>}
          {removeProblem && (
            <p className="error-text" role="alert" data-testid="payee-remove-problem">
              {removeProblem}
            </p>
          )}
        </div>

        <label className="field" htmlFor={countryField}>
          <span>{t('country')}</span>
          <select
            id={countryField}
            value={country}
            onChange={(event) =>
              edit(() => {
                setCountry(event.target.value);
                setRailId('');
                setValues({});
              })
            }
          >
            <option value="" />
            {countries.map((row) => (
              <option key={row.country} value={row.country}>
                {names.of(row.country) ?? row.country}
              </option>
            ))}
          </select>
        </label>
        {country && (
          <label className="field" htmlFor={railField}>
            <span>{t('howPaid')}</span>
            <select
              id={railField}
              value={rail?.rail ?? ''}
              onChange={(event) =>
                edit(() => {
                  setRailId(event.target.value);
                  setValues({});
                })
              }
            >
              <option value="" />
              {offered.map((id) => (
                <option key={id} value={id}>
                  {t(`rail_${id}` as Key)}
                </option>
              ))}
            </select>
          </label>
        )}
        {rail && (
          <>
            <div className="bd-stack" data-testid="payee-form" data-rail={rail.rail}>
              <RailForm
                rail={rail}
                values={values}
                onChange={(name, value) => edit(() => setValues((now) => ({ ...now, [name]: value })))}
              />
            </div>
            <Field
              label={t('nickname')}
              autoComplete="off"
              value={nickname}
              onChange={(event) => edit(() => setNickname(event.target.value))}
            />
            {problem && (
              <p className="error-text" role="alert" data-testid="payee-problem">
                {problem}
              </p>
            )}
            <div className="actions">
              <Button variant="primary" disabled={checking || !nickname.trim()} onClick={() => void save()}>
                {t('save')}
              </Button>
            </div>
          </>
        )}

        {confirming && ask && (
          <WithdrawStepUp
            why={t('saveWhy')}
            run={(token) => api.mutate('bank', 'railSends.addPayee', ask, railPayeeSchema, { bearer: token })}
            onDone={() => {
              setConfirming(false);
              setCountry('');
              setRailId('');
              setValues({});
              setNickname('');
              reload();
            }}
            onCancel={() => setConfirming(false)}
          />
        )}

        <Invite />
      </div>
    </DepthPanel>
  );
}
