import { useId, useState } from 'react';
import { decimalSchema, parseAmount } from '../../shared/money';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session';
import { date, funds, useSpaces, useBankRecord } from './components';
import { railSendCheckSchema, railSendSchema, type RailPayee, type RailSend, type RegionNotice } from './contracts';
import { DepthPanel } from './DepthParts';
import { railSendCopy } from './rail-send-copy';
import { currentSpace } from './space-context';
import { RailForm, filled, type Key } from './rail-form';
import { CoolingWords, PAYEE_PAGE, RecipientBook } from './RecipientBook';
import { WithdrawStepUp } from './WithdrawStepUp';
import './bank-depth.css';
import {
  BANK_RAIL_SENDS_READ_PAYEE_WARNING,
  BANK_RAIL_SENDS_REQUIREMENTS,
  BANK_RAIL_SENDS_LIST,
  BANK_RAIL_SENDS_PAYEES,
} from '@intafaced/contracts/bank-rail-sends-procedures';
import { BANK_SAFETY_REGION_NOTICE } from '@intafaced/contracts/bank-safety-procedures';
import { RefusalCode } from '../../shared/RefusalCode';
import { withCode } from '../../shared/reference';

const amountOk = (value: string) => decimalSchema.safeParse(value.trim()).success && parseAmount(value.trim()) > 0n;

/**
 * Send to a bank account (J-bank-04 #1): pick how to send (ACH, a domestic wire, a real-time payment, SEPA or a phone
 * number or email), fill that rail's own form as the bank publishes it, and send from a space. No banking partner
 * carries any rail in this build, so the form says so with `rail.bank` before anything is asked; sending anyway needs a
 * fresh confirmation (`trade:withdraw`) and is kept, refused with that code, in the list below. Nothing leaves a space.
 */

