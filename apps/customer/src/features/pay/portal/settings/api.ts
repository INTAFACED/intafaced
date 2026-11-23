import { z } from 'zod';
import * as p from '../schemas';
import { type PortalTools } from '../api-tools';
import type { DestinationProof } from '../access/destination-step-up';
import { accountApi } from './account/account-api';
import { applicationApi } from './onboarding/application-api';
import { categoryApi } from './onboarding/category-api';
import { requestsApi } from './onboarding/requests-api';
import {
  PAY_MERCHANT_ONBOARDING_DRAFT,
  PAY_MERCHANT_SAVE_ONBOARDING_DRAFT,
  PAY_MERCHANT_SUBMIT_KYB,
} from '@intafaced/contracts/pay-merchant-procedures';
import {
  PAY_MERCHANT_OPS_ACTIVATION_GET,
  PAY_MERCHANT_OPS_EXPORTS_CREATE,
  PAY_MERCHANT_OPS_TEAM_DECLINE_INVITE,
  PAY_MERCHANT_OPS_KYB_CURRENT,
  PAY_MERCHANT_OPS_TEAM_MY_INVITATIONS,
  PAY_MERCHANT_OPS_TEAM_ACCEPT_INVITE,
  PAY_MERCHANT_OPS_NOTIFICATIONS_UNREAD_COUNT,
  PAY_MERCHANT_OPS_NOTIFICATIONS_PREFERENCES_LIST,
  PAY_MERCHANT_OPS_NOTIFICATIONS_PREFERENCES_SET,
} from '@intafaced/contracts/pay-merchant-ops-procedures';

const baseSettingsApi = ({ query, mutate, list, confirmDestinationStepUp, queryRecord, mutateRecord }: PortalTools) => ({
  /** The names are the merchant's own, stored on the account the service derives from the session (never from this call). */
  createMerchant: (feeBps: number, businessDetails: Record<string, string>, names: { legalName: string; displayName?: string }) =>
    mutate(
      'merchant.create',
      { mode: 'gateway', pricing: { feeBps }, settlementPrefs: { businessDetails }, ...names },
      p.merchantCreatedSchema,
    ),
  /** The business step's draft, kept by svc-pay for the signed-in person before an account exists (J-merchant-02 #1). */
  onboardingDraft: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_ONBOARDING_DRAFT, undefined, signal),
  /** `seq` rises with each change, so the service keeps the newest; sent keepalive so a save made while leaving lands. */
  saveOnboardingDraft: (fields: p.OnboardingDraftFields, seq: number) =>
    mutateRecord(PAY_MERCHANT_SAVE_ONBOARDING_DRAFT, { fields, seq }, { keepalive: true }),
  submitKyb: (merchantId: string, kybRef: string) => mutateRecord(PAY_MERCHANT_SUBMIT_KYB, { merchantId, kybRef }),
  /** Confirms the destination with the owner's code or passkey, then saves it with that single-use approval. */
  setPayoutDestination: async (merchantId: string, railId: string, kind: string, ref: string, proof: DestinationProof) => {
    const approved = await confirmDestinationStepUp({ merchantId, railId, kind, ref }, proof);
    if (!approved.ok) return approved;
    return mutate(
      'merchant.setPayoutDestination',
      { merchantId, railId, kind, ref, stepUpApprovalId: approved.data.stepUpApprovalId },
      p.destinationSchema,
    );
  },
  kybCurrent: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_KYB_CURRENT, {}, signal),
  activation: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_ACTIVATION_GET, {}, signal),
  kybHistory: (cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantOps.kyb.history', p.kybEventSchema, { ...(cursor ? { cursor } : {}) }, signal),
  teamList: (cursor: string | undefined, status: string, signal?: AbortSignal) =>
    list('merchantOps.team.list', p.memberSchema, { ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) }, signal),
  teamHistory: (cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantOps.team.history', p.teamEventSchema, { ...(cursor ? { cursor } : {}) }, signal),
  myInvitations: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_TEAM_MY_INVITATIONS, {}, signal),
  invite: (input: { userId?: string; email?: string; role: p.TeamRole; label?: string }) =>
    mutate('merchantOps.team.invite', input, p.memberSchema),
  changeRole: (memberId: string, role: p.TeamRole) => mutate('merchantOps.team.changeRole', { memberId, role }, p.memberSchema),
  removeMember: (memberId: string) => mutate('merchantOps.team.remove', { memberId }, p.memberSchema),
  acceptInvite: (memberId: string) => mutateRecord(PAY_MERCHANT_OPS_TEAM_ACCEPT_INVITE, { memberId }),
  permissionCatalogue: (signal?: AbortSignal) => query('merchantOps.permissions.catalogue', {}, p.permissionCatalogueSchema, signal),
  declineInvite: (memberId: string) => mutateRecord(PAY_MERCHANT_OPS_TEAM_DECLINE_INVITE, { memberId }),
  exportsList: (cursor: string | undefined, kind: string, status: string, signal?: AbortSignal) =>
    list(
      'merchantOps.exports.list',
      p.exportJobSchema,
      { ...(cursor ? { cursor } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
      signal,
    ),
  createExport: (input: {
    requestId: string;
    kind: p.ExportKind;
    filters: { from?: string; to?: string; status?: string; assetId?: string };
  }) => mutateRecord(PAY_MERCHANT_OPS_EXPORTS_CREATE, input),
  exportDownload: (jobId: string) => query('merchantOps.exports.download', { jobId }, p.exportDownloadSchema),
  notifications: (cursor: string | undefined, unreadOnly: boolean, kind: string, signal?: AbortSignal) =>
    list(
      'merchantOps.notifications.list',
      p.notificationSchema,
      { ...(cursor ? { cursor } : {}), ...(unreadOnly ? { unreadOnly } : {}), ...(kind ? { kind } : {}) },
      signal,
    ),
  unreadCount: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_NOTIFICATIONS_UNREAD_COUNT, {}, signal),
  markRead: (notificationIds: string[]) => mutate('merchantOps.notifications.markRead', { notificationIds }, p.markedSchema),
  markAllRead: () => mutate('merchantOps.notifications.markAllRead', {}, p.markedSchema),
  preferences: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_OPS_NOTIFICATIONS_PREFERENCES_LIST, {}, signal),
  preferenceHistory: (cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantOps.notifications.preferences.history', p.preferenceChangeSchema, { ...(cursor ? { cursor } : {}) }, signal),
  setPreference: (input: { kind: p.NotificationKind; inApp: boolean; threshold?: string | null }) =>
    mutateRecord(PAY_MERCHANT_OPS_NOTIFICATIONS_PREFERENCES_SET, input),
});

/** The settings client: the shared calls, then the account pages' own (`account/api.ts`) and the business application's. A method name used twice fails `api-registry.test.ts`. */
export const settingsApi = (tools: PortalTools) => ({
  ...baseSettingsApi(tools),
  ...accountApi(tools),
  ...applicationApi(tools),
  ...requestsApi(tools),
  ...categoryApi(tools),
});
