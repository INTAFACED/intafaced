import { Button } from '@intafaced/ui';
import { useMemo, type ReactNode } from 'react';
import { useSession } from '../../session/session';
import { useResource, type Resource } from '../../../shared/resource';
import { EmptyState, Page } from '@intafaced/ui';
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
import { currentLayout } from './layout-options/layout';
import { LayoutFrame } from './layout-options/Frame';
import { Refunds } from './Refunds';
import { Links } from './Links';
import { MerchantMoney, BalanceActivity } from './Money';
import { Conversion, conversionHeader } from './Conversion';
import { Subscriptions, subscriptionHeader } from './Subscriptions';
import { Compliance } from './Compliance';
import { Settings, SettingsNav } from './Settings';
import { Developers, developerHeader } from './Developers';
import { Invoices } from './Invoices';
import { extensionCopy } from './extension-copy';
import { Reports } from './Reports';
import { w3cCopy } from './w3c-copy';
import type { PayBusinessAuthority } from '../pay-api';

type Account = { merchantId: string; record: MerchantRecord | null; role: MemberRole | null };

/**
 * The merchant portal shell (W3a). Every page here is scoped by the server from the signed session, so the
 * browser never names a merchant. `starterFeeBps` is the fee INTAFACED has published for new accounts: null
 * until one is, and a null fee means an account cannot be opened from onboarding.
 * `legacyHome` is the older rails and checkout-domain section, shown under the dashboard when it applies.
 */
export function MerchantPortal({
  path,
  authority = null,
  starterFeeBps = null,
  legacyHome = null,
}: {
  path: string;
  authority?: PayBusinessAuthority | null;
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
        authority={authority}
        portal={portal}
        merchant={merchant.resource}
        reloadMerchant={merchant.reload}
        team={team.resource}
        starterFeeBps={starterFeeBps}
        legacyHome={!currentLayout() && legacyHome}
      />
    </PortalFrame>
  );
}

