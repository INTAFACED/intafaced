import { mergeRouters } from '@intafaced/contracts';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { ConversionService } from '../conversion/service.js';
import type { ReceiptAssetPlaces } from '../merchant-ops/receipt-branding.js';
import type { TeamEmailInviteLimit } from '../merchant-ops/team-email.js';
import type { WebhookRetryLimit } from '../merchant-ops/webhooks.js';
import type { ControlService } from '../control/service.js';
import type { FounderAuthority } from '../founder-authority.js';
import type { MetricsRuntime } from '../metrics/index.js';
import type { RegistriesMountDeps } from '../registries/index.js';
import type { CategoryPolicyMountDeps } from '../onboarding-policy/category-router.js';
import { createMerchantCatalogRouter, type CatalogMountDeps } from '../catalog/router.js';
import { createCheckoutBrandingRouter, type CheckoutBrandingMountDeps } from '../checkout-branding/router.js';
import { createCheckoutMethodsRouter, type CheckoutMethodsMountDeps } from '../checkout-methods/router.js';
import type { DepositSettingsMountDeps } from '../custody/deposits/settings.js';
import type { DepositFreezesMountDeps } from '../custody/deposits/freezes.js';
import type { DepositTravelRuleMountDeps } from '../custody/deposits/travel-rule.js';
import type { CustodyMountDeps } from '../custody/router.js';
import type { PurchaseHoldMountDeps } from '../withdrawals/purchase-holds/router.js';
import type { WithdrawalQuoteMountDeps } from '../withdrawals/quotes/router.js';
import type { WithdrawalNetworkRulesMountDeps } from '../withdrawals/network-rules/service.js';
import type { TravelRuleMountDeps } from '../travel-rule/router.js';
import type { WithdrawalReturnMountDeps } from '../withdrawals/returns/router.js';
import type { WithdrawalApprovalMountDeps } from '../withdrawals/approvals/router.js';
import type { AllowlistMountDeps } from '../withdrawals/allowlist/router.js';
import type { WithdrawalLimitsMountDeps } from '../limits/change-router.js';
import type { DisputeEvidenceGate } from '../merchant-ops/dispute-evidence-policy.js';
import type { DisputeCaseStore } from '../fraud/dispute-case.js';
import type { InvoiceLinkPort } from '../merchant-ops/invoices.js';
import type { PayService } from '../payment-service.js';
import type { MerchantStarterFee } from '../starter-fee.js';
import { createFounderOpsRouter, createMerchantOpsRouter } from '../merchant-ops/index.js';
import { createConversionRouter } from './conversion.js';
import { createFounderAdminRouter, type FounderTreasuryDeps } from './founder-admin.js';
import { createMerchantControlRouter } from './merchant-control.js';
import { createMerchantMetricsRouter } from './merchant-metrics.js';
import { createPayHaltsRouter, type PayHaltsDeps } from './pay-halts.js';
import { createB2bRampRouter } from '../b2b-ramp/router.js';
import { createCustomerEmailNamespaceRouter } from '../customer-emails/router.js';

export { findUnguardedFounderProcedures, founderProcedure, isFounderGuarded } from './founder-procedure.js';
export { notBuilt, PayNotBuiltError } from './errors.js';

/**
 * Path prefixes that must sit behind founder authority (checked by the static inventory test).
 * `b2bRamp.founderStatus` is founder-only. The isolation suite's live founder
 * sweep includes it and expects `pay.b2b_ramp_off` while the ramp flag is off.
 */
export const FOUNDER_ONLY_PREFIXES = [
  'founderAdmin.',
  'payHalts.set',
  'payHalts.history',
  'payHalts.operatorStatus',
  'payHalts.pendingClears',
  'b2bRamp.founderStatus',
] as const;

/**
 * W0 namespaces, mounted as stubs. Each file below is owned by one stream, which
 * replaces the stub bodies there and nowhere else:
 *   merchantControl W1 · merchantMetrics W2 · founderAdmin W2/W4 · conversion W6 · payHalts W5
 *   b2bRamp W10 (switched off; routes refuse until the flag is on)
 */
