import type { ProcedureInput } from '@intafaced/contracts/procedure';
import { type PortalTools } from '../../api-tools';
import * as s from './schemas';
import './refusals';
import { portalRefusal } from '../../refusal';
import { areaSchema } from '@intafaced/contracts/pay-call-schemas';
import {
  PAY_SUBMERCHANT_CREATE,
  PAY_SUBMERCHANT_SUMMARY,
  PAY_SUBMERCHANT_LIST,
  PAY_SUBMERCHANT_GET,
} from '@intafaced/contracts/pay-submerchant-procedures';
import {
  PAY_SUBMERCHANT_PERMISSION_AREAS,
  PAY_SUBMERCHANT_PERMISSION_LIST,
  PAY_SUBMERCHANT_PERMISSION_HISTORY,
  PAY_SUBMERCHANT_PERMISSION_GRANT,
  PAY_SUBMERCHANT_PERMISSION_REVOKE,
} from '@intafaced/contracts/pay-submerchant-permission-procedures';
import {
  PAY_MERCHANT_BUSINESS_PROFILE_GET,
  PAY_MERCHANT_TERMS_ACCEPT,
  PAY_MERCHANT_ONBOARDING_PROGRESS,
  PAY_MERCHANT_BUSINESS_PROFILE_HISTORY,
  PAY_MERCHANT_BUSINESS_PROFILE_CONFIRM,
  PAY_MERCHANT_BUSINESS_PROFILE_SET_SECOND_APPROVAL,
} from '@intafaced/contracts/pay-merchant-procedures';
import { PAY_MERCHANT_OPS_ACTIVITY_LIST, PAY_MERCHANT_OPS_TEAM_LIST } from '@intafaced/contracts/pay-merchant-ops-procedures';

const cursorPart = (cursor: string | undefined) => (cursor ? { cursor } : {});

/**
 * The calls the account pages make that no shared client has: the business profile, setup progress, the activity
 * feed, the filtered team list and the platform network. The business is always passed by the page from the
 * resolved access; the service checks it against the signed session again.
 */
type TeamListInput = ProcedureInput<typeof PAY_MERCHANT_OPS_TEAM_LIST>;

type PermissionChange = { granteeMerchantId: string; subjectMerchantId: string; area: string; reason: string };

export const accountApi = ({ mutate, mutateRecord, queryRecord, listRecord }: PortalTools) => {
  /** A grant or revoke, sent only for an area the service lists: any other is refused here, as the service would. */
  const permissionChange = async (
    record: typeof PAY_SUBMERCHANT_PERMISSION_GRANT | typeof PAY_SUBMERCHANT_PERMISSION_REVOKE,
    input: PermissionChange,
  ) => {
    const area = areaSchema.safeParse(input.area);
    return area.success ? mutateRecord(record, { ...input, area: area.data }) : portalRefusal('rGeneric');
  };
  return {
    // ---- business profile (merchant.businessProfile.*) ----
    profileGet: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_BUSINESS_PROFILE_GET, { merchantId }, signal),
    profileHistory: (merchantId: string, cursor: string | undefined, signal?: AbortSignal) =>
      queryRecord(PAY_MERCHANT_BUSINESS_PROFILE_HISTORY, { merchantId, limit: 25, ...cursorPart(cursor) }, signal),
    profileSubmit: (input: { merchantId: string; expectedVersion: string; reason: string } & Partial<s.ProfileFields>) =>
      mutate('merchant.businessProfile.submit', input, s.profileSubmitResultSchema),
    profileConfirm: (input: {
      merchantId: string;
      requestId: string;
      decision: 'confirm' | 'reject' | 'withdraw';
      expectedChangeHash: string;
      reason: string;
    }) => mutateRecord(PAY_MERCHANT_BUSINESS_PROFILE_CONFIRM, input),
    termsAccept: (merchantId: string, version: string) => mutateRecord(PAY_MERCHANT_TERMS_ACCEPT, { merchantId, version }),
    profileSecondApproval: (merchantId: string, enabled: boolean) =>
      mutateRecord(PAY_MERCHANT_BUSINESS_PROFILE_SET_SECOND_APPROVAL, { merchantId, enabled }),
    onboardingProgress: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_ONBOARDING_PROGRESS, { merchantId }, signal),

    // ---- team, with the filters the service now applies ----
    teamPage: (cursor: string | undefined, filters: { status?: string; role?: string; search?: string }, signal?: AbortSignal) =>
      listRecord(
        PAY_MERCHANT_OPS_TEAM_LIST,
        {
          ...cursorPart(cursor),
          // The page's filter text is sent as before; the service checks it against its own lists and refuses any other.
          ...(filters.status ? { status: filters.status as TeamListInput['status'] } : {}),
          ...(filters.role ? { role: filters.role as TeamListInput['role'] } : {}),
          ...(filters.search ? { search: filters.search } : {}),
        },
        signal,
      ),

    // ---- activity ----
    activityList: (
      cursor: string | undefined,
      filters: { objectType?: string; action?: string; actorId?: string; from?: string; to?: string; search?: string },
      signal?: AbortSignal,
    ) =>
      listRecord(
        PAY_MERCHANT_OPS_ACTIVITY_LIST,
        {
          ...cursorPart(cursor),
          ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        },
        signal,
      ),

    // ---- network ----
    subList: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_SUBMERCHANT_LIST, { merchantId, limit: 100 }, signal),
    subGet: (merchantId: string, signal?: AbortSignal) => queryRecord(PAY_SUBMERCHANT_GET, { merchantId }, signal),
    subSummary: (merchantId: string, signal?: AbortSignal) =>
      queryRecord(PAY_SUBMERCHANT_SUMMARY, { merchantId, recentPaymentsLimit: 10, grantsLimit: 50 }, signal),
    subCreate: (input: { parentMerchantId: string; userId: string; feeBps: number }) =>
      mutateRecord(PAY_SUBMERCHANT_CREATE, {
        parentMerchantId: input.parentMerchantId,
        userId: input.userId,
        pricing: { feeBps: input.feeBps },
      }),
    permAreas: (signal?: AbortSignal) => queryRecord(PAY_SUBMERCHANT_PERMISSION_AREAS, undefined, signal),
    permGrants: (subjectMerchantId: string, signal?: AbortSignal) =>
      queryRecord(PAY_SUBMERCHANT_PERMISSION_LIST, { subjectMerchantId, limit: 50 }, signal),
    permHistory: (subjectMerchantId: string, signal?: AbortSignal) =>
      queryRecord(PAY_SUBMERCHANT_PERMISSION_HISTORY, { subjectMerchantId, limit: 50 }, signal),
    permGrant: (input: PermissionChange) => permissionChange(PAY_SUBMERCHANT_PERMISSION_GRANT, input),
    permRevoke: (input: PermissionChange) => permissionChange(PAY_SUBMERCHANT_PERMISSION_REVOKE, input),
  };
};