export function PortalFrame({ route, children }: { route: PortalRoute; children: ReactNode }) {
  const { t } = portalCopy.useCopy();
  const copy = roomCopy(route, t);
  const here = hrefFor(route);
  const layout = currentLayout();
  if (layout)
    return (
      <LayoutFrame layout={layout} here={here} title={copy.title} purpose={copy.purpose} action={copy.action}>
        {children}
      </LayoutFrame>
    );
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

const hrefFor = (route: PortalRoute) => {
  if (route.room.startsWith('developer')) return '/pay/developer';
  if (route.room === 'invoice') return '/pay/invoices';
  if (route.room === 'subscription' || route.room === 'subscription-new') return '/pay/subscriptions';
  if (route.room.startsWith('settings')) return '/pay/settings';
  if (route.room.startsWith('conversion')) return '/pay/conversion';
  return route.room === 'money-activity'
    ? '/pay/money'
    : route.room === 'report-exports'
      ? '/pay/reports'
      : route.room === 'link' || route.room === 'link-new'
        ? '/pay/links'
        : route.room === 'refund' || route.room === 'refund-new'
          ? '/pay/refunds'
          : route.room === 'dashboard'
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
};

type T = ReturnType<typeof portalCopy.useCopy>['t'];
function roomCopy(route: PortalRoute, t: T): { title: string; purpose: string; action?: ReactNode } {
  const c = w3cCopy.t;
  switch (route.room) {
    case 'conversion':
    case 'conversion-new':
    case 'conversion-order':
      return conversionHeader(route);
    case 'subscriptions':
    case 'subscription':
    case 'subscription-new':
      return subscriptionHeader(route);
    case 'compliance':
      return {
        title: extensionCopy.t('complianceTitle'),
        purpose: extensionCopy.t('compliancePurpose'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/onboarding/verification" />}>
            {extensionCopy.t('verificationAction')}
          </Button>
        ),
      };
    case 'settings':
    case 'settings-team':
    case 'settings-notifications':
      return {
        title: extensionCopy.t(
          route.room === 'settings-team' ? 'teamTitle' : route.room === 'settings-notifications' ? 'notificationSettings' : 'settingsTitle',
        ),
        purpose: extensionCopy.t('settingsPurpose'),
        action: (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/settings/notifications" />}>
            {extensionCopy.t('notificationSettings')}
          </Button>
        ),
      };
    case 'developer':
    case 'developer-keys':
    case 'developer-signing':
    case 'developer-webhooks':
    case 'developer-endpoint':
    case 'developer-deliveries':
      return developerHeader(route);
    case 'invoices':
    case 'invoice':
      return {
        title: extensionCopy.t(route.room === 'invoice' ? 'invoiceTitle' : 'invoicesTitle'),
        purpose: extensionCopy.t('invoicesPurpose'),
        action: (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/subscriptions" />}>
            {extensionCopy.t('openSubscriptions')}
          </Button>
        ),
      };
    case 'money':
      return {
        title: c('moneyTitle'),
        purpose: c('moneyPurpose'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/money/activity" />}>
            {c('openStatement')}
          </Button>
        ),
      };
    case 'money-activity':
      return {
        title: c('statementTitle'),
        purpose: c('statementPurpose'),
        action: (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/exports" />}>
            {c('exportJobs')}
          </Button>
        ),
      };
    case 'reports':
      return {
        title: c('reportsTitle'),
        purpose: c('reportsPurpose'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/reports/exports" />}>
            {c('exportJobs')}
          </Button>
        ),
      };
    case 'report-exports':
      return {
        title: c('exportJobs'),
        purpose: c('exportJobsPurpose'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="#request" />}>
            {c('reportAction')}
          </Button>
        ),
      };
    case 'links':
      return {
        title: c('linksTitle'),
        purpose: c('linksPurpose'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/links/new" />}>
            {c('linkNew')}
          </Button>
        ),
      };
    case 'link-new':
      return {
        title: c('linkNew'),
        purpose: c('linkNewPurpose'),
        action: (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/links" />}>
            {c('backLinks')}
          </Button>
        ),
      };
    case 'link':
      return {
        title: c('linkDetail'),
        purpose: c('linkDetailPurpose'),
        action: (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/links/new" />}>
            {c('linkNew')}
          </Button>
        ),
      };
    case 'refunds':
      return {
        title: c('refundsTitle'),
        purpose: c('refundsPurpose'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/refunds/new" />}>
            {c('issueRefund')}
          </Button>
        ),
      };
    case 'refund-new':
      return {
        title: c('issueRefund'),
        purpose: c('issuePurpose'),
        action: (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/payments" />}>
            {c('openPayments')}
          </Button>
        ),
      };
    case 'refund':
      return {
        title: c('refundTitle'),
        purpose: c('refundPurpose'),
        action: (
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/refunds" />}>
            {c('backRefunds')}
          </Button>
        ),
      };
    case 'dashboard':
      return {
        title: t('pageDashboard'),
        purpose: t('purposeDashboard'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/links" />}>
            {t('actCreateLink')}
          </Button>
        ),
      };
    case 'onboarding':
      return {
        title: route.step
          ? t(route.step === 'business' ? 'step1Title' : route.step === 'verification' ? 'step2Title' : 'step3Title')
          : t('pageOnboarding'),
        purpose: t('purposeOnboarding'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/merchant" />}>
            {t('openDashboard')}
          </Button>
        ),
      };
    case 'team':
      return {
        title: t('pageTeam'),
        purpose: t('purposeTeam'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="#invite" />}>
            {t('actInvite')}
          </Button>
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
          <Button variant="primary" nativeButton={false} role="link" render={<a href="#request" />}>
            {t('actRequestExport')}
          </Button>
        ),
      };
    case 'notifications':
      return { title: t('pageNotifications'), purpose: t('purposeNotifications') };
    case 'payments':
      return {
        title: t('pagePayments'),
        purpose: t('purposePayments'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/payments?view=tools" />}>
            {t('actPaymentTools')}
          </Button>
        ),
      };
    case 'payment':
      return {
        title: t('pagePayment'),
        purpose: t('purposePayment'),
        action: route.param ? (
          <Button
            variant="primary"
            nativeButton={false}
            role="link"
            render={<a href={`/pay/payments?view=tools&payment=${encodeURIComponent(route.param)}`} />}
          >
            {t('refundOrCapture')}
          </Button>
        ) : undefined,
      };
    case 'settlements':
      return {
        title: t('pageSettlements'),
        purpose: t('purposeSettlements'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/settlements?view=tools" />}>
            {t('actSettlementTools')}
          </Button>
        ),
      };
    case 'settlement':
      return { title: t('pageSettlement'), purpose: t('purposeSettlement') };
    case 'payouts':
      return {
        title: t('pagePayouts'),
        purpose: t('purposePayouts'),
        action: (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/payouts?view=tools" />}>
            {t('actRequestPayout')}
          </Button>
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
  authority,
  portal,
  merchant,
  reloadMerchant,
  team,
  starterFeeBps,
  legacyHome,
}: {
  route: PortalRoute;
  authority: PayBusinessAuthority | null;
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
    case 'conversion':
    case 'conversion-new':
    case 'conversion-order':
      return (
        <WithAccount {...acct}>{({ merchantId }) => <Conversion portal={portal} merchantId={merchantId} route={route} />}</WithAccount>
      );
    case 'subscriptions':
    case 'subscription':
    case 'subscription-new':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role }) => (
            <OwnerOnly role={role}>
              <Subscriptions portal={portal} merchantId={merchantId} route={route} authority={authority} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'compliance':
      return <WithAccount {...acct}>{() => <Compliance portal={portal} />}</WithAccount>;
    case 'settings':
      return <WithAccount {...acct}>{({ record }) => <Settings merchant={record} />}</WithAccount>;
    case 'settings-team':
      return (
        <div className="stack">
          <SettingsNav />
          <Team portal={portal} />
        </div>
      );
    case 'settings-notifications':
      return (
        <WithAccount {...acct}>
          {() => (
            <div className="stack">
              <SettingsNav />
              <Notifications portal={portal} preferencesOnly />
            </div>
          )}
        </WithAccount>
      );
    case 'developer':
    case 'developer-keys':
    case 'developer-signing':
    case 'developer-webhooks':
    case 'developer-endpoint':
    case 'developer-deliveries':
      return <WithAccount {...acct}>{() => <Developers route={route} authority={authority} />}</WithAccount>;
    case 'invoices':
    case 'invoice':
      return <WithAccount {...acct}>{() => <Invoices invoiceId={route.param} />}</WithAccount>;
    case 'money':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role }) => (
            <OwnerOnly role={role}>
              <MerchantMoney portal={portal} merchantId={merchantId} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'money-activity':
      return <WithAccount {...acct}>{() => <BalanceActivity />}</WithAccount>;
    case 'reports':
      return <WithAccount {...acct}>{() => <Reports />}</WithAccount>;
    case 'report-exports':
      return <Exports portal={portal} />;
    case 'links':
    case 'link-new':
    case 'link':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role }) => (
            <OwnerOnly role={role}>
              <Links
                portal={portal}
                merchantId={merchantId}
                create={route.room === 'link-new'}
                linkId={route.param}
                authority={authority}
              />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'refunds':
    case 'refund-new':
    case 'refund':
      return (
        <WithAccount {...acct}>
          {({ role }) => (
            <OwnerOnly role={role}>
              <Refunds portal={portal} refundId={route.param} create={route.room === 'refund-new'} authority={authority} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
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
                    <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/onboarding" />}>
                      {t('startSetup')}
                    </Button>
                  }
                >
                  {t('noMerchantBody')}
                </EmptyState>
              );
            return (
              <div className="stack">
                <Dashboard portal={portal} merchantId={account.merchantId} merchant={account.record} role={account.role} />
                {!currentLayout() && legacyHome}
              </div>
            );
          }}
        </Gate>
      );
    case 'onboarding':
      return (
        <Gate resource={merchant} retry={reloadMerchant} rows={4}>
          {(record) => (
            <Onboarding step={route.step} portal={portal} merchant={record} reloadMerchant={reloadMerchant} starterFeeBps={starterFeeBps} />
          )}
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
      return (
        <WithAccount {...acct}>
          {({ merchantId, role }) => (
            <OwnerOnly role={role}>
              <Payments portal={portal} merchantId={merchantId} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'payment':
      return (
        <WithAccount {...acct}>
          {({ role }) => (
            <OwnerOnly role={role}>
              <PaymentDetailPage portal={portal} paymentId={route.param!} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'settlements':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role }) => (
            <OwnerOnly role={role}>
              <Settlements portal={portal} merchantId={merchantId} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'settlement':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role }) => (
            <OwnerOnly role={role}>
              <SettlementDetailPage portal={portal} merchantId={merchantId} settlementId={route.param!} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'payouts':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role }) => (
            <OwnerOnly role={role}>
              <Payouts portal={portal} merchantId={merchantId} />
            </OwnerOnly>
          )}
        </WithAccount>
      );
    case 'payout':
      return (
        <WithAccount {...acct}>
          {({ merchantId, role, record }) => (
            <OwnerOnly role={role}>
              <PayoutDetailPage portal={portal} merchantId={merchantId} payoutId={route.param!} role={role} merchant={record} />
            </OwnerOnly>
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

/**
 * The payment and settlement reads answer only the account owner for now, so every other role would meet a refusal.
 * They are told so up front. A role we could not read is let through: the service decides.
 */
export function OwnerOnly({ role, children }: { role: MemberRole | null; children: ReactNode }) {
  const { t } = portalCopy.useCopy();
  if (role === null || role === 'owner') return <>{children}</>;
  return <EmptyState title={t('ownerOnlyTitle')}>{t('ownerOnlyBody')}</EmptyState>;
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
              <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/onboarding" />}>
                {t('startSetup')}
              </Button>
            }
          >
            {t('noMerchantBody')}
          </EmptyState>
        );
      }}
    </Gate>
  );
}
