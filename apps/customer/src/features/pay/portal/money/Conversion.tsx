import { useMemo } from 'react';
import { Button } from '@intafaced/ui';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { Facts, Gate, HaltBanner, PortalFailure, PortalLoading, SelectField, TestTag } from '../components';
import type { PortalApi } from '../api';
import { useReadAt, useUrlParam } from '../hooks';
import { isUuid } from '../model';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { MoneyText } from '../ui/MoneyText';
import { RelatedLinks } from '../ui/RelatedLinks';
import { ToneChip, type StatusTone } from '../ui/StatusChip';
import { Timeline } from '../ui/Timeline';
import { uiCopy } from '../ui/copy';
import { ListBody, LinkButton, localRefusal, NamedBlocker, shortDay } from './common';
import { mc } from './copy';
import { PAY_CONVERSION_STATUSES as conversionStatuses } from '@intafaced/contracts/conversion';
import { isConversionOff } from './refusals';

const TONE: Record<string, StatusTone> = {
  quoted: 'progress',
  intent_committed: 'progress',
  placing: 'progress',
  placed: 'progress',
  partially_filled: 'action',
  filled: 'done',
  failed: 'failed',
  reversed: 'failed',
  expired: 'progress',
};
export function ConversionChip({ status }: { status: string }) {
  const { t } = mc.useCopy();
  return status in TONE ? (
    <ToneChip tone={TONE[status]!} label={t(`cvStatus_${status}` as 'cvStatus_filled')} tip={t(`cvTip_${status}` as 'cvTip_filled')} />
  ) : (
    <ToneChip tone="progress" label={t('cvStatus_other')} />
  );
}
/** `/pay/conversion/new` is drawn on the flow template in `../flow/ConversionNewRoom.tsx`. */
export { ConversionNew, conversionRequestScope } from '../flow/ConversionNewRoom';
const orderHref = (id: string) => `/pay/conversion/${encodeURIComponent(id)}`;

/** Conversion is a sandbox. This says so on every conversion page, before anything else. */
function TestNotice() {
  const { t } = mc.useCopy();
  return (
    <p className="pp-callout pp-callout--warn" role="note">
      <TestTag /> <strong>{t('cvTestTitle')}</strong> {t('cvTestBody')}
    </p>
  );
}

function Off() {
  const { t } = mc.useCopy();
  return (
    <NamedBlocker title={t('cvOffTitle')} why="reasonService" needs="conversion switched on (PAY_CONVERSION_MODE=sandbox)">
      {t('cvOffBody')}
    </NamedBlocker>
  );
}

