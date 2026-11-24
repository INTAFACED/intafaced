// volt-room: /pay/money
// volt-room: portal:money
import { Segmented } from '@intafaced/ui/lit/templates';
import { useResource, type Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { useNow, useUrlParam } from '../hooks';
import { DateTime, useDayText } from '../ui/DateTime';
import { moneyPlaces } from '../ui/format';
import { utcDay } from '../model';
import { RefundsIssuedValue } from '../payments/RefundsIssued';
import {
  Empty,
  EntityList,
  Failure,
  Freshness,
  HaltNotice,
  HeroFigure,
  KpiStrip,
  LinkButton,
  Loading,
  MoneyText,
  Section,
  StatusChip,
  haltShows,
} from '../volt/parts';
import { OverviewRoom, useOverviewGate, type OverviewFrame } from '../volt/OverviewRoom';
import { MoneyFailure, TestBanner } from './kit-parts';
import { payoutName } from './money-words';
import { useTestMode } from './test-mode';
import { mc } from './copy';
import { amountFor, hasHiddenDigits } from './model';
import { ReserveCard } from './Reserve';
import { AllBalances } from './AllBalances';
import { OutsideFunds } from './OutsideFunds';
import { movementColumns } from './statement-columns';
import { pictureCount, usePayoutPicture, type PayoutPicture } from './payout-picture';
import { defaultStatementRange, payoutRowState } from './model';
import type { Approval } from '../schemas';
import type { PayHeldClearing as HeldClearing } from '@intafaced/contracts/pay-merchant-reads';
import { uiCopy } from '../ui/copy';

const WEEK = 7 * 86_400_000;

/**
 * `/pay/money`: what you can pay out now, what is still on its way, and what happened lately, on the overview template.
 * The business comes from the resolved access; a person whose role may not read payments sees the template's own state.
 */
export function MerchantMoney({ portal }: { portal: PortalApi }) {
  const { frame, account } = useOverviewGate('payments.read');
  if (!account) return <OverviewRoom frame={frame} hero={null} />;
  return <MoneyOverview portal={portal} merchantId={account.merchantId} frame={frame} />;
}

function MoneyOverview({ portal, merchantId, frame }: { portal: PortalApi; merchantId: string; frame: OverviewFrame }) {
  const { t } = mc.useCopy();
  const dayText = useDayText();
  const utcToday = dayText(utcDay(new Date(useNow(300_000))));
  const [picked, setAsset] = useUrlParam('asset', '');
  const test = useTestMode();
  const snapshot = useResource((s) => portal.snapshot(merchantId, 'today', s), `money:snapshot:${merchantId}`);
  const reserve = useResource((s) => portal.reserve(merchantId, s), `money:reserve:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  // svc-pay's own list of the assets this business settles in, each with its ledger figures (J-merchant-07 #1).
  const enabled = useResource((s) => portal.settlementAssets(merchantId, s), `money:settlement-assets:${merchantId}`);
  // The acquiring partner's own terms: its reserve rule and the currencies it offers, "not known" until it says.
  const partner = useResource((s) => portal.partnerTerms(merchantId, s), `money:partner-terms:${merchantId}`);
  // The same read Settlements and Payouts use, so "ready" and "waiting" are the same figures on every page.
  const picture = usePayoutPicture(portal, merchantId);
  // Launch money model (J-merchant-04): what customers paid into the business's own wallet or to the partner, as they report it.
  const outside = useResource((s) => portal.outsideFunds(s), `money:outside-funds:${merchantId}`);
  const reload = () => {
    snapshot.reload();
    reserve.reload();
    halts.reload();
    enabled.reload();
    partner.reload();
    picture.reload();
    outside.reload();
  };
  const halted = haltShows(halts.resource, ['settlement', 'payout']);
  const needsYou =
    halted || test ? (
      <>
        {halted && <HaltNotice resource={halts.resource} scopes={['settlement', 'payout']} />}
        <TestBanner />
      </>
    ) : undefined;
  // Outside the balance read, so Top up is reachable before the first payment and while balances cannot be read.
  const actions = (
    <div className="lt-actions">
      <LinkButton href="/pay/money/top-up">{t('actTopUp')}</LinkButton>
    </div>
  );
  // The reserve and the money held outside read apart from the balances, so they show before a first payment and while
  // balances cannot be read.
  const watching = (
    <>
      <OutsideFunds funds={outside.resource} retry={outside.reload} test={test} />
      <ReserveCard resource={reserve.resource} partner={partner.resource} retry={reserve.reload} test={test} />
    </>
  );
  const s = snapshot.resource;
  if (s.status !== 'ready')
    return (
      <OverviewRoom
        frame={frame}
        hero={s.status === 'loading' ? <Loading rows={4} /> : <Failure result={s.failure} retry={reload} />}
        actions={actions}
        needsYou={needsYou}
        watching={watching}
      />
    );
  const data = s.data;
  const assets = data.balances.map((b) => b.assetCode);
  if (assets.length === 0)
    return (
      <OverviewRoom
        frame={frame}
        hero={
          <Empty title={t('balEmptyTitle')} action={<LinkButton href="/pay/links/new">{t('balEmptyAction')}</LinkButton>}>
            {t('balEmptyBody')}
          </Empty>
        }
        actions={actions}
        needsYou={needsYou}
        sections={<AllBalances held={[]} enabled={enabled.resource} partner={partner.resource} retry={enabled.reload} test={test} />}
        watching={watching}
      />
    );
  const asset = assets.includes(picked) ? picked : assets[0]!;
  const balance = data.balances.find((b) => b.assetCode === asset)!;
  const q = `asset=${encodeURIComponent(asset)}`;
  const pic = picture.resource.status === 'ready' ? picture.resource.data : null;
  const countOf = (state: 'ready' | 'awaiting_approval') => {
    if (!pic) return '—';
    const c = pictureCount(pic, state);
    return c.newest ? t('mnCountNewest', { n: c.n }) : String(c.n);
  };
  const approvalMap = pic?.approvals ?? null;
  const capturedToday = amountFor(data.captured, asset);
  const refundedToday = amountFor(data.refunded, asset);
  const hero = (
    <>
      <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
      {assets.length > 1 && (
        <Segmented label={t('balAssetLabel')} value={asset} onChange={setAsset} options={assets.map((a) => ({ value: a, label: a }))} />
      )}
      <p className="lt-hint">{t('balAvailable')}</p>
      <HeroFigure value={balance.available} asset={asset} />
      {hasHiddenDigits(balance.available, moneyPlaces(asset)) && (
        <p className="lt-hint">
          {t('balExact')} <MoneyText value={balance.available} asset={asset} test={test} />
        </p>
      )}
      <p className="lt-hint">
        {t('balClearing')} <MoneyText value={balance.clearing} asset={asset} test={test} />
      </p>
    </>
  );
  const sections = (
    <>
      <KpiStrip
        label={t('balTiles')}
        tiles={[
          {
            label: t('balAvailable'),
            period: t('mnPeriodNow'),
            href: `/pay/money/activity?${q}`,
            value: <MoneyText value={balance.available} asset={asset} test={test} />,
          },
          {
            label: t('balClearing'),
            period: t('mnPeriodNow'),
            href: `/pay/money/activity?${q}`,
            value: <MoneyText value={balance.clearing} asset={asset} test={test} />,
          },
          {
            label: t('balCaptured'),
            period: t('mnPeriodToday', { day: utcToday }),
            href: `/pay/payments?date=today&${q}`,
            value: capturedToday ? <MoneyText value={capturedToday} asset={asset} test={test} /> : '—',
          },
          {
            label: t('balRefunded'),
            period: t('mnPeriodToday', { day: utcToday }),
            href: `/pay/refunds?date=today&${q}`,
            value: refundedToday ? <MoneyText value={refundedToday} asset={asset} test={test} /> : '—',
            note: t('balRefundedNote'),
          },
          {
            label: t('balRefundsIssued'),
            period: t('mnPeriodToday', { day: utcToday }),
            href: '/pay/refunds?date=today',
            value: <RefundsIssuedValue portal={portal} merchantId={merchantId} when="today" />,
            note: t('balRefundsIssuedNote'),
          },
          {
            label: t('balReady'),
            period: t('mnPeriodNow'),
            href: '/pay/payouts?status=ready',
            value: countOf('ready'),
          },
          {
            label: t('balWaiting'),
            period: t('mnPeriodNow'),
            href: '/pay/approvals?status=pending',
            value: countOf('awaiting_approval'),
            tone: pic && pic.tally.awaiting_approval > 0 ? 'attention' : undefined,
          },
        ]}
      />
      <AllBalances held={data.balances} enabled={enabled.resource} partner={partner.resource} retry={enabled.reload} test={test} />
      <StillClearing portal={portal} merchantId={merchantId} test={test} />
      <OnTheWay resource={picture.resource} approvals={approvalMap} retry={picture.reload} test={test} />
      <RecentMovements portal={portal} merchantId={merchantId} asset={asset} test={test} />
      <p className="lt-hint">
        <a className="lt-link" href="/pay/conversion">
          {t('balConversionLink')}
        </a>
      </p>
    </>
  );
  return <OverviewRoom frame={frame} hero={hero} actions={actions} needsYou={needsYou} sections={sections} watching={watching} />;
}

/**
 * RC-merchant-10: the captured payments whose money the rail still holds, apart from what is available, each with the
 * day the rail said it becomes available, or "not given yet" when the rail named none.
 */
function StillClearing({ portal, merchantId, test }: { portal: PortalApi; merchantId: string; test: boolean }) {
  const { t } = mc.useCopy();
  const list = useResource((s) => portal.clearing(merchantId, s), `money:clearing:${merchantId}`);
  const r = list.resource;
  const on = (h: HeldClearing) => (h.availableOn ? <DateTime value={h.availableOn} /> : t('balHeldUnknown'));
  return (
    <Section title={t('balHeldTitle')} description={t('balHeldBody')}>
      {r.status === 'loading' ? (
        <Loading rows={2} />
      ) : r.status === 'failed' ? (
        <MoneyFailure result={r.failure} retry={list.reload} />
      ) : r.data.held.length === 0 ? (
        <p className="lt-hint" data-testid="mn-held-none">
          {t('balHeldNone')}
        </p>
      ) : (
        <EntityList
          label={t('balHeldTitle')}
          rows={r.data.held}
          rowKey={(h) => h.paymentId}
          href={(h) => `/pay/payments/${encodeURIComponent(h.paymentId)}`}
          columns={[
            { header: t('mnColPayment'), cell: (h) => h.paymentId.slice(0, 8) },
            { header: t('colAmount'), cell: (h) => <MoneyText value={h.amount} asset={h.assetId} test={test} /> },
            { header: t('balHeldOn'), cell: on },
          ]}
        />
      )}
    </Section>
  );
}

function OnTheWay({
  resource,
  approvals,
  retry,
  test,
}: {
  resource: Resource<PayoutPicture>;
  approvals: ReadonlyMap<string, Approval> | null;
  retry: () => void;
  test: boolean;
}) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const r = resource;
  const items = r.status === 'ready' ? r.data.items.filter((p) => p.status === 'posted' || p.status === 'pending') : [];
  return (
    <Section
      title={t('balOnTheWayTitle')}
      description={t('balOnTheWayBody')}
      action={
        <a className="lt-link" href="/pay/payouts">
          {t('balAllPayouts')}
        </a>
      }
    >
      {r.status === 'loading' ? (
        <Loading rows={2} />
      ) : r.status === 'failed' ? (
        <Failure result={r.failure} retry={retry} />
      ) : items.length === 0 ? (
        <p className="lt-hint">{t('balOnTheWayNone')}</p>
      ) : (
        <EntityList
          label={t('balOnTheWayTitle')}
          rows={[...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))}
          rowKey={(p) => p.id}
          href={(p) => `/pay/payouts/${encodeURIComponent(p.id)}`}
          columns={[
            { header: t('colPayout'), cell: (p) => payoutName(t, locale, p, approvals?.get(p.id)) },
            { header: t('colAmount'), cell: (p) => <MoneyText value={p.net} asset={p.assetId} test={test} /> },
            { header: t('colStatus'), cell: (p) => <StatusChip entity="payout" value={payoutRowState(p, approvals)} /> },
          ]}
        />
      )}
    </Section>
  );
}

function RecentMovements({ portal, merchantId, asset, test }: { portal: PortalApi; merchantId: string; asset: string; test: boolean }) {
  const { t } = mc.useCopy();
  const now = useNow(300_000);
  const end = defaultStatementRange(now).to;
  const from = new Date(Date.parse(end) - WEEK - 86_400_000).toISOString();
  const list = useResource(
    (s) => portal.statementPage(merchantId, { assetId: asset, from, to: end }, undefined, s, 6),
    `money:movements:${merchantId}:${asset}:${from}`,
  );
  const r = list.resource;
  return (
    <Section
      title={t('balMovementsTitle')}
      action={
        <a className="lt-link" href={`/pay/money/activity?asset=${encodeURIComponent(asset)}`}>
          {t('balStatementLink')}
        </a>
      }
    >
      {r.status === 'loading' ? (
        <Loading rows={3} />
      ) : r.status === 'failed' ? (
        <MoneyFailure result={r.failure} retry={list.reload} />
      ) : r.data.items.length === 0 ? (
        <p className="lt-hint">{t('balMovementsNone')}</p>
      ) : (
        <EntityList label={t('balMovementsTitle')} rows={r.data.items} rowKey={(l) => l.id} columns={movementColumns(t, test)} />
      )}
    </Section>
  );
}
