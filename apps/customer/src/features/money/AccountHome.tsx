import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { AccountDetailsPanel } from './AccountDetails';
import { accountHomeCopy } from './account-home-copy';
import { funds, useBankRead } from './components';
import { currencyWrites, type AccountCurrency, type AccountTerms } from './contracts';
import { DepthPanel, Fact } from './DepthParts';

/**
 * The account itself on the Bank Overview (BK-acct-01, BK-acct-03): the base-tier terms the bank published, the currencies
 * the account holds with add and remove, and the account details per currency. Every figure is the service's own string; with
 * nothing published each panel says so with its reference, and no fee, feature or account number is claimed.
 */

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

function Refused({ title, body, code }: { title: string; body: string; code?: string | undefined }) {
  const { t } = accountHomeCopy.useCopy();
  return (
    <div className="failure" role="status">
      <h3>{title}</h3>
      <p>{body}</p>
      {code && <small className="muted">{t('reference', { code })}</small>}
    </div>
  );
}

function TermsFacts({ terms }: { terms: AccountTerms }) {
  const { t } = accountHomeCopy.useCopy();
  return (
    <dl className="bd-facts" data-testid="account-terms">
      <Fact label={t('tier')}>
        <span lang="und">{terms.tier}</span>
      </Fact>
      <Fact label={t('monthlyFee')}>{funds(terms.monthlyFee, terms.currency)}</Fact>
      <Fact label={t('minimumBalance')}>{funds(terms.minimumBalance, terms.currency)}</Fact>
      <Fact label={t('overdraft')}>{terms.overdraftFee === null ? t('noOverdraft') : funds(terms.overdraftFee, terms.currency)}</Fact>
      <Fact label={t('included')}>
        <ul lang="und">
          {terms.included.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Fact>
      <Fact label={t('version')}>
        <span lang="und">{terms.version}</span>
      </Fact>
    </dl>
  );
}

function TermsPanel() {
  const { t } = accountHomeCopy.useCopy();
  const read = useBankRead('accounts.features', undefined);
  const { resource } = read;
  return (
    <DepthPanel title={t('termsTitle')} lead={t('termsLead')}>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        resource.failure.code === 'bank.account_terms_unset' ? (
          <Refused title={t('termsUnsetTitle')} body={t('termsUnsetBody')} code={resource.failure.code} />
        ) : (
          <Failure result={resource.failure} retry={read.reload} />
        )
      ) : (
        <TermsFacts terms={resource.data} />
      )}
    </DepthPanel>
  );
}

function CurrencyRow({ row, onRemove, busy }: { row: AccountCurrency; onRemove: () => void; busy: boolean }) {
  const { t } = accountHomeCopy.useCopy();
  return (
    <div className="money-space-row" data-testid={`currency-${row.assetId}`}>
      <strong lang="und">{row.assetId}</strong>
      <span className="numeric" dir="ltr">
        {funds(row.balance, row.assetId)}
      </span>
      <Button variant="ghost" onClick={onRemove} disabled={busy}>
        {t('remove', { asset: row.assetId })}
      </Button>
    </div>
  );
}

function CurrenciesPanel() {
  const { t } = accountHomeCopy.useCopy();
  const { api } = useSession();
  const read = useBankRead('currencies.list', undefined);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: 'added' | 'removed'; asset: string }
    | { kind: 'inUse'; asset: string; spaceId: string | undefined; code: string }
    | { kind: 'refused'; result: Refusal }
    | null
  >(null);

  async function write(kind: 'add' | 'remove', asset: string, spaceId?: string) {
    setBusy(true);
    setOutcome(null);
    const result =
      kind === 'add'
        ? await api.mutate('bank', 'currencies.add', { assetId: asset }, currencyWrites.add)
        : await api.mutate('bank', 'currencies.remove', { assetId: asset }, currencyWrites.remove);
    setBusy(false);
    if (result.ok) {
      setOutcome({ kind: kind === 'add' ? 'added' : 'removed', asset });
      setPicked('');
      read.reload();
    } else if (result.code === 'bank.currency_in_use') {
      setOutcome({ kind: 'inUse', asset, spaceId, code: result.code });
    } else {
      setOutcome({ kind: 'refused', result });
    }
  }

  const { resource } = read;
  if (resource.status === 'loading') {
    return (
      <DepthPanel title={t('currenciesTitle')} lead={t('currenciesLead')}>
        <Loading />
      </DepthPanel>
    );
  }
  if (resource.status === 'failed') {
    return (
      <DepthPanel title={t('currenciesTitle')} lead={t('currenciesLead')}>
        <Failure result={resource.failure} retry={read.reload} />
      </DepthPanel>
    );
  }
  const { currencies, addable, addableBlocker } = resource.data;
  const choice = picked || addable?.[0] || '';
  return (
    <DepthPanel title={t('currenciesTitle')} lead={t('currenciesLead')}>
      <div className="bd-stack">
        {currencies.length === 0 ? (
          <p className="money-caption">{t('noCurrencies')}</p>
        ) : (
          currencies.map((row) => (
            <CurrencyRow key={row.assetId} row={row} busy={busy} onRemove={() => void write('remove', row.assetId, row.spaceId)} />
          ))
        )}
        {addable === null ? (
          <p className="money-caption">
            {t('addUnset')} {addableBlocker && <small className="muted">{t('reference', { code: addableBlocker })}</small>}
          </p>
        ) : addable.length === 0 ? (
          <p className="money-caption">{t('addNone')}</p>
        ) : (
          <div className="actions">
            <label className="field">
              <span>{t('addLabel')}</span>
              <select value={choice} onChange={(event) => setPicked(event.target.value)}>
                {addable.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={() => void write('add', choice)} disabled={busy || choice === ''}>
              {busy ? t('working') : t('add')}
            </Button>
          </div>
        )}
        {outcome?.kind === 'added' && <p role="status">{t('added', { asset: outcome.asset })}</p>}
        {outcome?.kind === 'removed' && <p role="status">{t('removed', { asset: outcome.asset })}</p>}
        {outcome?.kind === 'inUse' && (
          <div data-testid="currency-in-use">
            <Refused title={t('inUseTitle', { asset: outcome.asset })} body={t('inUseBody')} code={outcome.code} />
            <div className="actions">
              <a
                className="button button--secondary"
                href={outcome.spaceId ? `/bank/transfers?from=${encodeURIComponent(outcome.spaceId)}` : '/bank/transfers'}
              >
                {t('send')}
              </a>
              <a className="button button--secondary" href="/trade/convert">
                {t('convert')}
              </a>
            </div>
          </div>
        )}
        {outcome?.kind === 'refused' && <Failure result={outcome.result} />}
      </div>
    </DepthPanel>
  );
}

export function AccountHome() {
  return (
    <div className="bd-stack" data-testid="account-home">
      <TermsPanel />
      <CurrenciesPanel />
      <AccountDetailsPanel />
    </div>
  );
}
