import { useMemo, type ReactNode } from 'react';
import { useSession } from '../../session/session';
import { useResource, type Resource } from '../../../shared/resource';
import { EmptyState, Page } from '../../../shared/ui';
import { payCopy } from '../copy';
import { businessRooms } from '../BusinessPay';
import { createPortalApi, type PortalApi } from './api';
import { Gate, PortalLoading } from './components';
import { portalCopy } from './copy';
import { Customers, CustomerDetailPage } from './Customers';
import { Dashboard } from './Dashboard';
import { Disputes, DisputeDetailPage } from './Disputes';
import { Exports } from './Exports';
import { Approvals } from './Approvals';
import { Limits } from './Limits';
import { Notifications } from './Notifications';
import { Onboarding } from './Onboarding';
import { PaymentDetailPage, Payments } from './Payments';
import { PayoutDetailPage, Payouts } from './Payouts';
import { Pricing } from './Pricing';
import { SettlementDetailPage, Settlements } from './Settlements';
import { parsePortalRoute, portalLinks, type PortalRoute } from './routes';
import { Team } from './Team';
import type { MemberRole, MerchantRecord } from './schemas';
import './portal.css';

type Account = { merchantId: string; record: MerchantRecord | null; role: MemberRole | null };

/**
 * The merchant portal shell (W3a). Every page here is scoped by the server from the signed session, so the
 * browser never names a merchant. `starterFeeBps` is the fee INTAFACED has published for new accounts: null
 * until one is, and a null fee means an account cannot be opened from onboarding.
 * `legacyHome` is the older rails and checkout-domain section, shown under the dashboard when it applies.
 */
export function MerchantPortal({
  path,
  starterFeeBps = null,
  legacyHome = null,
}: {
  path: string;
  starterFeeBps?: number | null;
  legacyHome?: ReactNode;
}) {
  const { api, userId } = useSession();
  const portal = useMemo(() => createPortalApi(api, userId), [api, userId]);
  const route = parsePortalRoute(path);
  const merchant = useResource((s) => portal.merchant(s), `portal:merchant:${userId ?? 'anon'}`);
  const team = useResource((s) => portal.teamMe(s), `portal:team-me-shell:${userId ?? 'anon'}`);
  if (!route) return null;
  return (
    <PortalFrame route={route}>
      <PortalRoom
        route={route}
        portal={portal}
        merchant={merchant.resource}
        reloadMerchant={merchant.reload}
        team={team.resource}
        starterFeeBps={starterFeeBps}
        legacyHome={legacyHome}
      />
    </PortalFrame>
  );
}

export function PortalFrame({ route, children }: { route: PortalRoute; children: ReactNode }) {
  const { t } = portalCopy.useCopy();
  const copy = roomCopy(route, t);
  const here = hrefFor(route);
  return (
    <Page eyebrow={payCopy.t('businessPay')} title={copy.title} description={copy.purpose} actions={copy.action}>
      <div className="pay-business">
        <nav aria-label={payCopy.t('businessPayRooms')} className="pay-business-nav">
          {businessRooms.map(([href, label]) => (
            <a href={href} key={href} aria-current={href === here ? 'page' : undefined}>
              {payCopy.t(label)}
            </a>
          ))}
          {portalLinks.map(([href, label]) => (
            <a href={href} key={href} aria-current={href === here ? 'page' : undefined}>
              {t(label)}
            </a>
          ))}
        </nav>
        <div className="pay-business-content pp">{children}</div>
      </div>
    </Page>
  );
}

const hrefFor = (route: PortalRoute) =>
  route.room === 'dashboard'
    ? '/pay/merchant'
    : route.room === 'dispute'
      ? '/pay/disputes'
      : route.room === 'customer'
        ? '/pay/customers'
        : route.room === 'payment'
          ? '/pay/payments'
          : route.room === 'settlement'
            ? '/pay/settlements'
            : route.room === 'payout'
              ? '/pay/payouts'
              : `/pay/${route.room}`;

