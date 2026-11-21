import { router, TRPCError } from '@intafaced/contracts';
import {
  PROTOCOL_ADDRESS_REPORTS_SUBMIT,
  PROTOCOL_ADDRESS_RISK_READ,
  PROTOCOL_COMPLIANCE_BLOCKLIST_ADD,
  PROTOCOL_COMPLIANCE_BLOCKLIST_LIST,
  PROTOCOL_COMPLIANCE_LABELS_APPROVE,
  PROTOCOL_COMPLIANCE_LABELS_ASK,
  PROTOCOL_COMPLIANCE_NAME_TAGS_APPROVE,
  PROTOCOL_COMPLIANCE_NAME_TAGS_LIST,
  PROTOCOL_COMPLIANCE_NAME_TAGS_REQUEST,
  PROTOCOL_COMPLIANCE_ONBOARDING_APPROVE,
  PROTOCOL_COMPLIANCE_ONBOARDING_LIST,
  PROTOCOL_COMPLIANCE_ONBOARDING_OPEN,
  PROTOCOL_COMPLIANCE_REPORTS_LIST,
  PROTOCOL_COMPLIANCE_TIERS_APPROVE,
  PROTOCOL_COMPLIANCE_TIERS_ASK,
  PROTOCOL_COMPLIANCE_TIERS_LIST,
  PROTOCOL_COMPLIANCE_TIERS_REMOVE,
} from '@intafaced/contracts/protocol-wallet-procedures';
import { mountProtocolRecord } from '../record-mount.js';
import { approveLabel, askLabel, ComplianceRefusedError, readQueue, type ComplianceStore } from './compliance.js';
import {
  addToBlocklist,
  approveChecklist,
  approveNameTag,
  approveTier,
  askTier,
  openChecklist,
  readBlocklist,
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
    read: mountProtocolRecord(PROTOCOL_ADDRESS_RISK_READ, async ({ input }) => {
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
    submit: mountProtocolRecord(PROTOCOL_ADDRESS_REPORTS_SUBMIT, async ({ ctx, input }) => {
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
  /** Token tiers, the blocklist, name tags and permissioned pool onboarding (J-dex-protocol-30 #4 #6 #7 #9). */
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

export function createComplianceRouter(deps: ComplianceDeps) {
  return router({
    reports: router({
      list: mountProtocolRecord(PROTOCOL_COMPLIANCE_REPORTS_LIST, async () => {
        try {
          return await readQueue(deps.store, deps.chainId(), deps.now());
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
    }),
    labels: router({
      ask: mountProtocolRecord(PROTOCOL_COMPLIANCE_LABELS_ASK, async ({ ctx, input }) => {
        try {
          return await askLabel(deps.store, { ...input, chainId: deps.chainId(), requesterId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      approve: mountProtocolRecord(PROTOCOL_COMPLIANCE_LABELS_APPROVE, async ({ ctx, input }) => {
        try {
          return await approveLabel(deps.store, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
    }),
    tiers: router({
      list: mountProtocolRecord(PROTOCOL_COMPLIANCE_TIERS_LIST, async () => {
        try {
          return await readTiers(deps.trustDesk, deps.chainId(), deps.now());
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      ask: mountProtocolRecord(PROTOCOL_COMPLIANCE_TIERS_ASK, async ({ ctx, input }) => {
        try {
          return await askTier(deps.trustDesk, { ...input, chainId: deps.chainId(), requesterId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      approve: mountProtocolRecord(PROTOCOL_COMPLIANCE_TIERS_APPROVE, async ({ ctx, input }) => {
        try {
          return await approveTier(deps.trustDesk, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      remove: mountProtocolRecord(PROTOCOL_COMPLIANCE_TIERS_REMOVE, async ({ ctx, input }) => {
        try {
          return await removeTier(deps.trustDesk, { ...input, chainId: deps.chainId(), actorId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
    }),
    onboarding: router({
      list: mountProtocolRecord(PROTOCOL_COMPLIANCE_ONBOARDING_LIST, async () => {
        try {
          return await readChecklists(deps.trustDesk, deps.chainId(), deps.now());
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      open: mountProtocolRecord(PROTOCOL_COMPLIANCE_ONBOARDING_OPEN, async ({ ctx, input }) => {
        try {
          return await openChecklist(deps.trustDesk, { ...input, chainId: deps.chainId(), openedBy: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      approve: mountProtocolRecord(PROTOCOL_COMPLIANCE_ONBOARDING_APPROVE, async ({ ctx, input }) => {
        try {
          return await approveChecklist(deps.trustDesk, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
    }),
    blocklist: router({
      list: mountProtocolRecord(PROTOCOL_COMPLIANCE_BLOCKLIST_LIST, async () => {
        try {
          return await readBlocklist(deps.trustDesk, deps.chainId(), deps.now());
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      add: mountProtocolRecord(PROTOCOL_COMPLIANCE_BLOCKLIST_ADD, async ({ ctx, input }) => {
        try {
          return await addToBlocklist(deps.trustDesk, { ...input, chainId: deps.chainId(), actorId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
    }),
    nameTags: router({
      list: mountProtocolRecord(PROTOCOL_COMPLIANCE_NAME_TAGS_LIST, async () => {
        try {
          return await readNameTags(deps.trustDesk, deps.chainId(), deps.now());
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      request: mountProtocolRecord(PROTOCOL_COMPLIANCE_NAME_TAGS_REQUEST, async ({ ctx, input }) => {
        try {
          return await requestNameTag(deps.trustDesk, { ...input, chainId: deps.chainId(), requesterId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
      approve: mountProtocolRecord(PROTOCOL_COMPLIANCE_NAME_TAGS_APPROVE, async ({ ctx, input }) => {
        try {
          return await approveNameTag(deps.trustDesk, { ...input, chainId: deps.chainId(), approverId: ctx.principal.userId });
        } catch (err) {
          throw complianceTrpc(err);
        }
      }),
    }),
  });
}
