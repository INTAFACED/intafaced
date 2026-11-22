import { useId, useRef, useState } from 'react';
import { Button, RefusalBox, Select, type Refusal } from '@intafaced/ui/lit';
import { isServiceNotConnected, type ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { refusalCopy } from '../../data';
import { useSession } from '../../features/session';
import { useAccountDetailsRead } from '../../features/money/AccountDetails';
import type { AccountDetailSet, AccountDetailsRow } from '../../features/money/contracts';
import { accountDetailsCopy } from '../../features/money/account-details-copy';
import { accountScreenCopy } from '../account/copy';

/**
 * Receiving from abroad on Pay's global send (J-bank-05 #5), drawn from the kit: the same read, words, ids and states
 * as the money rooms' account-details view (features/money/AccountDetails.tsx). Pick one currency the account holds
 * and see its details, or the bank's own reason there are none. Every value is the banking partner's own string,
 * shown and copied exactly; with no partner connected no number is shown or made up.
 */

type FieldKey = 'accountNumber' | 'sortCode' | 'routingNumber' | 'bsb' | 'iban' | 'bic';
const FIELDS: readonly FieldKey[] = ['accountNumber', 'sortCode', 'routingNumber', 'bsb', 'iban', 'bic'];

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A service sometimes answers with its own refusal code as the message ("token.params_invalid"). */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
/** A setting or code name inside a sentence; only underscored names count, so "v1.2" and "e.g." stay. */
const EMBEDDED_KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/gi;
const embeddedKey = (message: string) => message.match(EMBEDDED_KEY)?.find((key) => key.includes('_'));

/** Copies `value` to the clipboard and says so for two seconds. The value is shown beside it, never changed here. */
function GlobalCopyButton({ value, label }: { value: string; label: string }) {
  const { t } = accountScreenCopy.useCopy();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  }
  return (
    <>
      <Button tone="secondary" aria-label={label} onClick={() => void copy()}>
        {state === 'done' ? t('Copied') : t('Copy')}
      </Button>
      <span className="lt-sr" role="status">
        {state === 'done' ? t('Copied') : state === 'failed' ? t('Copy failed') : ''}
      </span>
    </>
  );
}