type T = ReturnType<typeof portalCopy.useCopy>['t'];
function roomCopy(route: PortalRoute, t: T): { title: string; purpose: string; action?: ReactNode } {
  switch (route.room) {
    case 'dashboard':
      return {
        title: t('pageDashboard'),
        purpose: t('purposeDashboard'),
        action: (
          <a className="button button--primary" href="/pay/links">
            {t('actCreateLink')}
          </a>
        ),
      };
    case 'onboarding':
      return { title: t('pageOnboarding'), purpose: t('purposeOnboarding') };
    case 'team':
      return {
        title: t('pageTeam'),
        purpose: t('purposeTeam'),
        action: (
          <a className="button button--primary" href="#invite">
            {t('actInvite')}
          </a>
        ),
      };
    case 'disputes':
      return { title: t('pageDisputes'), purpose: t('purposeDisputes') };
    case 'dispute':
      return { title: t('pageDispute'), purpose: t('purposeDispute') };
    case 'customers':
      return { title: t('pageCustomers'), purpose: t('purposeCustomers') };
    case 'customer':
      return { title: t('pageCustomer'), purpose: t('purposeCustomer') };
    case 'exports':
      return {
        title: t('pageExports'),
        purpose: t('purposeExports'),
        action: (
          <a className="button button--primary" href="#request">
            {t('actRequestExport')}
          </a>
        ),
      };
    case 'notifications':
      return { title: t('pageNotifications'), purpose: t('purposeNotifications') };
    case 'payments':
      return {
        title: t('pagePayments'),
        purpose: t('purposePayments'),
        action: (
          <a className="button button--primary" href="/pay/payments?view=tools">
            {t('actPaymentTools')}
          </a>
        ),
      };
    case 'payment':
      return {
        title: t('pagePayment'),
        purpose: t('purposePayment'),
        action: route.param ? (
          <a className="button button--primary" href={`/pay/payments?view=tools&payment=${encodeURIComponent(route.param)}`}>
            {t('refundOrCapture')}
          </a>
        ) : undefined,
      };
    case 'settlements':
      return {
        title: t('pageSettlements'),
        purpose: t('purposeSettlements'),
        action: (
          <a className="button button--primary" href="/pay/settlements?view=tools">
            {t('actSettlementTools')}
          </a>
        ),
      };
    case 'settlement':
      return { title: t('pageSettlement'), purpose: t('purposeSettlement') };
    case 'payouts':
      return {
        title: t('pagePayouts'),
        purpose: t('purposePayouts'),
        action: (
          <a className="button button--primary" href="/pay/payouts?view=tools">
            {t('actRequestPayout')}
          </a>
        ),
      };
    case 'payout':
      return { title: t('pagePayout'), purpose: t('purposePayout') };
    case 'approvals':
      return { title: t('pageApprovals'), purpose: t('purposeApprovals') };
    case 'pricing':
      return { title: t('pagePricing'), purpose: t('purposePricing') };
    case 'limits':
      return { title: t('pageLimits'), purpose: t('purposeLimits') };
  }
}