function Sends({ rows }: { rows: readonly RailSend[] }) {
  const { t } = railSendCopy.useCopy();
  if (rows.length === 0) return <p className="lt-muted">{t('none')}</p>;
  return (
    <>
      {rows.map((row) => (
        <div className="money-space-row" key={row.requestId} data-testid="rail-send-row" data-status={row.status}>
          <div>
            <strong>{t('status_refused')}</strong>
            <small>{date(row.createdAt)}</small>
          </div>
          <span className="lt-num" dir="ltr">
            {funds(row.amount, row.assetId)}
          </span>
          <span>
            {t(`rail_${row.rail}` as Key)} · <span lang="und">{row.recipient}</span>
            <br />
            <RefusalCode className="lt-muted" code={row.refusalCode} line={(code) => t('reference', { code })} />
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * From a blocked region (J-bank-18 #1, BK-safe-01): the bank's doors refuse, and this says why, naming the restriction
 * in the owner's wording, or that the wording is not published. It replaces the form: nothing can be sent from here.
 */
function RegionBlocked({ notice }: { notice: RegionNotice }) {
  const { t } = railSendCopy.useCopy();
  return (
    <div className="lt-refusal" role="status" data-testid="rail-send-region" data-code={notice.code ?? ''} data-region={notice.region}>
      <h3>
        {t('regionTitle')} (<span lang="und">{notice.region}</span>)
      </h3>
      {notice.restriction ? (
        <p data-testid="rail-send-region-restriction">
          {t('regionRestriction')}: {notice.restriction}
        </p>
      ) : null}
      <p data-testid="rail-send-region-wording" data-published={notice.wording === null ? 'false' : 'true'}>
        {notice.wording ?? t('regionWordingUnset')}
      </p>
    </div>
  );
}

/**
 * The first-time payee scam warning (J-bank-18 #2, BK-safe-02): shown while the person has not read it for this
 * recipient, with the scam guide, and never again for them once read. It never blocks the send by itself.
 */
function ScamWarning({ payee, onRead }: { payee: RailPayee; onRead: () => void }) {
  const { t } = railSendCopy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (payee.scamWarning.state === 'read') return null;
  async function read() {
    setBusy(true);
    setProblem(null);
    const answer = await api.call(BANK_RAIL_SENDS_READ_PAYEE_WARNING, { payeeId: payee.payeeId });
    setBusy(false);
    if (answer.ok) onRead();
    else setProblem(answer.message);
  }
  return (
    <div className="lt-refusal" role="note" data-testid="rail-send-scam-warning" data-payee={payee.payeeId}>
      <h3>{t('scamTitle')}</h3>
      <p>{t('scamBody')}</p>
      <p>
        <a className="lt-link" href="/help/official-channels">
          {t('scamGuide')}
        </a>
      </p>
      <div className="lt-actions">
        <Button variant="secondary" disabled={busy} onClick={() => void read()}>
          {t('scamRead')}
        </Button>
      </div>
      {problem ? (
        <p className="error-text" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export function BankRailSend() {
  const { t } = railSendCopy.useCopy();
  const { api, userId } = useSession();
  const requirements = useBankRecord(BANK_RAIL_SENDS_REQUIREMENTS, undefined);
  const region = useBankRecord(BANK_SAFETY_REGION_NOTICE, undefined);
  const blocked = region.resource.status === 'ready' && region.resource.data.blocked ? region.resource.data : null;
  const spaces = useSpaces(200);
  const sends = useBankRecord(BANK_RAIL_SENDS_LIST, { limit: 20 });
  const payees = useBankRecord(BANK_RAIL_SENDS_PAYEES, { limit: PAYEE_PAGE });
  const [payeeId, setPayeeId] = useState('');
  const [railId, setRailId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [spaceId, setSpaceId] = useState('');
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [outcome, setOutcome] = useState<RailSend | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const railField = useId();
  const spaceField = useId();
  const toField = useId();

  const rails = requirements.resource.status === 'ready' ? requirements.resource.data.rails : [];
  const rail = rails.find((row) => row.rail === railId) ?? null;
  const rows = spaces.resource.status === 'ready' ? spaces.resource.data : [];
  const usable = rows.filter((space) => currentSpace(rows, space.id, userId ?? ''));
  const from = usable.find((space) => space.id === spaceId) ?? usable[0] ?? null;
  const book = payees.resource.status === 'ready' ? payees.resource.data : [];
  const payee = book.find((row) => row.payeeId === payeeId) ?? null;
  const recipient = filled(rail, values);
  const missing = payee ? false : rail ? rail.fields.some((field) => field.required && !recipient[field.name]) : true;
  // A send to a saved recipient carries only its id: the bank reads the rail and the details from the book.
  const target = payee ? { payeeId: payee.payeeId } : rail ? { rail: rail.rail, recipient } : null;
  // The rail the send goes over, and its notice: the saved recipient's rail, or the one picked.
  const shown = payee ? (rails.find((row) => row.rail === payee.rail) ?? null) : rail;

  function choose(next: string) {
    setPayeeId(next);
    setOutcome(null);
    setTouched(false);
    setProblem(null);
  }

  function pick(next: string) {
    setRailId(next);
    setValues({});
    setOutcome(null);
    setTouched(false);
    setProblem(null);
  }

  /** The bank checks the form, the space and the balance first, so a typo is answered here before a code is spent. */
  async function send() {
    setTouched(true);
    setProblem(null);
    if (!target || !from || missing || !amountOk(amount) || checking) return;
    setOutcome(null);
    setChecking(true);
    const checked = await api.query(
      'bank',
      'railSends.check',
      { fromSpaceId: from.id, amount: amount.trim(), ...target },
      railSendCheckSchema,
    );
    setChecking(false);
    if (!checked.ok) {
      if (checked.code === 'bank.payee_cooling_active' && payee?.cooling.endsAt) {
        setProblem(withCode(t('coolingActive', { time: date(payee.cooling.endsAt) }), checked.code, (code) => t('reference', { code })));
      } else if (checked.code === 'bank.payee_cooling_unset') {
        setProblem(withCode(t('coolingUnset'), checked.code, (code) => t('reference', { code })));
      } else {
        setProblem(checked.message || t('missing'));
      }
      return;
    }
    // Each send is a new ask with its own id; a retry inside the confirmation keeps it, so it is the same send.
    setRequestId(crypto.randomUUID());
    setConfirming(true);
  }

  const loading = requirements.resource.status === 'loading' || spaces.resource.status === 'loading';
  return (
    <div className="lt-stack" data-testid="rail-send">
      <DepthPanel title={t('title')} lead={t('lead')}>
        {blocked ? (
          <RegionBlocked notice={blocked} />
        ) : loading ? (
          <Loading />
        ) : requirements.resource.status === 'failed' ? (
          <Failure result={requirements.resource.failure} retry={requirements.reload} />
        ) : spaces.resource.status === 'failed' ? (
          <Failure result={spaces.resource.failure} retry={spaces.reload} />
        ) : (
          <div className="lt-stack">
            <label className="lt-field" htmlFor={toField}>
              <span id={`${toField}-label`}>{t('sendTo')}</span>
              <select
                id={toField}
                aria-labelledby={`${toField}-label`}
                value={payee?.payeeId ?? ''}
                onChange={(event) => choose(event.target.value)}
              >
                <option value="">{t('newDetails')}</option>
                {book.map((row) => (
                  <option key={row.payeeId} value={row.payeeId}>
                    {row.nickname} · {row.recipient}
                  </option>
                ))}
              </select>
            </label>
            {payee ? (
              <>
                <p className="lt-muted" data-testid="rail-send-payee">
                  {t(`rail_${payee.rail}` as Key)} · <span lang="und">{payee.recipient}</span> · <CoolingWords payee={payee} />
                </p>
                <ScamWarning payee={payee} onRead={payees.reload} />
              </>
            ) : (
              <label className="lt-field" htmlFor={railField}>
                <span>{t('rail')}</span>
                <select id={railField} value={railId} onChange={(event) => pick(event.target.value)}>
                  <option value="" />
                  {rails.map((row) => (
                    <option key={row.rail} value={row.rail}>
                      {t(`rail_${row.rail}` as Key)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {shown && (
              <>
                {shown.partner === null && (
                  <p className="lt-refusal" role="status" data-testid="rail-send-notice">
                    {t('noPartner', { rail: t(`rail_${shown.rail}` as Key) })}{' '}
                    {shown.blocker && <RefusalCode className="lt-muted" code={shown.blocker} line={(code) => t('reference', { code })} />}
                  </p>
                )}
                {rail && !payee && (
                  <div className="lt-stack" data-testid="rail-send-form" data-rail={rail.rail}>
                    <RailForm
                      rail={rail}
                      values={values}
                      onChange={(name, value) => {
                        setProblem(null);
                        setValues((now) => ({ ...now, [name]: value }));
                      }}
                    />
                  </div>
                )}
                {usable.length === 0 ? (
                  <p className="lt-muted">{t('noSpace')}</p>
                ) : (
                  <label className="lt-field" htmlFor={spaceField}>
                    <span>{t('from')}</span>
                    <select
                      id={spaceField}
                      value={from?.id ?? ''}
                      onChange={(event) => {
                        setProblem(null);
                        setSpaceId(event.target.value);
                      }}
                    >
                      {usable.map((space) => (
                        <option key={space.id} value={space.id}>
                          {space.name} · {funds(space.balance, space.assetId)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <Field
                  label={t('amount')}
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    setProblem(null);
                    setAmount(event.target.value);
                  }}
                  error={touched && !amountOk(amount) ? t('amountBad') : undefined}
                />
                {((touched && missing) || problem) && (
                  <p className="error-text" role="alert" data-testid="rail-send-problem">
                    {problem ?? t('missing')}
                  </p>
                )}
                <div className="lt-actions">
                  <Button variant="primary" disabled={!from || checking} onClick={() => void send()}>
                    {t('send')}
                  </Button>
                </div>
              </>
            )}
            {outcome && (
              <div className="lt-refusal" role="status" data-testid="rail-send-kept">
                <h3>{t('keptTitle')}</h3>
                <p>{t('keptBody')}</p>
                <p>
                  {t('noPartner', { rail: t(`rail_${outcome.rail}` as Key) })}{' '}
                  <RefusalCode className="lt-muted" code={outcome.refusalCode} line={(code) => t('reference', { code })} />
                </p>
              </div>
            )}
          </div>
        )}
      </DepthPanel>

      {confirming && target && from && (
        <WithdrawStepUp
          why={t('confirmWhy')}
          run={async (token) => {
            const answer = await api.mutate(
              'bank',
              'railSends.send',
              { requestId, fromSpaceId: from.id, amount: amount.trim(), ...target },
              railSendSchema,
              { bearer: token },
            );
            if (answer.ok) setOutcome(answer.data);
            return answer;
          }}
          onDone={() => {
            setConfirming(false);
            // A final answer closes this send, so sending again is a new one.
            setRequestId(crypto.randomUUID());
            sends.reload();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      <DepthPanel title={t('listTitle')} lead={t('listLead')}>
        <div data-testid="rail-send-list">
          {sends.resource.status === 'loading' ? (
            <Loading />
          ) : sends.resource.status === 'failed' ? (
            <Failure result={sends.resource.failure} retry={sends.reload} />
          ) : (
            <Sends rows={sends.resource.data} />
          )}
        </div>
      </DepthPanel>

      <RecipientBook
        requirements={requirements.resource.status === 'ready' ? requirements.resource.data : null}
        payees={payees.resource.status === 'ready' ? payees.resource.data : null}
        failure={
          payees.resource.status === 'failed'
            ? payees.resource.failure
            : requirements.resource.status === 'failed'
              ? requirements.resource.failure
              : null
        }
        retry={() => {
          payees.reload();
          requirements.reload();
        }}
        reload={payees.reload}
      />
    </div>
  );
}
