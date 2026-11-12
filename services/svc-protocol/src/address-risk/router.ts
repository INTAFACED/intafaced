import { publicJurisdictionProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  protocolComplianceLabelApproveInputSchema,
  protocolComplianceLabelAskInputSchema,
  protocolComplianceReportsOutputSchema,
  protocolComplianceReviewSchema,
  protocolAddressReportInputSchema,
  protocolAddressReportReceiptSchema,
  protocolAddressRiskInputSchema,
  protocolAddressRiskSchema,
} from '@intafaced/contracts/protocol-address-risk';
import { approveLabel, askLabel, ComplianceRefusedError, readQueue, type ComplianceStore } from './compliance.js';
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
  now: () => Date;
}

function complianceTrpc(err: unknown): TRPCError {
  if (err instanceof ComplianceRefusedError)
    return new TRPCError({
      code: err.code.endsWith('_unknown') ? 'NOT_FOUND' : 'CONFLICT',
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
  });
}