export function createPayNamespaces(deps: {
  founderAuthority: FounderAuthority;
  metrics?: MetricsRuntime;
  registries?: RegistriesMountDeps;
  categoryPolicy?: CategoryPolicyMountDeps;
  /** The product catalogue (M-catalogue-01). Absent: every merchantCatalog procedure refuses. */
  catalog?: CatalogMountDeps;
  checkoutBranding?: CheckoutBrandingMountDeps;
  /** The hosted checkout's payment methods (M-adv-payments-core-11). Absent: every merchantCheckoutMethods procedure refuses. */
  checkoutMethods?: CheckoutMethodsMountDeps;
  depositSettings?: DepositSettingsMountDeps;
  depositFreezes?: DepositFreezesMountDeps;
  depositTravelRule?: DepositTravelRuleMountDeps;
  limits?: WithdrawalLimitsMountDeps;
  custody?: CustodyMountDeps;
  purchaseHolds?: PurchaseHoldMountDeps;
  withdrawalQuotes?: WithdrawalQuoteMountDeps;
  withdrawalNetworkRules?: WithdrawalNetworkRulesMountDeps;
  travelRule?: TravelRuleMountDeps;
  withdrawalReturns?: WithdrawalReturnMountDeps;
  withdrawalApprovals?: WithdrawalApprovalMountDeps;
  allowlist?: AllowlistMountDeps;
  sql?: Sql;
  ledger?: Pick<LedgerClient, 'balances'>;
  /** Chargeback transactions by key for merchantOps.disputes.funds (M-disp-01). Absent: that read refuses. */
  disputeFundsLedger?: Pick<LedgerClient, 'getTxByKey'>;
  webhooksAllowLocalHttp?: boolean;
  webhookRetry?: WebhookRetryLimit;
  teamEmailInvite?: TeamEmailInviteLimit;
  payHalts?: PayHaltsDeps;
  treasury?: FounderTreasuryDeps;
  control?: ControlService;
  conversion?: ConversionService;
  evidence?: DisputeEvidenceGate;
  invoiceLinks?: InvoiceLinkPort;
  /** Production passes the Postgres dispute store. Omitted keeps the memory store. */
  disputes?: DisputeCaseStore;
  /** Payment, refund, settlement and link lists for founder drill-down. */
  pay?: PayService;
  /** Published local-test starter fee, the same value `merchant.me` returns. Omitted means it is not set. */
  starterFee?: MerchantStarterFee | null;
  /**
   * Published decimal places for a receipt preview. Absent, or a null answer,
   * refuses `ledger.asset_precision_unset`. No place count is invented here.
   */
  receiptPlaces?: ReceiptAssetPlaces;
}) {
  const opsDeps = {
    founderAuthority: deps.founderAuthority,
    sql: deps.sql,
    ledger: deps.ledger,
    disputeFundsLedger: deps.disputeFundsLedger,
    webhooksAllowLocalHttp: deps.webhooksAllowLocalHttp,
    webhookRetry: deps.webhookRetry,
    teamEmailInvite: deps.teamEmailInvite,
    evidence: deps.evidence,
    invoiceLinks: deps.invoiceLinks,
    disputes: deps.disputes,
    receiptPlaces: deps.receiptPlaces,
  };
  return mergeRouters(
    createMerchantControlRouter(deps.control),
    createMerchantMetricsRouter(deps.metrics),
    createFounderAdminRouter(deps.founderAuthority, {
      metrics: deps.metrics,
      registries: deps.registries,
      categoryPolicy: deps.categoryPolicy,
      depositSettings: deps.depositSettings,
      depositFreezes: deps.depositFreezes,
      depositTravelRule: deps.depositTravelRule,
      limits: deps.limits,
      custody: deps.custody,
      purchaseHolds: deps.purchaseHolds,
      withdrawalQuotes: deps.withdrawalQuotes,
      withdrawalNetworkRules: deps.withdrawalNetworkRules,
      travelRule: deps.travelRule,
      withdrawalReturns: deps.withdrawalReturns,
      withdrawalApprovals: deps.withdrawalApprovals,
      allowlist: deps.allowlist,
      ops: createFounderOpsRouter(opsDeps),
      treasury: deps.treasury,
      control: deps.control,
      halts: deps.payHalts?.store,
      conversion: deps.conversion,
      sql: deps.sql,
      pay: deps.pay,
      disputes: deps.disputes,
      starterFee: deps.starterFee,
    }),
    createConversionRouter(deps.conversion),
    createPayHaltsRouter(deps.founderAuthority, deps.payHalts),
    createMerchantOpsRouter(opsDeps), // W15: merchantOps.*  (founderAdmin.ops.* is mounted via createFounderAdminRouter above)
    createMerchantCatalogRouter(deps.catalog), // M-catalogue-01: merchantCatalog.*
    createCheckoutBrandingRouter(deps.checkoutBranding), // M-payments-core-08: merchantCheckout.branding.*
    createCheckoutMethodsRouter(deps.checkoutMethods), // M-adv-payments-core-11: merchantCheckoutMethods.*
    // W10: b2bRamp.* refuses while pay.b2b_ramp is off, including a direct caller.
    createB2bRampRouter({ founderAuthority: deps.founderAuthority, sql: deps.sql }),
    // M-plat-org-10: receipt preview and send. Email switches mount on the portal `merchant` router.
    createCustomerEmailNamespaceRouter({ sql: deps.sql }),
  );
}
export type PayNamespacesRouter = ReturnType<typeof createPayNamespaces>;
