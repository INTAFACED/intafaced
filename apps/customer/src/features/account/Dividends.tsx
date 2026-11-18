import { useMemo, useState } from 'react';
import { distributionsMineSchema, type DistributionKind, type DistributionRecord } from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { Button, DataTable, Failure, Loading, Page } from '../../shared/ui';
import { dividendsCopy as copy } from './dividends-copy';
import './dividends.css';

/**
 * The dividend records room, /uc/paydividends (CM-airdrop-campaigns-01, J-campaigns-13 #1 #2 #3). Airdrops: each one the
 * account joined, read from svc-campaigns: the snapshot time, how the account stood at it, its share, and the chain
 * transaction that paid it once paid. Dividends: refused while the owner decision is open, so the room names the
 * question and lists none. Nothing shown is a figure that was not read from the service; no records is an honest empty
 * table. `?kind=dividend` opens the dividends.
 */
export function Dividends() {
  const api = useApi();
  const [kind, setKind] = useState<DistributionKind>(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('kind') === 'dividend' ? 'dividend' : 'airdrop',
  );
  const records = useResource(
    (signal) => api.query('campaigns', 'distribution.mine', { kind }, distributionsMineSchema, { signal }),
    `distributions-${kind}`,
  );
  return <DividendsView kind={kind} onKind={setKind} records={records.resource} retry={records.reload} />;
}

export function DividendsView({
  kind,
  onKind,
  records,
  retry,
}: {
  kind: DistributionKind;
  onKind: (kind: DistributionKind) => void;
  records: Resource<{ records: DistributionRecord[] }>;
  retry?: () => void;
}) {
  const { t, Copy, languageFor, renderedLocale } = copy.useCopy();
  const when = useMemo(() => {
    const format = new Intl.DateTimeFormat(renderedLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    return (iso: string) => format.format(new Date(iso));
  }, [renderedLocale]);
  const headers = [t('colDate'), t('colAsset'), t('colAmount'), t('colSource'), t('colPayment')];
  const refusedQuestion =
    records.status === 'failed' && records.failure.code === 'owner.decision'
      ? (records.failure.message ?? '').replace(/\s*\[owner\.decision\]$/, '')
      : null;
  return (
    <div className="dividends" lang={languageFor('title')} style={{ display: 'contents' }}>
      <Page title={t('title')} description={t('description')}>
        <div className="dividends__columns">
          <section aria-labelledby="dividends-what">
            <h2 id="dividends-what">
              <Copy k="whatTitle" />
            </h2>
            <p>
              <Copy k="whatBody" />
            </p>
          </section>
          <section aria-labelledby="dividends-need">
            <h2 id="dividends-need">
              <Copy k="needTitle" />
            </h2>
            <p>
              <Copy k="needBody" />
            </p>
            <p className="muted">
              <Copy k="needToken" />
            </p>
          </section>
        </div>
        <section aria-labelledby="dividends-history">
          <h2 id="dividends-history">
            <Copy k="historyTitle" />
          </h2>
          <div className="actions" role="group" aria-label={t('kindLabel')} data-testid="dividends-kind">
            {(['airdrop', 'dividend'] as const).map((k) => (
              <Button
                key={k}
                variant={k === kind ? 'primary' : 'secondary'}
                aria-pressed={k === kind}
                data-kind={k}
                onClick={() => onKind(k)}
              >
                {t(k === 'airdrop' ? 'kindAirdrop' : 'kindDividend')}
              </Button>
            ))}
          </div>
          {records.status === 'loading' ? <Loading label={t('loading')} /> : null}
          {refusedQuestion !== null ? (
            <p role="status" data-testid="dividends-refusal" data-code="owner.decision">
              {t('dividendRefused', { question: refusedQuestion })}
            </p>
          ) : records.status === 'failed' ? (
            <Failure result={records.failure} retry={retry} />
          ) : null}
          <DataTable label={t('historyLabel')} headers={headers}>
            {records.status === 'ready' && records.data.records.length > 0 ? (
              records.data.records.map((r) => <RecordRow key={r.campaignId} r={r} when={when} />)
            ) : (
              <tr data-testid="dividends-empty" data-kind={kind}>
                <td colSpan={headers.length}>
                  <strong>{kind === 'dividend' ? <Copy k="dividendEmpty" /> : <Copy k="emptyTitle" />}</strong>
                  {kind === 'airdrop' ? (
                    <>
                      <br />
                      <span className="muted">
                        <Copy k="emptyBody" />
                      </span>
                    </>
                  ) : null}
                </td>
              </tr>
            )}
          </DataTable>
        </section>
        <div className="actions">
          <a className="text-link" href="/token">
            <Copy k="token" />
          </a>
          <a className="text-link" href="/bank/earn">
            <Copy k="earn" />
          </a>
          <a className="text-link" href="/money/activity">
            <Copy k="activity" />
          </a>
        </div>
      </Page>
    </div>
  );
}

function RecordRow({ r, when }: { r: DistributionRecord; when: (iso: string) => string }) {
  const { t } = copy.useCopy();
  const name = r.campaignName;
  const source =
    r.standing === 'counted'
      ? t('standingCounted', { name, pool: r.pool, asset: r.asset, equity: r.equity ?? '', equityAsset: r.equityAsset })
      : r.standing === 'excluded_negative'
        ? t('standingExcluded', { name, equity: r.equity ?? '', equityAsset: r.equityAsset })
        : r.standing === 'held_out'
          ? t('standingHeldOut', { name, code: r.heldOut ?? '' })
          : t('standingWaiting', { name });
  const hasShare = r.share !== null && r.rewardKey !== null;
  return (
    <tr
      data-testid="dividend-record"
      data-campaign-id={r.campaignId}
      data-standing={r.standing}
      data-state={r.state ?? ''}
      data-reward-key={r.rewardKey ?? ''}
    >
      <td data-testid="dividend-snapshot" data-at={r.snapshotAt}>
        {t('snapshotAt', { when: when(r.snapshotAt) })}
      </td>
      <td lang="zxx">{r.asset}</td>
      <td lang="zxx" data-testid="dividend-amount" data-amount={hasShare ? r.share! : ''}>
        {hasShare ? t('shareValue', { amount: r.share!, asset: r.asset }) : t('noShare')}
      </td>
      <td data-testid="dividend-source">{source}</td>
      <td data-testid="dividend-payment">
        {r.chainTx ? (
          <>
            {t('paid', { wallet: r.toWallet ?? '' })}
            <br />
            <code lang="zxx" data-testid="dividend-chain-tx" data-tx={r.chainTx}>
              {r.chainTx}
            </code>
          </>
        ) : hasShare ? (
          t('owed')
        ) : (
          t('nothingToPay')
        )}
      </td>
    </tr>
  );
}