function GlobalDetailSet({ set }: { set: AccountDetailSet }) {
  const { t } = accountDetailsCopy.useCopy();
  return (
    <div data-testid="account-details-set">
      <dl className="lt-kv">
        {FIELDS.map((key) => {
          const value = set[key];
          if (value === null) return null;
          return (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>
                <span lang="und" data-withdrawal-private>
                  {value}
                </span>{' '}
                <GlobalCopyButton value={value} label={t('copy', { label: t(key) })} />
              </dd>
            </div>
          );
        })}
        <div>
          <dt>{t('partnerBank')}</dt>
          <dd lang="und">{set.partnerBank}</dd>
        </div>
        {set.restrictions.length > 0 && (
          <div>
            <dt>{t('restrictions')}</dt>
            <dd lang="und">{set.restrictions.join(', ')}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

const STATE_KEY = {
  unavailable: 'stateUnavailable',
  pending_user: 'statePending',
  requirements_fulfilled: 'stateFulfilled',
  done: 'stateDone',
} as const;

function GlobalDetailsList({ rows }: { rows: readonly AccountDetailsRow[] }) {
  const { t } = accountDetailsCopy.useCopy();
  if (rows.length === 0) return <p className="lt-hint">{t('detailsEmpty')}</p>;
  return (
    <div className="lt-review">
      {rows.map((row) => (
        <section key={row.currency} aria-label={row.currency} data-testid={`account-details-${row.currency}`}>
          <h4>{row.currency}</h4>
          <p role="status">
            {t(STATE_KEY[row.state])} {row.blocker && <small>{t('blocker', { code: row.blocker })}</small>}
          </p>
          {row.sets.map((set) => (
            <GlobalDetailSet key={set.id} set={set} />
          ))}
          {row.state === 'unavailable' && <GlobalDisabledAsk />}
        </section>
      ))}
    </div>
  );
}

/** The ask control, off, with its reason beside it. */
function GlobalDisabledAsk() {
  const { t } = accountDetailsCopy.useCopy();
  const id = useId();
  return (
    <div className="lt-review">
      <Button tone="secondary" disabled aria-describedby={id}>
        {t('askDetails')}
      </Button>
      <p id={id} className="lt-hint">
        {t('askReason')}
      </p>
    </div>
  );
}

/**
 * A read that failed, in the words the app's failure view uses for it. Try again is offered only for trouble that can
 * clear by itself (the network, or a source that is unavailable, stale or unknown); never for a missing setting.
 */
function GlobalFailure({ result, retry }: { result: Failed; retry: () => void }) {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  const network = result.reason === 'unreachable' || result.reason === 'invalid_response' || result.reason === 'aborted';
  const recovers =
    result.reason !== 'uncertain' &&
    result.reason !== 'unauthorized' &&
    !isServiceNotConnected(result.code) &&
    (network || Boolean(result.code && /_(unavailable|stale|unknown)$/.test(result.code)));
  const variant: Refusal['variant'] = network ? 'unreachable' : 'refused';
  const message = result.message.trim();
  const rawCode = RAW_CODE.test(message) ? message : result.code ? embeddedKey(result.message) : undefined;
  let refusal: Refusal;
  let lang: string | undefined;
  if (isServiceNotConnected(result.code)) {
    refusal = { variant, title: t('not_mounted'), body: t('serviceNotConnected') };
  } else if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    // A read that may have gone through is never called refused; the code only gives the support reference.
    const uncertain = result.reason === 'uncertain';
    refusal = {
      variant,
      title: uncertain ? t('uncertain') : words.title,
      body: uncertain ? t('gatewayUncertain') : words.body,
      ...(words.reference ? { reference: words.reference } : {}),
      ...(!uncertain && words.action ? { action: words.action } : {}),
    };
  } else {
    lang = result.messageCopy ? languageFor(result.messageCopy.key) : undefined;
    refusal = {
      variant,
      title: t(result.reason),
      body: result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message,
      ...(result.reason === 'unauthorized'
        ? { action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` } }
        : {}),
    };
  }
  return (
    <div data-testid="failure" lang={lang} className="lt-review">
      <RefusalBox refusal={refusal} />
      {recovers ? (
        <Button tone="secondary" onClick={retry}>
          {t('retry')}
        </Button>
      ) : null}
    </div>
  );
}

function GlobalDetailsBody({ resource, reload }: { resource: Resource<{ currencies: AccountDetailsRow[] }>; reload: () => void }) {
  const { t } = accountDetailsCopy.useCopy();
  const { t: ui } = uiCopy.useCopy();
  if (resource.status === 'loading') {
    return (
      <p className="lt-hint" role="status">
        {ui('loading')}…
      </p>
    );
  }
  if (resource.status === 'failed' && resource.failure.code === 'bank.company_account_unwired') {
    return (
      <p role="status" data-testid="account-details-company">
        {t('companyUnwired')} <small>{t('blocker', { code: resource.failure.code })}</small>
      </p>
    );
  }
  if (resource.status === 'failed') return <GlobalFailure result={resource.failure} retry={reload} />;
  return <GlobalDetailsList rows={resource.data.currencies} />;
}

/**
 * Pick one currency the account holds and see its details, or the bank's own reason there are none. The rows are the
 * bank's answer for the profile in view; nothing is listed that it did not send.
 */
export function GlobalAccountDetails() {
  const { profiles } = useSession();
  const read = useAccountDetailsRead();
  // Another profile has its own rows: the choice starts again.
  return <GlobalDetailsByCurrency key={profiles.active} read={read} />;
}

function GlobalDetailsByCurrency({ read }: { read: { resource: Resource<{ currencies: AccountDetailsRow[] }>; reload: () => void } }) {
  const { t } = accountDetailsCopy.useCopy();
  const [currency, setCurrency] = useState('');
  if (read.resource.status !== 'ready' || read.resource.data.currencies.length === 0) {
    return <GlobalDetailsBody resource={read.resource} reload={read.reload} />;
  }
  const rows = read.resource.data.currencies;
  const chosen = rows.find((row) => row.currency === currency);
  return (
    <div className="lt-review" data-testid="receive-details">
      <Select label={t('receiveCurrency')} value={currency} onChange={(event) => setCurrency(event.target.value)}>
        <option value="">{t('receiveChoose')}</option>
        {rows.map((row) => (
          <option key={row.currency} value={row.currency}>
            {row.currency}
          </option>
        ))}
      </Select>
      {chosen && <GlobalDetailsList rows={[chosen]} />}
    </div>
  );
}