/** `/pay/conversion`: your test conversions from US dollars to USDT. */
export function Conversion({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const [status, setStatus] = useUrlParam('status', '');
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const orders = useResource((s) => portal.conversionList(merchantId, s), `money:conversions:${merchantId}`);
  const readAt = useReadAt(orders.resource.status === 'ready', orders.resource);
  const r = orders.resource;
  const all = r.status === 'ready' ? r.data : [];
  const shown = status ? all.filter((o) => o.status === status) : all;
  const inFlight = all.filter((o) => ['quoted', 'intent_committed', 'placing', 'placed', 'partially_filled'].includes(o.status)).length;
  const count = (n: number) => (all.length >= 50 ? t('mnCountNewest', { n }) : String(n));
  return (
    <div className="stack">
      <TestNotice />
      <HaltBanner resource={halts.resource} scopes={['conversion']} />
      <Freshness asOf={readAt} />
      {r.status === 'failed' && isConversionOff(r.failure) ? (
        <Off />
      ) : (
        <>
          <KpiStrip
            label={t('cvTiles')}
            tiles={[
              {
                label: t('cvTotal'),
                period: t('mnPeriodNewest'),
                href: '/pay/conversion',
                value: r.status === 'ready' ? count(all.length) : '—',
              },
              {
                label: t('cvFilled'),
                period: t('mnPeriodNewest'),
                href: '/pay/conversion?status=filled',
                value: r.status === 'ready' ? count(all.filter((o) => o.status === 'filled').length) : '—',
              },
              {
                label: t('cvInFlight'),
                period: t('mnPeriodNow'),
                href: '/pay/conversion?status=placing',
                value: r.status === 'ready' ? String(inFlight) : '—',
              },
              {
                label: t('cvFailed'),
                period: t('mnPeriodNewest'),
                href: '/pay/conversion?status=failed',
                value: r.status === 'ready' ? count(all.filter((o) => o.status === 'failed' || o.status === 'reversed').length) : '—',
              },
            ]}
          />
          <div className="pp-filter-row">
            <SelectField
              label={t('colStatus')}
              value={status}
              onChange={setStatus}
              options={[['', t('cvAllStatuses')], ...conversionStatuses.map((s) => [s, t(`cvStatus_${s}` as 'cvStatus_filled')] as const)]}
            />
            <p className="muted pp-count" role="status">
              {t('mnCountNewest', { n: shown.length })}
            </p>
          </div>
          {r.status === 'loading' ? (
            <PortalLoading rows={3} />
          ) : r.status === 'failed' ? (
            <PortalFailure result={r.failure} retry={orders.reload} />
          ) : (
            <ListBody
              state={{ status: 'ready', items: shown, hasMore: false, more: 'idle' }}
              retry={orders.reload}
              onMore={() => undefined}
              filtered={{ active: Boolean(status), clear: () => setStatus('') }}
              empty={{
                title: t('cvEmptyTitle'),
                body: t('cvEmptyBody'),
                action: <LinkButton href="/pay/conversion/new">{t('cvNew')}</LinkButton>,
              }}
              label={t('cvTable')}
              rowKey={(o) => o.conversionId}
              href={(o) => orderHref(o.conversionId)}
              columns={[
                {
                  header: t('mnColConversion'),
                  cell: (o) => t('cvName', { from: o.fromAsset, to: o.toAsset, when: shortDay(o.createdAt, locale) }),
                },
                { header: t('cvFrom'), cell: (o) => <MoneyText value={o.fromAmount} asset={o.fromAsset} test /> },
                { header: t('cvGot'), cell: (o) => <MoneyText value={o.filledToAmount} asset={o.toAsset} test /> },
                { header: t('colStatus'), cell: (o) => <ConversionChip status={o.status} /> },
              ]}
              card={(o) => ({
                title: t('cvName', { from: o.fromAsset, to: o.toAsset, when: shortDay(o.createdAt, locale) }),
                time: <DateTime value={o.createdAt} />,
                amount: <MoneyText value={o.fromAmount} asset={o.fromAsset} test />,
                status: <ConversionChip status={o.status} />,
              })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** `/pay/conversion/:id`: one test conversion, from quote to fill. */
export function ConversionDetail({ portal, orderId }: { portal: PortalApi; orderId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const valid = isUuid(orderId);
  const order = useResource(
    (s) => (valid ? portal.conversionGet(orderId, s) : Promise.resolve(localRefusal(t('rConversionNotFound')))),
    `money:conversion:${orderId}`,
  );
  const readAt = useReadAt(order.resource.status === 'ready', order.resource);
  const r = order.resource;
  const off = useMemo(() => r.status === 'failed' && isConversionOff(r.failure), [r]);
  return (
    <div className="stack">
      <TestNotice />
      {off ? (
        <Off />
      ) : (
        <Gate resource={r} retry={order.reload} rows={4}>
          {(o) => (
            <>
              <DetailHeader
                back={{ href: '/pay/conversion', label: t('mnBackConversion') }}
                title={<MoneyText value={o.fromAmount} asset={o.fromAsset} test />}
                status={<ConversionChip status={o.status} />}
                subtitle={t('cvName', { from: o.fromAsset, to: o.toAsset, when: shortDay(o.createdAt, locale) })}
                action={
                  <Button variant="secondary" onClick={order.reload}>
                    {t('cvRefresh')}
                  </Button>
                }
              />
              <Freshness asOf={readAt} />
              <PaySection title={t('cvFactsTitle')}>
                <Facts
                  items={[
                    [t('cvFrom'), <MoneyText value={o.fromAmount} asset={o.fromAsset} test />],
                    [t('cvFilledFrom'), <MoneyText value={o.filledFromAmount} asset={o.fromAsset} test />],
                    [t('cvGot'), <MoneyText value={o.filledToAmount} asset={o.toAsset} test />],
                    ...(o.failureCode ? ([[t('cvFailure'), t('cvFailureBody')]] as const) : []),
                    [t('stlId'), <CopyReference value={o.conversionId} what={t('stlId')} />],
                  ]}
                />
              </PaySection>
              <PaySection title={t('cvTimelineTitle')}>
                <Timeline
                  label={t('cvTimelineTitle')}
                  items={[
                    { at: o.createdAt, title: t('cvEvCreated') },
                    ...(o.updatedAt !== o.createdAt ? [{ at: o.updatedAt, title: t(`cvStatus_${o.status}` as 'cvStatus_filled') }] : []),
                  ]}
                />
              </PaySection>
              <RelatedLinks links={[{ href: `/pay/settlements/${encodeURIComponent(o.settlementId)}`, label: t('mnRelSettlement') }]} />
            </>
          )}
        </Gate>
      )}
    </div>
  );
}
