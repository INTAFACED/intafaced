import { z } from 'zod';
import { merchantActivationSchema } from '@intafaced/contracts/merchant-activation';
import * as p from '../schemas';
import { type PortalTools } from '../api-tools';
import type { DestinationProof } from '../access/destination-step-up';
import { accountApi } from './account/account-api';
import { applicationApi } from './onboarding/application-api';
import { categoryApi } from './onboarding/category-api';
import { requestsApi } from './onboarding/requests-api';

const baseSettingsApi = ({ query, mutate, list, confirmDestinationStepUp }: PortalTools) => ({
  /** The names are the merchant's own, stored on the account the service derives from the session (never from this call). */
  createMerchant: (feeBps: number, businessDetails: Record<string, string>, names: { legalName: string; displayName?: string }) =>
    mutate(
      'merchant.create',
      { mode: 'gateway', pricing: { feeBps }, settlementPrefs: { businessDetails }, ...names },
      p.merchantCreatedSchema,
    ),
  submitKyb: (merchantId: string, kybRef: string) => mutate('merchant.submitKyb', { merchantId, kybRef }, p.kybSubmitSchema),
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
  kybCurrent: (signal?: AbortSignal) => query('merchantOps.kyb.current', {}, p.kybCurrentSchema, signal),
  activation: (signal?: AbortSignal) => query('merchantOps.activation.get', {}, merchantActivationSchema, signal),
  kybHistory: (cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantOps.kyb.history', p.kybEventSchema, { ...(cursor ? { cursor } : {}) }, signal),
  teamList: (cursor: string | undefined, status: string, signal?: AbortSignal) =>
    list('merchantOps.team.list', p.memberSchema, { ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) }, signal),
  teamHistory: (cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantOps.team.history', p.teamEventSchema, { ...(cursor ? { cursor } : {}) }, signal),
  myInvitations: (signal?: AbortSignal) => query('merchantOps.team.myInvitations', {}, p.invitationSchema, signal),
  invite: (input: { userId?: string; email?: string; role: p.TeamRole; label?: string }) =>
    mutate('merchantOps.team.invite', input, p.memberSchema),
  changeRole: (memberId: string, role: p.TeamRole) => mutate('merchantOps.team.changeRole', { memberId, role }, p.memberSchema),
  removeMember: (memberId: string) => mutate('merchantOps.team.remove', { memberId }, p.memberSchema),
  acceptInvite: (memberId: string) => mutate('merchantOps.team.acceptInvite', { memberId }, p.memberSchema),
  permissionCatalogue: (signal?: AbortSignal) => query('merchantOps.permissions.catalogue', {}, p.permissionCatalogueSchema, signal),
  declineInvite: (memberId: string) => mutate('merchantOps.team.declineInvite', { memberId }, z.object({ declined: z.literal(true) })),
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
  }) => mutate('merchantOps.exports.create', input, p.exportJobSchema),
  exportDownload: (jobId: string) => query('merchantOps.exports.download', { jobId }, p.exportDownloadSchema),
  notifications: (cursor: string | undefined, unreadOnly: boolean, kind: string, signal?: AbortSignal) =>
    list(
      'merchantOps.notifications.list',
      p.notificationSchema,
      { ...(cursor ? { cursor } : {}), ...(unreadOnly ? { unreadOnly } : {}), ...(kind ? { kind } : {}) },
      signal,
    ),
  unreadCount: (signal?: AbortSignal) => query('merchantOps.notifications.unreadCount', {}, p.unreadSchema, signal),
  markRead: (notificationIds: string[]) => mutate('merchantOps.notifications.markRead', { notificationIds }, p.markedSchema),
  markAllRead: () => mutate('merchantOps.notifications.markAllRead', {}, p.markedSchema),
  preferences: (signal?: AbortSignal) => query('merchantOps.notifications.preferences.list', {}, z.array(p.preferenceSchema), signal),
  preferenceHistory: (cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantOps.notifications.preferences.history', p.preferenceChangeSchema, { ...(cursor ? { cursor } : {}) }, signal),
  setPreference: (input: { kind: p.NotificationKind; inApp: boolean; threshold?: string | null }) =>
    mutate('merchantOps.notifications.preferences.set', input, p.preferenceSchema),
});

/** The settings client: the shared calls, then the account pages' own (`account/api.ts`) and the business application's. A method name used twice fails `api-registry.test.ts`. */
export const settingsApi = (tools: PortalTools) => ({
  ...baseSettingsApi(tools),
  ...accountApi(tools),
  ...applicationApi(tools),
  ...requestsApi(tools),
  ...categoryApi(tools),
});