function PortalRoom({
  route,
  portal,
  merchant,
  reloadMerchant,
  team,
  starterFeeBps,
  legacyHome,
}: {
  route: PortalRoute;
  portal: PortalApi;
  merchant: Resource<MerchantRecord | null>;
  reloadMerchant: () => void;
  team: Resource<{ merchantId: string; userId: string; role: MemberRole }>;
  starterFeeBps: number | null;
  legacyHome: ReactNode;
}) {
  const { t } = portalCopy.useCopy();
  const acct = { merchant, reload: reloadMerchant, team };
  switch (route.room) {
    case 'dashboard':
      return (
        <Gate resource={merchant} retry={reloadMerchant} rows={5}>
          {(record) => {
            const account: Account | null = record
              ? { merchantId: record.id, record, role: team.status === 'ready' ? team.data.role : null }
              : team.status === 'ready'
                ? { merchantId: team.data.merchantId, record: null, role: team.data.role }
                : null;
            if (!account)
              return (
                <EmptyState
                  title={t('noMerchantTitle')}
                  action={
                    <a className="button button--primary" href="/pay/onboarding">
                      {t('startSetup')}
                    </a>
                  }
                >
                  {t('noMerchantBody')}
                </EmptyState>
              );
            return (
              <div className="stack">
                <Dashboard portal={portal} merchantId={account.merchantId} merchant={account.record} role={account.role} />
                {legacyHome}
              </div>
            );
          }}
        </Gate>
      );
    case 'onboarding':
      return (
        <Gate resource={merchant} retry={reloadMerchant} rows={4}>
          {(record) => <Onboarding portal={portal} merchant={record} reloadMerchant={reloadMerchant} starterFeeBps={starterFeeBps} />}
        </Gate>
      );
    case 'team':
      return <Team portal={portal} />;
    case 'disputes':
      return <Disputes portal={portal} />;
    case 'dispute':
      return <DisputeDetailPage portal={portal} disputeId={route.param!} />;
    case 'customers':
      return <Customers portal={portal} />;
    case 'customer':
      return <CustomerDetailPage portal={portal} customerRef={route.param!} />;
    case 'exports':
      return <Exports portal={portal} />;
    case 'notifications':
      return <Notifications portal={portal} />;
    case 'payments':
      return <WithAccount {...acct}>{({ merchantId }) => <Payments portal={portal} merchantId={merchantId} />}</WithAccount>;
    case 'payment':
      return <PaymentDetailPage portal={portal} paymentId={route.param!} />;
    case 'settlements':
      return <WithAccount {...acct}>{({ merchantId }) => <Settlements portal={portal} merchantId={merchantId} />}</WithAccount>;
    case 'settlement':
      return (
        <WithAccount {...acct}>
          {({ merchantId }) => <SettlementDetailPage portal={portal} merchantId={merchantId} settlementId={route.param!} />}
        </WithAccount>
      );
    case 'payouts':
      return <WithAccount {...acct}>{({ merchantId }) => <Payouts portal={portal} merchantId={merchantId} />}</WithAccount>;
    case 'payout':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role, record }) => (
            <PayoutDetailPage portal={portal} merchantId={merchantId} payoutId={route.param!} role={role} merchant={record} />
          )}
        </WithAccount>
      );
    case 'approvals':
      return (
        <WithAccount {...acct}>{({ merchantId, role }) => <Approvals portal={portal} merchantId={merchantId} role={role} />}</WithAccount>
      );
    case 'pricing':
      return <WithAccount {...acct}>{({ merchantId }) => <Pricing portal={portal} merchantId={merchantId} />}</WithAccount>;
    case 'limits':
      return (
        <WithAccount {...acct}>
          {({ merchantId, record }) => <Limits portal={portal} merchantId={merchantId} merchant={record} />}
        </WithAccount>
      );
  }
}

type AccountProps = {
  merchant: Resource<MerchantRecord | null>;
  reload: () => void;
  team: Resource<{ merchantId: string; userId: string; role: MemberRole }>;
};
/**
 * Which account a page reads. The owner's record names it; a team member has no record of their own, so their team
 * membership does. Neither is a merchant id the browser chose: both come from the signed session on the server.
 * A person with no account at all is sent to set one up, not shown an error.
 */
export function WithAccount({
  merchant,
  reload,
  team,
  children,
}: AccountProps & { children: (account: { merchantId: string; role: MemberRole | null; record: MerchantRecord | null }) => ReactNode }) {
  const { t } = portalCopy.useCopy();
  return (
    <Gate resource={merchant} retry={reload} rows={4}>
      {(record) => {
        if (record) return <>{children({ merchantId: record.id, role: team.status === 'ready' ? team.data.role : null, record })}</>;
        if (team.status === 'loading') return <PortalLoading rows={4} />;
        if (team.status === 'ready') return <>{children({ merchantId: team.data.merchantId, role: team.data.role, record: null })}</>;
        return (
          <EmptyState
            title={t('noMerchantTitle')}
            action={
              <a className="button button--primary" href="/pay/onboarding">
                {t('startSetup')}
              </a>
            }
          >
            {t('noMerchantBody')}
          </EmptyState>
        );
      }}
    </Gate>
  );
}
