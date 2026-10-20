import { mergeRouters } from '@intafaced/contracts';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { ConversionService } from '../conversion/service.js';
import type { TeamEmailInviteLimit } from '../merchant-ops/team-email.js';
import type { WebhookRetryLimit } from '../merchant-ops/webhooks.js';
import type { ControlService } from '../control/service.js';
import type { FounderAuthority } from '../founder-authority.js';
import type { MetricsRuntime } from '../metrics/index.js';
import type { RegistriesMountDeps } from '../registries/index.js';
import type { CustodyMountDeps } from '../custody/router.js';
import type { WithdrawalReturnMountDeps } from '../withdrawals/returns/router.js';
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
  limits?: WithdrawalLimitsMountDeps;
  custody?: CustodyMountDeps;
  withdrawalReturns?: WithdrawalReturnMountDeps;
  sql?: Sql;
  ledger?: Pick<LedgerClient, 'balances'>;
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
}) {
  const opsDeps = {
    founderAuthority: deps.founderAuthority,
    sql: deps.sql,
    ledger: deps.ledger,
    webhooksAllowLocalHttp: deps.webhooksAllowLocalHttp,
    webhookRetry: deps.webhookRetry,
    teamEmailInvite: deps.teamEmailInvite,
    evidence: deps.evidence,
    invoiceLinks: deps.invoiceLinks,
    disputes: deps.disputes,
  };
  return mergeRouters(
    createMerchantControlRouter(deps.control),
    createMerchantMetricsRouter(deps.metrics),
    createFounderAdminRouter(deps.founderAuthority, {
      metrics: deps.metrics,
      registries: deps.registries,
      limits: deps.limits,
      custody: deps.custody,
      withdrawalReturns: deps.withdrawalReturns,
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
    // W10: b2bRamp.* refuses while pay.b2b_ramp is off, including a direct caller.
    createB2bRampRouter({ founderAuthority: deps.founderAuthority, sql: deps.sql }),
  );
}
export type PayNamespacesRouter = ReturnType<typeof createPayNamespaces>;
