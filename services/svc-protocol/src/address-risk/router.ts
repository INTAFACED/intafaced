import { publicJurisdictionProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  protocolComplianceLabelApproveInputSchema,
  protocolComplianceLabelAskInputSchema,
  protocolComplianceReportsOutputSchema,
  protocolComplianceReviewSchema,
  protocolNameTagApproveInputSchema,
  protocolNameTagRequestInputSchema,
  protocolNameTagRequestSchema,
  protocolNameTagsOutputSchema,
  protocolOnboardingApproveInputSchema,
  protocolOnboardingChecklistSchema,
  protocolOnboardingOpenInputSchema,
  protocolOnboardingOutputSchema,
  protocolTierApproveInputSchema,
  protocolTierAskInputSchema,
  protocolTierRemoveInputSchema,
  protocolTokenTierSchema,
  protocolTokenTiersOutputSchema,
  protocolAddressReportInputSchema,
  protocolAddressReportReceiptSchema,
  protocolAddressRiskInputSchema,
  protocolAddressRiskSchema,
} from '@intafaced/contracts/protocol-address-risk';
import { approveLabel, askLabel, ComplianceRefusedError, readQueue, type ComplianceStore } from './compliance.js';
import {
  approveChecklist,
  approveNameTag,
  approveTier,
  askTier,
  openChecklist,
  readChecklists,
  readNameTags,
  readTiers,
  removeTier,
  requestNameTag,
  TrustDeskRefusedError,
  type TrustDeskStore,
} from './trust-desk.js';
import { AddressReportRefusedError, readAddressRisk, REPORT_DUPLICATE, submitReport, type AddressRiskStore } from './risk.js';

/**
 * `addressRisk.read` and `addressReports.submit` (D-developer-compliance-01). The read is public like the rest of this
 * plane and carries a count of open reports, never who filed them. Filing a report needs a signed-in person, whose id is
 * the reporter and part of the business key; it is never taken from the input.
 */
export interface AddressRiskDeps {
  /** Read per call: the chain the service is configured for. */
  chainId: () => number;
  store: AddressRiskStore;
  /** Whether an AML screening list source is connected (`vendor.aml`). None is today, so this is false. */
  screeningLoaded: () => boolean;
}

function toTrpc(err: unknown): TRPCError {
  if (err instanceof AddressReportRefusedError)
    return new TRPCError({
      code: err.code === REPORT_DUPLICATE ? 'CONFLICT' : 'BAD_REQUEST',
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });
}

export function createAddressRiskRouter(deps: AddressRiskDeps) {
  return router({
    read: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolAddressRiskInputSchema)
      .output(protocolAddressRiskSchema)
      .query(async ({ input }) => {
        try {
          return await readAddressRisk(deps.store, {
            chainId: deps.chainId(),
            address: input.address,
            screeningLoaded: deps.screeningLoaded(),
          });
        } catch (err) {
          throw toTrpc(err);
        }
      }),
  });
}

export function createAddressReportsRouter(deps: AddressRiskDeps) {
  return router({
    submit: scopedProcedure('protocol:read', { module: 'protocol', plane: 'protocol' })
      .input(protocolAddressReportInputSchema)
      .output(protocolAddressReportReceiptSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await submitReport(deps.store, { ...input, chainId: deps.chainId(), reporterId: ctx.principal.userId });
        } catch (err) {
          throw toTrpc(err);
        }
      }),
  });
}

/**
 * `compliance.*` (D-developer-compliance-01, J-dex-protocol-30 #1 #2): the operator queue. Reading is `admin:read`;
 * asking for and approving a label is `admin:write`, and the person is always the session's, never the input's. The
 * second reviewer must be a different person (`protocol.compliance.same_reviewer`).
 */
export interface ComplianceDeps {
  chainId: () => number;
  store: ComplianceStore;
  /** Token tiers, name tags and permissioned pool onboarding (J-dex-protocol-30 #4 #7 #9). */
  trustDesk: TrustDeskStore;
  now: () => Date;
}

function complianceTrpc(err: unknown): TRPCError {
  if (err instanceof ComplianceRefusedError || err instanceof TrustDeskRefusedError)
    return new TRPCError({
      code: err.code.endsWith('_unknown') || err.code === 'protocol.onboarding.unknown' ? 'NOT_FOUND' : 'CONFLICT',
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Protocol request failed', cause: err });
}

const operatorGuards = { module: 'protocol', plane: 'protocol' } as const;

export function createComplianceRouter(deps: ComplianceDeps) {
  return router({
    reports: router({
      list: scopedProcedure('admin:read', operatorGuards)
        .output(protocolComplianceReportsOutputSchema)
        .query(async () => {
          try {
            return await readQueue(deps.store, deps.chainId(), deps.now());
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
    }),
    labels: router({
      ask: scopedProcedure('admin:write', operatorGuards)
        .input(protocolComplianceLabelAskInputSchema)
        .output(protocolComplianceReviewSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await askLabel(deps.store, { ...input, chainId: deps.chainId(), requesterId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      approve: scopedProcedure('admin:write', operatorGuards)
        .input(protocolComplianceLabelApproveInputSchema)
        .output(protocolComplianceReviewSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await approveLabel(deps.store, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
    }),
    tiers: router({
      list: scopedProcedure('admin:read', operatorGuards)
        .output(protocolTokenTiersOutputSchema)
        .query(async () => {
          try {
            return await readTiers(deps.trustDesk, deps.chainId(), deps.now());
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      ask: scopedProcedure('admin:write', operatorGuards)
        .input(protocolTierAskInputSchema)
        .output(protocolTokenTierSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await askTier(deps.trustDesk, { ...input, chainId: deps.chainId(), requesterId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      approve: scopedProcedure('admin:write', operatorGuards)
        .input(protocolTierApproveInputSchema)
        .output(protocolTokenTierSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await approveTier(deps.trustDesk, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      remove: scopedProcedure('admin:write', operatorGuards)
        .input(protocolTierRemoveInputSchema)
        .output(protocolTokenTierSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await removeTier(deps.trustDesk, { ...input, chainId: deps.chainId(), actorId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
    }),
    onboarding: router({
      list: scopedProcedure('admin:read', operatorGuards)
        .output(protocolOnboardingOutputSchema)
        .query(async () => {
          try {
            return await readChecklists(deps.trustDesk, deps.chainId(), deps.now());
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      open: scopedProcedure('admin:write', operatorGuards)
        .input(protocolOnboardingOpenInputSchema)
        .output(protocolOnboardingChecklistSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await openChecklist(deps.trustDesk, { ...input, chainId: deps.chainId(), openedBy: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      approve: scopedProcedure('admin:write', operatorGuards)
        .input(protocolOnboardingApproveInputSchema)
        .output(protocolOnboardingChecklistSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await approveChecklist(deps.trustDesk, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
    }),
    nameTags: router({
      list: scopedProcedure('admin:read', operatorGuards)
        .output(protocolNameTagsOutputSchema)
        .query(async () => {
          try {
            return await readNameTags(deps.trustDesk, deps.chainId(), deps.now());
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      request: scopedProcedure('admin:write', operatorGuards)
        .input(protocolNameTagRequestInputSchema)
        .output(protocolNameTagRequestSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await requestNameTag(deps.trustDesk, { ...input, chainId: deps.chainId(), requesterId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
      approve: scopedProcedure('admin:write', operatorGuards)
        .input(protocolNameTagApproveInputSchema)
        .output(protocolNameTagRequestSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await approveNameTag(deps.trustDesk, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
          } catch (err) {
            throw complianceTrpc(err);
          }
        }),
    }),
  });
}
