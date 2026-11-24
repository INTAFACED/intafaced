// volt-room: /pay/conversion
// volt-room: /pay/conversion/:orderId
// volt-room: portal:conversion
// volt-room: portal:conversion-order
import { useMemo } from 'react';
import { Button } from '@intafaced/ui/lit';
import { useResource } from '../../../../shared/resource';
import type { ApiResult } from '../../../../shared/api';
import type { PortalApi } from '../api';
import { useReadAt, useUrlParam } from '../hooks';
import { isUuid } from '../model';
import { uiCopy } from '../ui/copy';
import type { StatusTone } from '../ui/StatusChip';
import {
  CopyReference,
  Empty,
  Facts,
  Failure,
  Freshness,
  Gate,
  HaltNotice,
  KpiStrip,
  LinkButton,
  Loading,
  MoneyText,
  Section,
  SelectField,
  TestTag,
  Timeline,
  ToneChip,
} from '../volt/parts';
import { RecordListRoom } from '../volt/RecordListRoom';
import { PAY_CONVERSION_STATUSES as conversionStatuses } from '@intafaced/contracts/conversion';
import { mc } from './copy';
import { ListBody, NamedBlocker } from './kit-parts';
import { shortDay } from './money-words';
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
const orderHref = (id: string) => `/pay/conversion/${encodeURIComponent(id)}`;
/** A refusal the page makes itself, before asking the service (an address that is not an order id). */
const localRefusal = (message: string): Extract<ApiResult<never>, { ok: false }> => ({
  ok: false,
  reason: 'error',
  code: 'portal.local',
  message,
});

/** Conversion is a sandbox. This says so on every conversion page, before anything else. */
function TestNotice() {
  const { t } = mc.useCopy();
  return (
    <p className="lt-hint" role="note">
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

/** `/pay/conversion` on the record-list template: your test conversions, for the account the access resolved. */
export function ConversionRoom({ portal }: { portal: PortalApi }) {
  return <RecordListRoom>{({ merchantId }) => ({ list: <Conversion portal={portal} merchantId={merchantId} /> })}</RecordListRoom>;
}

/** `/pay/conversion/:orderId` on the record-list template: one order's own page. */
export function ConversionOrderRoom({ portal, orderId }: { portal: PortalApi; orderId: string }) {
  return <RecordListRoom>{() => ({ detail: <ConversionDetail portal={portal} orderId={orderId} /> })}</RecordListRoom>;
}

/** `/pay/conversion`: your test conversions from US dollars to USDT. */
function Conversion({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
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
    <div className="lt-stack">
      <TestNotice />
      <HaltNotice resource={halts.resource} scopes={['conversion']} />
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
          <div className="lt-toolbar">
            <SelectField
              label={t('colStatus')}
              value={status}
              onChange={setStatus}
              options={[['', t('cvAllStatuses')], ...conversionStatuses.map((s) => [s, t(`cvStatus_${s}` as 'cvStatus_filled')] as const)]}
            />
            <p className="lt-muted" role="status">
              {t('mnCountNewest', { n: shown.length })}
            </p>
          </div>
          {r.status === 'loading' ? (
            <Loading rows={3} />
          ) : r.status === 'failed' ? (
            <Failure result={r.failure} retry={orders.reload} />
          ) : shown.length === 0 && status ? (
            // Filters are on: an empty result offers to clear them instead of explaining what the list is.
            <Empty
              title={t('mnNoMatchTitle')}
              action={
                <Button tone="secondary" onClick={() => setStatus('')}>
                  {t('clearFilters')}
                </Button>
              }
            >
              {t('mnNoMatchBody')}
            </Empty>
          ) : (
            <ListBody
              state={{ status: 'ready', items: shown, hasMore: false, more: 'idle' }}
              retry={orders.reload}
              onMore={() => undefined}
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
            />
          )}
        </>
      )}
    </div>
  );
}

/** `/pay/conversion/:id`: one test conversion, from quote to fill. */
function ConversionDetail({ portal, orderId }: { portal: PortalApi; orderId: string }) {
  const { t } = mc.useCopy();
  const { t: u, requestedLocale: locale } = uiCopy.useCopy();
  const valid = isUuid(orderId);
  const order = useResource(
    (s) => (valid ? portal.conversionGet(orderId, s) : Promise.resolve(localRefusal(t('rConversionNotFound')))),
    `money:conversion:${orderId}`,
  );
  const readAt = useReadAt(order.resource.status === 'ready', order.resource);
  const r = order.resource;
  const off = useMemo(() => r.status === 'failed' && isConversionOff(r.failure), [r]);
  return (
    <div className="lt-stack">
      <TestNotice />
      {off ? (
        <Off />
      ) : (
        <Gate resource={r} retry={order.reload} rows={4}>
          {(o) => (
            <>
              <header className="lt-stack">
                <a className="lt-link" href="/pay/conversion">
                  {t('mnBackConversion')}
                </a>
                <div className="lt-toolbar">
                  <div>
                    <h2>
                      <MoneyText value={o.fromAmount} asset={o.fromAsset} test /> <ConversionChip status={o.status} />
                    </h2>
                    <p className="lt-muted">{t('cvName', { from: o.fromAsset, to: o.toAsset, when: shortDay(o.createdAt, locale) })}</p>
                  </div>
                  <Button tone="secondary" onClick={order.reload}>
                    {t('cvRefresh')}
                  </Button>
                </div>
              </header>
              <Freshness asOf={readAt} />
              <Section title={t('cvFactsTitle')}>
                <Facts
                  items={[
                    [t('cvFrom'), <MoneyText value={o.fromAmount} asset={o.fromAsset} test />],
                    [t('cvFilledFrom'), <MoneyText value={o.filledFromAmount} asset={o.fromAsset} test />],
                    [t('cvGot'), <MoneyText value={o.filledToAmount} asset={o.toAsset} test />],
                    ...(o.failureCode ? ([[t('cvFailure'), t('cvFailureBody')]] as const) : []),
                    [t('stlId'), <CopyReference value={o.conversionId} what={t('stlId')} />],
                  ]}
                />
              </Section>
              <Section title={t('cvTimelineTitle')}>
                <Timeline
                  label={t('cvTimelineTitle')}
                  items={[
                    { at: o.createdAt, title: t('cvEvCreated') },
                    ...(o.updatedAt !== o.createdAt ? [{ at: o.updatedAt, title: t(`cvStatus_${o.status}` as 'cvStatus_filled') }] : []),
                  ]}
                />
              </Section>
              <nav aria-label={u('related')}>
                <h3>{u('related')}</h3>
                <ul>
                  <li>
                    <a className="lt-link" href={`/pay/settlements/${encodeURIComponent(o.settlementId)}`}>
                      {t('mnRelSettlement')}
                    </a>
                  </li>
                </ul>
              </nav>
            </>
          )}
        </Gate>
      )}
    </div>
  );
}
