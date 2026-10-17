import { useState } from 'react';
import { Field } from '@intafaced/ui';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import { PortalFailure, PortalLoading, SelectField } from '../components';
import type { PortalApi } from '../api';
import { isComingSoon } from '../refusal';
import { useUnsavedForm } from '../useUnsavedForm';
import { DateTime } from '../ui/DateTime';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { PortalReview } from '../ui/PortalReview';
import { useServerList } from '../ui/useServerList';
import { ListBody, NamedBlocker, TestBanner } from './common';
import { mc } from './copy';
import { describeDestination, railWords } from './destination';
import { destinationKindOfRail } from './model';
import type { DestinationItem } from './schemas';
import { useReadAt } from '../hooks';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const IBAN = /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}$/;
const IFSC = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;
/** A first look at the shape, so an obvious slip is caught before the review. The service checks it properly. */
export function referenceProblem(kind: 'crypto' | 'bank', ref: string): 'empty' | 'crypto' | 'bank' | null {
  const text = ref.trim().replace(/\s+/g, '');
  if (!text) return 'empty';
  if (kind === 'crypto') return EVM.test(text) ? null : 'crypto';
  return IBAN.test(text) || IFSC.test(text) ? null : 'bank';
}

/** `/pay/payouts/destinations`: where your payouts can go. Full numbers and addresses are never shown again once saved. */
export function Destinations({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const list = useServerList((_f, cursor, signal) => portal.destinationPage(merchantId, cursor, signal), { m: merchantId }, (d: DestinationItem) => d.id);
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const rows = list.state.status === 'ready' ? list.state.items : [];
  const lastUsed = rows.map((d) => d.lastUsedAt).filter((x): x is string => Boolean(x)).sort().at(-1);
  const count = list.state.status === 'ready' ? (list.state.hasMore ? t('countNewest', { n: rows.length }) : String(rows.length)) : '—';
  return (
    <div className="stack">
      <TestBanner />
      <Freshness asOf={readAt} />
      <KpiStrip
        label={t('dstTiles')}
        tiles={[
          { label: t('dstCount'), period: t('periodNow'), href: '/pay/payouts/destinations', value: count },
          { label: t('dstDefault'), period: t('periodNow'), href: '/pay/payouts/destinations', value: t('notSetUp') },
          {
            label: t('dstLastUsed'),
            period: t('periodNow'),
            href: '/pay/payouts?status=paid_out',
            value: lastUsed ? <DateTime value={lastUsed} /> : '—',
          },
          { label: t('dstScreening'), period: t('periodNow'), href: '/pay/payouts/destinations', value: t('notRecorded') },
        ]}
      />
      <ListBody
        state={list.state}
        retry={() => list.reload()}
        onMore={list.loadMore}
        empty={{ title: t('dstEmptyTitle'), body: t('dstEmptyBody') }}
        label={t('dstTable')}
        rowKey={(d) => d.id}
        blocked={
          <NamedBlocker title={t('dstTable')} why="reasonLists" needs="merchant.payoutDestinations.list (feat/pay-portal-be-reads-money)">
            {t('dstListBlocked')}
          </NamedBlocker>
        }
        columns={[
          { header: t('colDestination'), cell: (d) => describeDestination(t, d.kind, d.destinationMasked, d.railId) },
          { header: t('dstDefault'), cell: () => <span className="muted">{t('notSetUp')}</span> },
          { header: t('dstScreening'), cell: () => <span className="muted">{t('notRecorded')}</span> },
          { header: t('colAdded'), cell: (d) => <DateTime value={d.createdAt} /> },
          { header: t('dstLastUsed'), cell: (d) => (d.lastUsedAt ? <DateTime value={d.lastUsedAt} /> : <span className="muted">{t('never')}</span>) },
        ]}
        card={(d) => ({
          title: describeDestination(t, d.kind, d.destinationMasked, d.railId),
          time: <DateTime value={d.createdAt} />,
          status: <span className="muted">{d.lastUsedAt ? <DateTime value={d.lastUsedAt} /> : t('never')}</span>,
        })}
      />
      <AddDestination portal={portal} merchantId={merchantId} onAdded={list.reload} />
      <NamedBlocker title={t('dstManageTitle')} why="reasonActions" needs="payout destination remove and set default (no service)">
        {t('dstManageBody')}
      </NamedBlocker>
    </div>
  );
}

function AddDestination({ portal, merchantId, onAdded }: { portal: PortalApi; merchantId: string; onAdded: () => void }) {
  const { t } = mc.useCopy();
  const { can } = useMerchantAccess();
  const rails = useResource((s) => portal.rails(s), `money:rails:${merchantId}`);
  const [railId, setRail] = useState('');
  const [ref, setRef] = useState('');
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);
  useUnsavedForm(ref.trim() !== '' && !saved, t('unsavedLeave'));
  const owner = can('owner');
  const options =
    rails.resource.status === 'ready' ? rails.resource.data.filter((r) => r.capabilities.includes('payout') && r.usable) : [];
  const rail = options.find((r) => r.id === railId) ?? (options.length === 1 ? options[0]! : null);
  const kind = rail ? destinationKindOfRail(rail.id) : null;
  const problem = kind ? referenceProblem(kind, ref) : null;
  const why = !owner ? t('dstOwnerOnly') : !rail ? t('dstPickRail') : problem ? t(problem === 'empty' ? 'dstRefEmpty' : problem === 'crypto' ? 'dstRefCrypto' : 'dstRefBank') : null;
  return (
    <PaySection title={t('dstAddTitle')} description={t('dstAddBody')}>
      {rails.resource.status === 'loading' ? (
        <PortalLoading rows={1} />
      ) : rails.resource.status === 'failed' ? (
        isComingSoon(rails.resource.failure) ? null : <PortalFailure result={rails.resource.failure} retry={rails.reload} />
      ) : options.length === 0 ? (
        <p className="muted">{t('dstNoRails')}</p>
      ) : (
        <form className="form-stack pp-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <SelectField
            label={t('dstRail')}
            value={rail?.id ?? ''}
            onChange={setRail}
            options={[['', t('pnChoose')], ...options.map((r) => [r.id, railWords(t, r.id)] as const)]}
          />
          <Field
            label={`${kind === 'bank' ? t('dstRefBankLabel') : t('dstRefCryptoLabel')} *`}
            value={ref}
            onChange={(e) => {
              setRef(e.target.value);
              setSaved(false);
            }}
            onBlur={() => setTried(true)}
            hint={t('dstRefHint')}
            error={tried && problem ? t(problem === 'empty' ? 'dstRefEmpty' : problem === 'crypto' ? 'dstRefCrypto' : 'dstRefBank') : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <PortalReview
            title={t('dstSave')}
            variant="primary"
            description={t('dstReviewBody')}
            disabled={why !== null}
            disabledReason={why ?? undefined}
            review={
              rail && kind ? (
                <dl className="pp-facts">
                  <div>
                    <dt>{t('dstRail')}</dt>
                    <dd>{railWords(t, rail.id)}</dd>
                  </div>
                  <div>
                    <dt>{kind === 'bank' ? t('dstRefBankLabel') : t('dstRefCryptoLabel')}</dt>
                    <dd className="pp-mono pp-wrap">{ref.trim()}</dd>
                  </div>
                </dl>
              ) : undefined
            }
            perform={() => portal.setPayoutDestination(merchantId, rail!.id, kind!, ref.trim().replace(/\s+/g, ''))}
            onConfirmed={() => {
              setSaved(true);
              setRef('');
              onAdded();
            }}
          />
          {saved && (
            <p className="pp-callout" role="status">
              {t('dstSaved')}
            </p>
          )}
        </form>
      )}
    </PaySection>
  );
}
